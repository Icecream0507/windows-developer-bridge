# Windows Developer Bridge - Cloudflare Quick Tunnel 启动脚本
# 前置条件: 先在另一个终端运行 start-http.ps1
# 用法: powershell -ExecutionPolicy Bypass -File .\start-tunnel.ps1
# 输出中的 https://<随机名>.trycloudflare.com 即公网地址，MCP 端点需追加 /mcp

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Cloudflared = Join-Path $Root "tools\cloudflared.exe"

if (-not (Test-Path $Cloudflared)) {
    Write-Host "未找到 tools\cloudflared.exe，请先下载：" -ForegroundColor Red
    Write-Host "  curl -L -o tools/cloudflared.exe https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
    exit 1
}

$Port = if ($env:WDB_HTTP_PORT) { $env:WDB_HTTP_PORT } else { "8787" }

# 国内网络直连 api.trycloudflare.com 通常超时；若未显式配置代理，自动探测常见本地代理端口
if (-not $env:HTTPS_PROXY) {
    foreach ($p in 7897, 7890, 10809, 10808) {
        $client = New-Object System.Net.Sockets.TcpClient
        try { $client.Connect("127.0.0.1", $p); if ($client.Connected) { $env:HTTPS_PROXY = "http://127.0.0.1:$p"; $env:HTTP_PROXY = $env:HTTPS_PROXY; break } }
        catch { } finally { $client.Close() }
    }
}
if ($env:HTTPS_PROXY) { Write-Host "使用代理: $env:HTTPS_PROXY" -ForegroundColor Yellow }

Write-Host "正在启动 Cloudflare Quick Tunnel -> http://127.0.0.1:$Port" -ForegroundColor Cyan
Write-Host "MCP URL = 输出的 https://<随机名>.trycloudflare.com/mcp" -ForegroundColor Green
# QUIC/UDP 无法走 HTTP 代理，强制 http2
& $Cloudflared tunnel --url "http://127.0.0.1:$Port" --protocol http2 --no-autoupdate
