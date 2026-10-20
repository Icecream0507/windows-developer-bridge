#!/usr/bin/env bash
# 在你自己的 Linux 服务器上给 Windows Developer Bridge 配一个固定的 HTTPS 地址：
#
#   ChatGPT → https://<域名>:<公网端口> → nginx 容器（复用服务器上已有的 Let's Encrypt 证书）
#           → 127.0.0.1:<隧道端口> → SSH 反向隧道 → Windows 上的 wdb
#
# 一般不用手动运行：在 Windows 上执行 `wdb tunnel setup <ssh主机> <域名>` 会自动上传并运行它。
# 手动用法：sudo bash setup-wdb-proxy.sh <域名> [公网端口=8443] [隧道端口=18787]
# 需要：Docker；/etc/letsencrypt/live/<域名>/ 下已有证书（certbot 申请的）。
# 不会改动服务器上已有的网站和 nginx 配置：反代是一个单独的容器，只监听你指定的端口。
set -euo pipefail

DOMAIN="${1:-}"
PUBLIC_PORT="${2:-8443}"
UPSTREAM_PORT="${3:-18787}"

die() { echo "[X] $*" >&2; exit 1; }
ok() { echo "[OK] $*"; }

[[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || die "用法: sudo bash $0 <域名> [公网端口=8443] [隧道端口=18787]"
[[ "$PUBLIC_PORT" =~ ^[0-9]+$ && "$UPSTREAM_PORT" =~ ^[0-9]+$ ]] || die "端口必须是数字"
[[ $EUID -eq 0 ]] || die "需要 root 权限：sudo bash $0 $*"
command -v docker >/dev/null || die "未安装 Docker（Ubuntu/Debian: apt install -y docker.io）"

LIVE="/etc/letsencrypt/live/$DOMAIN"
ARCHIVE="/etc/letsencrypt/archive/$DOMAIN"
[[ -f "$LIVE/fullchain.pem" && -f "$LIVE/privkey.pem" ]] || die "找不到 $DOMAIN 的证书（$LIVE）。先用 certbot 申请，例如: certbot certonly --webroot -w <网站根目录> -d $DOMAIN"

# 先取完整输出再匹配：pipefail 下 `cmd | grep -q` 可能因 SIGPIPE 误判
if [[ "$(sshd -T 2>/dev/null || true)" =~ (^|$'\n')allowtcpforwarding\ no ]]; then
  die "sshd 禁止了端口转发（AllowTcpForwarding no），SSH 反向隧道无法工作"
fi

NAME="wdb-proxy-$PUBLIC_PORT"
CONF_DIR="/etc/wdb-proxy"
CONF="$CONF_DIR/$NAME.conf"

# 重新配置时先移除自己的旧容器；端口被别的程序占用就停下，别把现有服务挤掉
docker rm -f "$NAME" >/dev/null 2>&1 || true
if [[ -n "$(ss -ltnH "sport = :$PUBLIC_PORT")" ]]; then
  die "端口 $PUBLIC_PORT 已被其他程序占用：$(ss -ltnpH "sport = :$PUBLIC_PORT" | head -1)。换一个端口：wdb tunnel setup <主机> $DOMAIN --port <端口>"
fi

LISTEN6=""
[[ -f /proc/net/if_inet6 ]] && LISTEN6="listen [::]:$PUBLIC_PORT ssl;"

mkdir -p "$CONF_DIR"
cat > "$CONF" <<EOF
# 由 setup-wdb-proxy.sh 生成：https://$DOMAIN:$PUBLIC_PORT -> 127.0.0.1:$UPSTREAM_PORT（Windows Developer Bridge SSH 隧道）
worker_processes 1;
error_log /dev/stderr warn;
events { worker_connections 512; }
http {
  server_tokens off;
  log_format wdb '\$time_iso8601 \$remote_addr "\$request_method \$uri" \$status \${request_time}s';
  access_log /dev/stdout wdb;
  server {
    listen $PUBLIC_PORT ssl;
    $LISTEN6
    server_name $DOMAIN;
    ssl_certificate $LIVE/fullchain.pem;
    ssl_certificate_key $LIVE/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:wdb:1m;
    client_max_body_size 64m;
    location / {
      proxy_pass http://127.0.0.1:$UPSTREAM_PORT;
      proxy_http_version 1.1;
      proxy_set_header Connection "";
      proxy_set_header Host \$http_host;
      proxy_set_header X-Forwarded-Host \$http_host;
      proxy_set_header X-Forwarded-Proto https;
      proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
      # 工具调用以 SSE 流式返回心跳，不能缓冲；单次调用最长 30 分钟
      proxy_buffering off;
      proxy_request_buffering off;
      proxy_read_timeout 1900s;
      proxy_send_timeout 1900s;
      proxy_connect_timeout 5s;
      error_page 502 504 = @offline;
    }
    location @offline {
      default_type application/json;
      return 503 '{"error":"Windows Developer Bridge is offline: the SSH tunnel from the Windows PC is not connected (run wdb start / wdb status on the PC)."}';
    }
  }
}
EOF

docker image inspect nginx:alpine >/dev/null 2>&1 || docker pull nginx:alpine >/dev/null
# host 网络：直接访问宿主机 127.0.0.1 上的隧道端口。只挂载这一个域名的证书目录（live 里是指向 archive 的相对链接）
docker run -d --name "$NAME" --restart unless-stopped --network host \
  -v "$CONF:/etc/nginx/nginx.conf:ro" \
  -v "$LIVE:$LIVE:ro" \
  -v "$ARCHIVE:$ARCHIVE:ro" \
  nginx:alpine >/dev/null

code=000
for _ in $(seq 1 20); do
  sleep 0.5
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 --resolve "$DOMAIN:$PUBLIC_PORT:127.0.0.1" "https://$DOMAIN:$PUBLIC_PORT/healthz" || true)
  [[ "$code" == 200 || "$code" == 503 ]] && break
done
if [[ "$code" != 200 && "$code" != 503 ]]; then
  docker logs --tail 20 "$NAME" >&2 || true
  die "反代没有正常启动（HTTP $code）"
fi
ok "HTTPS 反代已运行：容器 $NAME，https://$DOMAIN:$PUBLIC_PORT -> 127.0.0.1:$UPSTREAM_PORT"
[[ "$code" == 200 ]] && ok "Windows 端隧道已接入" || echo "    （Windows 端隧道还没接入，wdb start 后即可访问）"

# sshd 默认不探测掉线的客户端：Windows 断网/睡眠后，旧会话要等 TCP 超时（约 2 小时）才释放隧道端口，
# 期间重连会失败。没配置过 ClientAliveInterval 时开启它：15 秒探测一次，45 秒无响应就断开（只影响已断线的连接）。
SSHD_DROPIN=/etc/ssh/sshd_config.d/00-wdb-tunnel.conf
if [[ "$(sshd -T 2>/dev/null || true)" =~ (^|$'\n')clientaliveinterval\ 0($'\n'|$) ]] && grep -qiE '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/' /etc/ssh/sshd_config; then
  printf '%s\n' "# 由 setup-wdb-proxy.sh 生成：及时清理已断线的 SSH 会话，释放 Windows Developer Bridge 的隧道端口" "ClientAliveInterval 15" "ClientAliveCountMax 3" > "$SSHD_DROPIN"
  if sshd -t; then
    systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
    ok "sshd 已开启断线检测：ClientAliveInterval 15（$SSHD_DROPIN）"
  else
    rm -f "$SSHD_DROPIN"
    echo "[!]  sshd 配置校验失败，已撤销 $SSHD_DROPIN"
  fi
fi

# 证书续期后重新加载，保证一直用最新证书
HOOK=/etc/letsencrypt/renewal-hooks/deploy/wdb-proxy-reload.sh
mkdir -p "$(dirname "$HOOK")"
cat > "$HOOK" <<'EOF'
#!/bin/sh
# 由 setup-wdb-proxy.sh 生成：证书续期后让 wdb-proxy 容器重新加载证书
for c in $(docker ps --format '{{.Names}}' | grep '^wdb-proxy-'); do docker exec "$c" nginx -s reload; done
EOF
chmod +x "$HOOK"
ok "已添加证书续期钩子：$HOOK"

if command -v ufw >/dev/null && [[ "$(ufw status 2>/dev/null || true)" == "Status: active"* ]]; then
  ufw allow "$PUBLIC_PORT/tcp" >/dev/null && ok "ufw 已放行 TCP $PUBLIC_PORT"
fi
if command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port="$PUBLIC_PORT/tcp" >/dev/null && firewall-cmd --reload >/dev/null && ok "firewalld 已放行 TCP $PUBLIC_PORT"
fi
echo "[!]  云服务器的安全组也要放行 TCP $PUBLIC_PORT（腾讯云 / 阿里云：控制台 → 安全组 → 入站规则）"
