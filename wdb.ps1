<#
  wdb - Windows Developer Bridge 管理命令
  用法: wdb <命令> [选项]        运行 `wdb help` 查看全部命令
  兼容 Windows PowerShell 5.1 与 PowerShell 7。
#>
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repo = "Icecream0507/windows-developer-bridge"
$AppDir = $PSScriptRoot
$DataDir = if ($env:WDB_DATA_DIR) { $env:WDB_DATA_DIR } else { Join-Path $env:LOCALAPPDATA "WindowsDeveloperBridge" }
$ConfigFile = Join-Path $DataDir "config.env"
$RunDir = Join-Path $DataDir "run"
$LogDir = Join-Path $DataDir "logs"
$StateFile = Join-Path $RunDir "state.json"
$UnlockFile = Join-Path $DataDir "FULL_ACCESS_ENABLED"
$PinFile = Join-Path $DataDir "oauth\consent.pin"
$BinDir = Join-Path $DataDir "bin"

$Command = if ($args.Count -gt 0) { [string]$args[0] } else { "help" }
$Options = if ($args.Count -gt 1) { @($args[1..($args.Count - 1)] | ForEach-Object { [string]$_ }) } else { @() }
function Has-Flag([string]$name) { return [bool]($Options | Where-Object { $_ -ieq "-$name" -or $_ -ieq "--$name" }) }
function Get-Option([string]$name, $default) {
  for ($i = 0; $i -lt $Options.Count - 1; $i++) { if ($Options[$i] -ieq "-$name" -or $Options[$i] -ieq "--$name") { return $Options[$i + 1] } }
  return $default
}

function Info($m) { Write-Host $m }
function Ok($m) { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!]  $m" -ForegroundColor Yellow }
function Bad($m) { Write-Host "  [X]  $m" -ForegroundColor Red }
function Title($m) { Write-Host ""; Write-Host $m -ForegroundColor Cyan }

# ---------- 配置 ----------
function Read-Config {
  $cfg = @{}
  if (Test-Path $ConfigFile) {
    foreach ($line in [IO.File]::ReadAllLines($ConfigFile)) {
      if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') { $cfg[$Matches[1]] = $Matches[2].Trim() }
    }
  }
  return $cfg
}
function Set-ConfigValue([string]$key, [string]$value) {
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  $lines = New-Object System.Collections.Generic.List[string]
  if (Test-Path $ConfigFile) { foreach ($l in [IO.File]::ReadAllLines($ConfigFile)) { if ($l -notmatch "^\s*$key\s*=") { $lines.Add($l) } } }
  if ($null -ne $value -and $value -ne "") { $lines.Add("$key=$value") }
  [IO.File]::WriteAllLines($ConfigFile, $lines, (New-Object System.Text.UTF8Encoding $false))
}
function New-Token {
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return (($bytes | ForEach-Object { $_.ToString("x2") }) -join "")
}
function Ensure-Config {
  $cfg = Read-Config
  if (-not $cfg["WDB_HTTP_TOKEN"]) {
    $legacy = Join-Path $AppDir ".env.http"
    $token = $null
    if (Test-Path $legacy) { foreach ($l in [IO.File]::ReadAllLines($legacy)) { if ($l -match '^\s*WDB_HTTP_TOKEN\s*=(.+)$') { $token = $Matches[1].Trim() } } }
    if (-not $token -or $token.Length -lt 32) { $token = New-Token }
    Set-ConfigValue "WDB_HTTP_TOKEN" $token
  }
  if (-not (Read-Config)["WDB_HTTP_PORT"]) { Set-ConfigValue "WDB_HTTP_PORT" "8787" }
  return Read-Config
}

# ---------- 运行状态 ----------
function Read-State { if (Test-Path $StateFile) { try { return Get-Content $StateFile -Raw | ConvertFrom-Json } catch {} }; return $null }
function Write-State($state) { New-Item -ItemType Directory -Force -Path $RunDir | Out-Null; $state | ConvertTo-Json | Set-Content -Path $StateFile -Encoding UTF8 }
function Test-Pid($procId) { if (-not $procId) { return $false }; return [bool](Get-Process -Id $procId -ErrorAction SilentlyContinue) }
function Test-Health([int]$port) {
  try { $r = Invoke-RestMethod -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 3; return [bool]$r.ok } catch { return $false }
}
function Test-Port([string]$hostName, [int]$port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try { $ar = $client.BeginConnect($hostName, $port, $null, $null); if ($ar.AsyncWaitHandle.WaitOne(300) -and $client.Connected) { return $true }; return $false }
  catch { return $false } finally { $client.Close() }
}
function Get-Node {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { throw "未找到 Node.js（需要 20+）。安装：winget install OpenJS.NodeJS.LTS，然后重新打开终端。" }
  $major = [int]((& $node.Source -p "process.versions.node.split('.')[0]").Trim())
  if ($major -lt 20) { throw "Node.js 版本过低（$major），需要 20+。" }
  return $node.Source
}
function Get-Cloudflared {
  $local = Join-Path $AppDir "tools\cloudflared.exe"
  if (Test-Path $local) { return $local }
  $onPath = Get-Command cloudflared -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  return $null
}
function Find-Proxy($cfg) {
  if ($cfg.ContainsKey("WDB_PROXY")) { if ($cfg["WDB_PROXY"] -in @("off", "none", "direct", "")) { return $null }; return $cfg["WDB_PROXY"] }
  # 隧道是长期运行的后台进程，优先用常驻的本地代理端口（Clash/mihomo/v2rayN），
  # 当前终端会话里的 HTTPS_PROXY 可能随会话消失，只作最后兜底
  $candidates = @(@(7897, "http"), @(7890, "http"), @(10809, "http"), @(10808, "socks5"), @(1080, "socks5"))
  foreach ($c in $candidates) { if (Test-Port "127.0.0.1" $c[0]) { return "$($c[1])://127.0.0.1:$($c[0])" } }
  $userProxy = [Environment]::GetEnvironmentVariable("HTTPS_PROXY", "User")
  if ($userProxy) { return $userProxy }
  if ($env:HTTPS_PROXY) { return $env:HTTPS_PROXY }
  return $null
}
function Download-File([string]$url, [string]$target, $proxy) {
  New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
  $tmp = "$target.download"
  $params = @{ Uri = $url; OutFile = $tmp; UseBasicParsing = $true; TimeoutSec = 300 }
  if ($proxy -and $proxy -like "http*") { $params["Proxy"] = $proxy }
  try { Invoke-WebRequest @params } catch { if ($params.ContainsKey("Proxy")) { $params.Remove("Proxy"); Invoke-WebRequest @params } else { throw } }
  Move-Item -Force $tmp $target
}
function Install-Cloudflared($proxy) {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } elseif ([Environment]::Is64BitOperatingSystem) { "amd64" } else { "386" }
  $target = Join-Path $AppDir "tools\cloudflared.exe"
  Info "  正在下载 cloudflared ($arch)…"
  Download-File "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-$arch.exe" $target $proxy
  return $target
}
# 用 WMI 创建进程：不属于当前终端/代理工具的进程树与作业对象，关闭终端后依然运行
function Start-Detached([string]$commandLine, [string]$workDir) {
  $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
  $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine; CurrentDirectory = $workDir; ProcessStartupInformation = $startup }
  if ($result.ReturnValue -ne 0) { throw "启动进程失败 (Win32_Process.Create=$($result.ReturnValue)): $commandLine" }
  return [int]$result.ProcessId
}
function Stop-Tree($procId) { if ($procId -and (Test-Pid $procId)) { & taskkill.exe /PID $procId /T /F 2>$null | Out-Null } }
function Find-Strays([int]$port) {
  $escaped = [Regex]::Escape((Join-Path $AppDir "mcp-http.mjs"))
  Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -eq "node.exe" -and $_.CommandLine -match $escaped) -or
    ($_.Name -eq "cloudflared.exe" -and $_.CommandLine -match "127\.0\.0\.1:$port")
  }
}
function Get-PublicUrl($state) {
  if (-not $state) { return $null }
  if ($state.publicUrl) { return $state.publicUrl }
  return $null
}
function Read-TunnelUrl([string]$log) {
  if (-not (Test-Path $log)) { return $null }
  $text = Get-Content $log -Raw -ErrorAction SilentlyContinue
  if ($text -and $text -match 'https://[a-z0-9-]+\.trycloudflare\.com') { return $Matches[0] }
  return $null
}
function Show-Connection($state) {
  $port = $state.port
  $pin = if (Test-Path $PinFile) { (Get-Content $PinFile -Raw).Trim() } else { "(服务首次启动后生成)" }
  Title "========== Windows Developer Bridge 已就绪 =========="
  if ($state.publicUrl) {
    Write-Host "  MCP 地址（填到 ChatGPT 等客户端）: " -NoNewline; Write-Host "$($state.publicUrl)/mcp" -ForegroundColor Green
  } else {
    Write-Host "  本机 MCP 地址: " -NoNewline; Write-Host "http://127.0.0.1:$port/mcp" -ForegroundColor Green
  }
  Write-Host "  授权 PIN（只在本机看，别发给别人）: " -NoNewline; Write-Host $pin -ForegroundColor Yellow
  $unlocked = Test-Path $UnlockFile
  Write-Host "  完全访问: " -NoNewline; if ($unlocked) { Write-Host "已开启（wdb lock 可关闭）" -ForegroundColor Green } else { Write-Host "已锁定（wdb unlock 开启）" -ForegroundColor Yellow }
  if ($state.publicUrl) {
    Info ""
    Info "  连接 ChatGPT：设置 → Apps & Connectors（应用与连接器）→ 高级 → 开启开发者模式 → 创建连接器"
    Info "    URL 填上面的 MCP 地址，认证选 OAuth → 在弹出的授权页输入 PIN → 批准。"
    Info "  注意：Quick Tunnel 地址每次 wdb start 都会变，变了需要在客户端里更新 URL。"
    try { Set-Clipboard -Value "$($state.publicUrl)/mcp"; Info "  （MCP 地址已复制到剪贴板）" } catch {}
  }
  Info ""
  Info "  常用：wdb status | wdb stop | wdb logs | wdb doctor | wdb help"
}

# ---------- 命令 ----------
function Cmd-Start {
  $cfg = Ensure-Config
  $port = [int](Get-Option "port" $cfg["WDB_HTTP_PORT"])
  $local = (Has-Flag "local") -or ($cfg["WDB_TUNNEL"] -eq "none")
  $state = Read-State
  if ($state -and (Test-Pid $state.httpPid) -and (Test-Health $state.port) -and ($local -or (Test-Pid $state.tunnelPid))) {
    Ok "已经在运行"; Show-Connection $state; return
  }
  if ($state) { Stop-Tree $state.httpPid; Stop-Tree $state.tunnelPid }
  foreach ($p in Find-Strays $port) { Stop-Tree $p.ProcessId }
  if (Test-Port "127.0.0.1" $port) { throw "端口 $port 已被其他程序占用。用 wdb start --port 8788 换一个端口，或关闭占用的程序。" }

  $node = Get-Node
  New-Item -ItemType Directory -Force -Path $LogDir, $RunDir | Out-Null
  $httpLog = Join-Path $LogDir "http.log"; $tunnelLog = Join-Path $LogDir "tunnel.log"
  Remove-Item $httpLog, $tunnelLog -Force -ErrorAction SilentlyContinue

  Title "启动 MCP HTTP 服务（127.0.0.1:$port）"
  if ($port -ne [int]$cfg["WDB_HTTP_PORT"]) { Set-ConfigValue "WDB_HTTP_PORT" "$port" }
  # WMI 创建的进程不继承当前会话的环境变量，自定义数据目录需显式传入
  $dataEnv = if ($env:WDB_DATA_DIR) { "set `"WDB_DATA_DIR=$env:WDB_DATA_DIR`"&& " } else { "" }
  $httpCmd = "cmd.exe /d /s /c `"$dataEnv`"$node`" `"$(Join-Path $AppDir 'mcp-http.mjs')`" 1>>`"$httpLog`" 2>&1`""
  $httpPid = Start-Detached $httpCmd $AppDir
  $deadline = (Get-Date).AddSeconds(20)
  while (-not (Test-Health $port)) {
    if ((Get-Date) -gt $deadline -or -not (Test-Pid $httpPid)) { Bad "HTTP 服务没有启动成功，日志："; if (Test-Path $httpLog) { Get-Content $httpLog -Tail 20 }; throw "HTTP 服务启动失败" }
    Start-Sleep -Milliseconds 300
  }
  Ok "HTTP 服务已启动"

  $state = [ordered]@{ httpPid = $httpPid; tunnelPid = $null; port = $port; publicUrl = $null; tunnel = "none"; startedAt = (Get-Date).ToString("o"); appDir = $AppDir }
  if (-not $local) {
    Title "启动 Cloudflare 隧道"
    $proxy = Find-Proxy $cfg
    $cloudflared = Get-Cloudflared
    if (-not $cloudflared) { $cloudflared = Install-Cloudflared $proxy }
    $named = [bool]$cfg["CLOUDFLARE_TUNNEL_TOKEN"]
    $attempts = @()
    if ($proxy) { $attempts += ,$proxy }
    $attempts += ,""
    foreach ($attempt in $attempts) {
      $envPrefix = ""
      if ($attempt) { $envPrefix = "set `"HTTPS_PROXY=$attempt`"&& set `"HTTP_PROXY=$attempt`"&& "; Info "  通过代理 $attempt 连接 Cloudflare（可用 config.env 里 WDB_PROXY=off 关闭）" } else { if ($proxy) { Warn "代理连接失败，改为直连重试" } }
      if ($named) {
        $tokenFile = Join-Path $RunDir "tunnel.token"
        [IO.File]::WriteAllText($tokenFile, $cfg["CLOUDFLARE_TUNNEL_TOKEN"])
        $tunnelArgs = "tunnel --no-autoupdate --protocol http2 run --token-file `"$tokenFile`""
      } else {
        $tunnelArgs = "tunnel --no-autoupdate --protocol http2 --url http://127.0.0.1:$port"
      }
      Remove-Item $tunnelLog -Force -ErrorAction SilentlyContinue
      $tunnelPid = Start-Detached "cmd.exe /d /s /c `"$envPrefix`"$cloudflared`" $tunnelArgs 1>>`"$tunnelLog`" 2>&1`"" $AppDir
      $url = $null
      $deadline = (Get-Date).AddSeconds(45)
      while ((Get-Date) -lt $deadline -and (Test-Pid $tunnelPid)) {
        if ($named) { if ((Test-Path $tunnelLog) -and (Select-String -Path $tunnelLog -Pattern "Registered tunnel connection" -Quiet)) { $url = $cfg["WDB_HTTP_PUBLIC_URL"]; break } }
        else { $url = Read-TunnelUrl $tunnelLog; if ($url -and (Select-String -Path $tunnelLog -Pattern "Registered tunnel connection" -Quiet)) { break } }
        Start-Sleep -Milliseconds 500
      }
      if ($url) { $state.tunnelPid = $tunnelPid; $state.publicUrl = $url.TrimEnd("/"); $state.tunnel = $(if ($named) { "named" } else { "quick" }); break }
      Stop-Tree $tunnelPid
    }
    if ($state.publicUrl) { Ok "隧道已连接：$($state.publicUrl)" }
    else { Warn "隧道没有连上（日志：$tunnelLog）。本机仍可用 http://127.0.0.1:$port/mcp。检查网络/代理后运行 wdb restart。" }
  }
  Write-State $state
  Show-Connection $state
}
function Cmd-Stop {
  $state = Read-State
  $port = if ($state) { [int]$state.port } else { [int]((Read-Config)["WDB_HTTP_PORT"]) }
  if (-not $port) { $port = 8787 }
  if ($state) { Stop-Tree $state.tunnelPid; Stop-Tree $state.httpPid }
  foreach ($p in Find-Strays $port) { Stop-Tree $p.ProcessId }
  Remove-Item $StateFile -Force -ErrorAction SilentlyContinue
  Ok "已停止（HTTP 服务与隧道）"
}
function Cmd-Status {
  $state = Read-State
  $cfg = Read-Config
  $port = if ($state) { [int]$state.port } elseif ($cfg["WDB_HTTP_PORT"]) { [int]$cfg["WDB_HTTP_PORT"] } else { 8787 }
  Title "Windows Developer Bridge 状态"
  Info "  程序目录: $AppDir"
  Info "  数据目录: $DataDir"
  if (Test-Health $port) { Ok "HTTP 服务运行中: http://127.0.0.1:$port/mcp" } else { Bad "HTTP 服务未运行（wdb start 启动）" }
  if ($state -and $state.publicUrl) {
    if (Test-Pid $state.tunnelPid) { Ok "隧道运行中: $($state.publicUrl)/mcp" } else { Bad "隧道已退出（wdb restart 重新连接）" }
  } elseif ($state -and $state.tunnel -eq "none") { Info "  隧道: 未启用（本机模式）" }
  if (Test-Path $UnlockFile) { Ok "完全访问已开启" } else { Warn "完全访问已锁定（wdb unlock 开启）" }
  if (Test-Path $PinFile) { Info "  授权 PIN: $((Get-Content $PinFile -Raw).Trim())" }
}
function Cmd-Unlock { New-Item -ItemType Directory -Force -Path $DataDir | Out-Null; if (-not (Test-Path $UnlockFile)) { New-Item -ItemType File -Path $UnlockFile | Out-Null }; Ok "完全访问已开启：远程客户端可以执行命令和读写文件（以当前 Windows 用户权限）。" }
function Cmd-Lock { Remove-Item $UnlockFile -Force -ErrorAction SilentlyContinue; Ok "完全访问已锁定：除 bridge_status 外的工具都会被拒绝，正在运行的后台任务会被终止。" }
function Cmd-Logs {
  $which = if ($Options.Count -gt 0 -and $Options[0] -notlike "-*") { $Options[0] } else { "http" }
  $file = Join-Path $LogDir "$which.log"
  if (-not (Test-Path $file)) { Warn "没有日志：$file"; return }
  if ((Has-Flag "follow") -or (Has-Flag "f")) { Get-Content $file -Tail 50 -Wait } else { Get-Content $file -Tail ([int](Get-Option "n" 60)) }
}
function Cmd-Doctor {
  Title "环境检查"
  try { $node = Get-Node; Ok "Node.js $((& $node --version).Trim()) ($node)" } catch { Bad $_.Exception.Message }
  $pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
  if ($pwsh) { Ok "PowerShell 7: $($pwsh.Source)" } else { Info "  [i]  未安装 PowerShell 7，将使用 Windows PowerShell 5.1（可选安装：winget install Microsoft.PowerShell）" }
  $git = Get-Command git -ErrorAction SilentlyContinue
  if ($git) { Ok "Git: $($git.Source)" } else { Warn "未安装 Git：apply_patch 仍支持 *** Begin Patch 格式，统一 diff 需要 Git（winget install Git.Git）" }
  $codex = Get-Command codex -ErrorAction SilentlyContinue
  if ($codex) { Ok "Codex CLI: $($codex.Source)" } else { Info "  [i]  未安装 Codex CLI（仅 codex_thread_* 工具需要）" }
  $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
  if (Test-Path $csc) { Ok "ConPTY 终端（pty_*）可用" } else { Warn "未找到 .NET Framework csc.exe，pty_* 工具不可用" }
  $cf = Get-Cloudflared
  if ($cf) { Ok "cloudflared: $cf" } else { Warn "未找到 cloudflared（wdb start 会自动下载）" }
  $proxy = Find-Proxy (Read-Config)
  if ($proxy) { Info "  [i]  检测到本地代理 $proxy（隧道会优先通过它连接）" }
  if (Test-Path $UnlockFile) { Ok "完全访问已开启" } else { Warn "完全访问已锁定（wdb unlock）" }
  Cmd-Status
}
function Cmd-ResetAuth {
  $running = Read-State
  if ($running) { Cmd-Stop }
  foreach ($f in @("oauth\clients.json", "oauth\tokens.json", "oauth\consent.pin")) { Remove-Item (Join-Path $DataDir $f) -Force -ErrorAction SilentlyContinue }
  Set-ConfigValue "WDB_HTTP_TOKEN" (New-Token)
  Ok "已清除所有 OAuth 客户端/令牌，重新生成了 PIN 和静态 token。客户端需要重新授权。"
  if ($running) { Cmd-Start }
}
function Cmd-Token { $cfg = Ensure-Config; Info $cfg["WDB_HTTP_TOKEN"] }
function Cmd-Pin { if (Test-Path $PinFile) { Info (Get-Content $PinFile -Raw).Trim() } else { Warn "PIN 尚未生成，先运行 wdb start" } }
function Cmd-Url { $s = Read-State; if ($s -and $s.publicUrl) { Info "$($s.publicUrl)/mcp" } elseif ($s) { Info "http://127.0.0.1:$($s.port)/mcp" } else { Warn "服务未运行" } }
function Cmd-McpConfig {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { $node = "node" }
  $bridge = Join-Path $AppDir "bridge.mjs"
  Title "本机 stdio 方式接入（Claude Code / Codex / Claude Desktop / Cursor 等）"
  Info "Claude Code:"
  Info "  claude mcp add --scope user windows-bridge -- `"$node`" `"$bridge`""
  Info "Codex (~/.codex/config.toml):"
  Info "  [mcp_servers.windows-bridge]"
  Info "  command = '$node'"
  Info "  args = ['$bridge']"
  Info "通用 JSON (mcpServers):"
  $json = @{ mcpServers = @{ "windows-bridge" = @{ command = $node; args = @($bridge) } } } | ConvertTo-Json -Depth 5
  Info $json
}
function Cmd-Update {
  $installer = Join-Path $AppDir "install.ps1"
  if (-not (Test-Path $installer)) { throw "找不到 $installer" }
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installer -Update -InstallDir $AppDir
}
function Cmd-Uninstall {
  Cmd-Stop
  # 直接改注册表并保留 REG_EXPAND_SZ，避免把 PATH 里的 %USERPROFILE% 等展开写死
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
  try {
    $raw = [string]$key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $kept = ($raw -split ";" | Where-Object { $_ -and ([Environment]::ExpandEnvironmentVariables($_).TrimEnd("\") -ine $BinDir.TrimEnd("\")) }) -join ";"
    if ($kept -ne $raw) { $key.SetValue("Path", $kept, [Microsoft.Win32.RegistryValueKind]::ExpandString) }
  } finally { $key.Close() }
  foreach ($d in @("$HOME\.claude\skills\windows-developer-bridge", "$HOME\.codex\skills\windows-developer-bridge", "$HOME\.agents\skills\windows-developer-bridge")) { Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue }
  Remove-Item (Join-Path $BinDir "wdb.cmd") -Force -ErrorAction SilentlyContinue
  if (Has-Flag "purge") {
    Ok "将删除全部数据（配置、令牌、审计日志）：$DataDir"
    Start-Process -WindowStyle Hidden -FilePath "cmd.exe" -ArgumentList "/d /c timeout /t 2 >nul & rmdir /s /q `"$DataDir`""
  } elseif ((Split-Path $AppDir -Parent) -eq $DataDir) {
    Start-Process -WindowStyle Hidden -FilePath "cmd.exe" -ArgumentList "/d /c timeout /t 2 >nul & rmdir /s /q `"$AppDir`""
  }
  Ok "已卸载（数据目录 $DataDir 已保留，加 --purge 可一并删除）"
}
function Cmd-Help {
  Info @"
Windows Developer Bridge (wdb) — 把这台 Windows 电脑作为 MCP 工具提供给 ChatGPT / Claude 等 AI

  wdb start [--local] [--port N]   一键启动 HTTP 服务 + Cloudflare 隧道，打印 MCP 地址和授权 PIN
  wdb stop                         停止服务和隧道
  wdb restart                      重启（Quick Tunnel 地址会变）
  wdb status                       查看运行状态、地址、PIN
  wdb url | pin | token            只打印 MCP 地址 / 授权 PIN / 静态 Bearer token
  wdb unlock | lock                开启 / 关闭完全访问（命令执行与文件读写）
  wdb logs [http|tunnel] [-f]      查看日志
  wdb doctor                       检查运行环境
  wdb mcp-config                   打印本机 stdio 接入配置（Claude Code / Codex 等）
  wdb reset-auth                   作废所有已授权客户端，重新生成 PIN 和 token
  wdb update                       更新到最新版本
  wdb uninstall [--purge]          卸载（--purge 同时删除数据）

配置文件：$ConfigFile
"@
}

try {
  switch ($Command.ToLower()) {
    "start" { Cmd-Start }
    "stop" { Cmd-Stop }
    "restart" { Cmd-Stop; Cmd-Start }
    "status" { Cmd-Status }
    "url" { Cmd-Url }
    "pin" { Cmd-Pin }
    "token" { Cmd-Token }
    "unlock" { Cmd-Unlock }
    "lock" { Cmd-Lock }
    "logs" { Cmd-Logs }
    "doctor" { Cmd-Doctor }
    "mcp-config" { Cmd-McpConfig }
    "reset-auth" { Cmd-ResetAuth }
    "update" { Cmd-Update }
    "uninstall" { Cmd-Uninstall }
    default { Cmd-Help }
  }
} catch {
  Bad $_.Exception.Message
  exit 1
}
