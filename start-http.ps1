# Windows Developer Bridge - HTTP + OAuth 服务启动脚本
# 用法: powershell -ExecutionPolicy Bypass -File .\start-http.ps1
#
# Cloudflare Quick Tunnel 场景：
#   1) 先运行 start-tunnel.ps1，拿到 https://<随机名>.trycloudflare.com
#   2) 在 .env.http 中写一行 WDB_HTTP_PUBLIC_URL=https://<随机名>.trycloudflare.com
#   3) 再运行本脚本（OAuth 元数据的 issuer 必须与客户端访问的 URL 一致）

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvFile = Join-Path $Root ".env.http"

# 读取 .env.http 中的所有 KEY=VALUE（token 首次运行自动生成）
if (Test-Path $EnvFile) {
    Get-Content $EnvFile | Where-Object { $_ -match '^\s*[A-Za-z_][A-Za-z0-9_]*=' } | ForEach-Object {
        $k, $v = $_ -split '=', 2
        Set-Item -Path "Env:$($k.Trim())" -Value $v.Trim()
    }
}
if (-not $env:WDB_HTTP_TOKEN -and -not $env:WDB_OAUTH_ONLY) {
    # 保留静态 Bearer Token 作为可选管理通道（脚本自起隧道时建议保留）
    $env:WDB_HTTP_TOKEN = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
    Add-Content -Path $EnvFile -Encoding ascii -Value "WDB_HTTP_TOKEN=$env:WDB_HTTP_TOKEN"
    Write-Host "已生成新静态 token 并保存到 $EnvFile" -ForegroundColor Green
}
if (-not $env:WDB_HTTP_PORT) { $env:WDB_HTTP_PORT = "8787" }
if (-not $env:WDB_HTTP_HOST) { $env:WDB_HTTP_HOST = "127.0.0.1" }

Write-Host "本地端点 : http://$($env:WDB_HTTP_HOST):$($env:WDB_HTTP_PORT)/mcp" -ForegroundColor Cyan
if ($env:WDB_HTTP_PUBLIC_URL) {
    Write-Host "公网基址 : $env:WDB_HTTP_PUBLIC_URL (OAuth issuer)" -ForegroundColor Cyan
} else {
    Write-Host "未设置 WDB_HTTP_PUBLIC_URL，OAuth issuer 为本地地址（远程客户端将无法完成授权）" -ForegroundColor Yellow
}
Write-Host "OAuth 发现: <基址>/.well-known/oauth-authorization-server" -ForegroundColor DarkGray
Write-Host "按 Ctrl+C 停止服务，操作员授权 PIN 见下方输出（同时保存在数据目录 oauth\consent.pin）" -ForegroundColor DarkGray

node (Join-Path $Root "mcp-http.mjs")
