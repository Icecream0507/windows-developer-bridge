# Windows Developer Bridge - one-click installer (Windows 10/11, PowerShell 5.1+)
#
#   irm https://raw.githubusercontent.com/Icecream0507/windows-developer-bridge/main/install.ps1 | iex
#
# Options when run as a file:  .\install.ps1 [-NoStart] [-Locked] [-Update] [-Branch main] [-InstallDir <dir>]
# Options for the one-liner (set before running it):  $env:WDB_NO_START=1; $env:WDB_LOCKED=1; $env:WDB_BRANCH="main"
#
# What it does: checks/installs Node.js 20+, downloads WDB to %LOCALAPPDATA%\WindowsDeveloperBridge\app,
# downloads cloudflared, adds the `wdb` command to your user PATH, installs the agent skill for
# Claude Code / Codex, enables full access (unless -Locked) and runs `wdb start`.
# This file is intentionally ASCII-only so `irm | iex` works on every code page.
param([switch]$NoStart, [switch]$Locked, [switch]$Update, [string]$Branch, [string]$InstallDir)

function Install-WindowsDeveloperBridge {
  param([bool]$NoStart, [bool]$Locked, [bool]$Update, [string]$Branch, [string]$InstallDir)
  $ErrorActionPreference = "Stop"
  $ProgressPreference = "SilentlyContinue"
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $Repo = "Icecream0507/windows-developer-bridge"
  if (-not $Branch) { $Branch = if ($env:WDB_BRANCH) { $env:WDB_BRANCH } else { "main" } }
  $DataDir = if ($env:WDB_DATA_DIR) { $env:WDB_DATA_DIR } else { Join-Path $env:LOCALAPPDATA "WindowsDeveloperBridge" }
  if (-not $InstallDir) { $InstallDir = if ($env:WDB_INSTALL_DIR) { $env:WDB_INSTALL_DIR } else { Join-Path $DataDir "app" } }
  $BinDir = Join-Path $DataDir "bin"

  function Step($m) { Write-Host ""; Write-Host "==> $m" -ForegroundColor Cyan }
  function Ok($m) { Write-Host "    [OK] $m" -ForegroundColor Green }
  function Warn($m) { Write-Host "    [!]  $m" -ForegroundColor Yellow }
  function Test-Port([int]$port) {
    $c = New-Object System.Net.Sockets.TcpClient
    try { $ar = $c.BeginConnect("127.0.0.1", $port, $null, $null); return ($ar.AsyncWaitHandle.WaitOne(300) -and $c.Connected) } catch { return $false } finally { $c.Close() }
  }
  function Refresh-Path {
    $machine = [Environment]::GetEnvironmentVariable("Path", "Machine"); $user = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ";"
  }
  function Get-WebFile([string]$url, [string]$target, $proxy) {
    $p = @{ Uri = $url; OutFile = $target; UseBasicParsing = $true; TimeoutSec = 600 }
    if ($proxy -and $proxy -like "http*") { $p["Proxy"] = $proxy }
    try { Invoke-WebRequest @p } catch { if ($p.ContainsKey("Proxy")) { $p.Remove("Proxy"); Invoke-WebRequest @p } else { throw } }
  }

  Write-Host "Windows Developer Bridge installer" -ForegroundColor Cyan
  if ($env:OS -ne "Windows_NT") { throw "Windows 10/11 is required." }

  # Local proxy (common in mainland China) for GitHub / Cloudflare downloads.
  $proxy = $env:HTTPS_PROXY
  if (-not $proxy) { foreach ($c in @(@(7897, "http"), @(7890, "http"), @(10809, "http"))) { if (Test-Port $c[0]) { $proxy = "$($c[1])://127.0.0.1:$($c[0])"; break } } }
  if ($proxy) { Write-Host "    using proxy $proxy for downloads" -ForegroundColor DarkGray }

  Step "Checking Node.js (20 or newer)"
  $node = Get-Command node -ErrorAction SilentlyContinue
  $nodeMajor = 0
  if ($node) { $nodeMajor = [int]((& $node.Source -p "process.versions.node.split('.')[0]") | Out-String).Trim() }
  if ($nodeMajor -lt 20) {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget) { throw "Node.js 20+ is required. Install the LTS from https://nodejs.org/ and run this installer again." }
    Warn "Node.js 20+ not found; installing Node.js LTS with winget..."
    & $winget.Source install --id OpenJS.NodeJS.LTS -e --silent --accept-source-agreements --accept-package-agreements | Out-Host
    Refresh-Path
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { throw "Node.js installation finished but node.exe is not on PATH yet. Open a new terminal and run the installer again." }
  }
  Ok "Node.js $((& $node.Source --version).Trim())"

  Step "Downloading Windows Developer Bridge ($Branch) to $InstallDir"
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  $git = Get-Command git -ErrorAction SilentlyContinue
  if ((Test-Path (Join-Path $InstallDir ".git")) -and $git) {
    $gitArgs = @("-C", $InstallDir)
    if ($proxy) { $gitArgs += @("-c", "http.proxy=$proxy") }
    & $git.Source @gitArgs pull --ff-only | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "git pull failed in $InstallDir" }
  } else {
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("wdb-install-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    try {
      $zip = Join-Path $tmp "wdb.zip"
      Get-WebFile "https://codeload.github.com/$Repo/zip/refs/heads/$Branch" $zip $proxy
      Expand-Archive -Path $zip -DestinationPath $tmp -Force
      $src = Get-ChildItem $tmp -Directory | Select-Object -First 1
      if (-not (Test-Path (Join-Path $src.FullName "bridge.mjs"))) { throw "Downloaded archive does not look like WDB." }
      New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
      Get-ChildItem $InstallDir -Force | Where-Object { $_.Name -ne "tools" } | Remove-Item -Recurse -Force
      Copy-Item -Path (Join-Path $src.FullName "*") -Destination $InstallDir -Recurse -Force
    } finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
  }
  Ok "installed files"

  Step "Downloading cloudflared (Cloudflare Tunnel client)"
  $cf = Join-Path $InstallDir "tools\cloudflared.exe"
  if ((Test-Path $cf) -or (Get-Command cloudflared -ErrorAction SilentlyContinue)) { Ok "cloudflared already present" }
  else {
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } elseif ([Environment]::Is64BitOperatingSystem) { "amd64" } else { "386" }
    try {
      New-Item -ItemType Directory -Force -Path (Split-Path $cf) | Out-Null
      Get-WebFile "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-$arch.exe" "$cf.download" $proxy
      Move-Item -Force "$cf.download" $cf
      Ok "cloudflared downloaded"
    } catch { Warn "could not download cloudflared now ($($_.Exception.Message)); 'wdb start' will retry." }
  }

  Step "Installing the 'wdb' command"
  New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
  $ps = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $script = Join-Path $InstallDir "wdb.ps1"
  # cmd.exe reads .cmd files in the OEM code page; keep the path portable via %LOCALAPPDATA%.
  if ($script.StartsWith($env:LOCALAPPDATA, [StringComparison]::OrdinalIgnoreCase)) { $script = "%LOCALAPPDATA%" + $script.Substring($env:LOCALAPPDATA.Length) }
  $oem = [Text.Encoding]::GetEncoding([Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage)
  [IO.File]::WriteAllText((Join-Path $BinDir "wdb.cmd"), "@echo off`r`n`"$ps`" -NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$script`" %*`r`n", $oem)
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
  try {
    $raw = [string]$key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $entry = $BinDir
    if ($entry.StartsWith($env:LOCALAPPDATA, [StringComparison]::OrdinalIgnoreCase)) { $entry = "%LOCALAPPDATA%" + $entry.Substring($env:LOCALAPPDATA.Length) }
    $present = $raw -split ";" | Where-Object { $_ -and ([Environment]::ExpandEnvironmentVariables($_).TrimEnd("\") -ieq $BinDir.TrimEnd("\")) }
    if (-not $present) {
      $key.SetValue("Path", ((@($raw.TrimEnd(";"), $entry) | Where-Object { $_ }) -join ";"), [Microsoft.Win32.RegistryValueKind]::ExpandString)
      # Setting a user variable through .NET broadcasts WM_SETTINGCHANGE so new terminals see the PATH change.
      [Environment]::SetEnvironmentVariable("WDB_PATH_REFRESH", "1", "User"); [Environment]::SetEnvironmentVariable("WDB_PATH_REFRESH", $null, "User")
    }
  } finally { $key.Close() }
  if (-not (($env:Path -split ";") -contains $BinDir)) { $env:Path = "$BinDir;$env:Path" }
  Ok "'wdb' is on your PATH (new terminals pick it up automatically)"

  Step "Installing the agent skill (Claude Code / Codex)"
  $skillSrc = Join-Path $InstallDir "skills\windows-developer-bridge"
  $installedSkill = $false
  foreach ($root in @((Join-Path $HOME ".claude"), (Join-Path $HOME ".codex"))) {
    if (Test-Path $root) {
      $dest = Join-Path $root "skills\windows-developer-bridge"
      Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue
      New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
      Copy-Item $skillSrc $dest -Recurse -Force
      Ok "skill -> $dest"; $installedSkill = $true
    }
  }
  if (-not $installedSkill) { Write-Host "    (no ~/.claude or ~/.codex found; skipped)" -ForegroundColor DarkGray }

  $unlock = Join-Path $DataDir "FULL_ACCESS_ENABLED"
  if (-not $Update) {
    Step "Full access"
    if ($Locked) { Remove-Item $unlock -Force -ErrorAction SilentlyContinue; Warn "left LOCKED: tools other than bridge_status are refused until you run 'wdb unlock'." }
    else { if (-not (Test-Path $unlock)) { New-Item -ItemType File -Path $unlock | Out-Null }; Ok "enabled: connected AI clients can run commands and edit files as $env:USERNAME ('wdb lock' to disable)." }
  }

  $wdb = Join-Path $InstallDir "wdb.ps1"
  if ($Update) {
    $state = Join-Path $DataDir "run\state.json"
    if (Test-Path $state) { Step "Restarting the running service"; & $ps -NoLogo -NoProfile -ExecutionPolicy Bypass -File $wdb restart }
    Write-Host ""; Write-Host "Update complete." -ForegroundColor Green
    return
  }
  if ($NoStart) {
    Write-Host ""; Write-Host "Installed. Run 'wdb start' in a new terminal to start the bridge." -ForegroundColor Green
    return
  }
  Step "Starting the bridge (wdb start)"
  & $ps -NoLogo -NoProfile -ExecutionPolicy Bypass -File $wdb start
}

$opts = @{
  NoStart = [bool]($NoStart -or $env:WDB_NO_START)
  Locked = [bool]($Locked -or $env:WDB_LOCKED)
  Update = [bool]$Update
  Branch = $Branch
  InstallDir = $InstallDir
}
try { Install-WindowsDeveloperBridge @opts }
catch { Write-Host ""; Write-Host "Installation failed: $($_.Exception.Message)" -ForegroundColor Red }
