# Builds dist/windows-developer-bridge-skill.zip from skills/windows-developer-bridge.
# The archive contains a top-level windows-developer-bridge/ folder with SKILL.md, the layout
# expected by Claude Code (~/.claude/skills), Codex (~/.codex/skills) and claude.ai skill uploads.
# Entries use forward slashes (Compress-Archive on Windows PowerShell 5.1 writes backslashes).
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$root = Split-Path -Parent $PSScriptRoot
$skill = Join-Path $root "skills\windows-developer-bridge"
$dist = Join-Path $root "dist"
$zipPath = Join-Path $dist "windows-developer-bridge-skill.zip"
if (-not (Test-Path (Join-Path $skill "SKILL.md"))) { throw "SKILL.md not found in $skill" }
New-Item -ItemType Directory -Force -Path $dist | Out-Null
Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  Get-ChildItem $skill -Recurse -File | Sort-Object FullName | ForEach-Object {
    $relative = $_.FullName.Substring($skill.Length).TrimStart("\").Replace("\", "/")
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, "windows-developer-bridge/$relative", [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally { $zip.Dispose() }
Write-Host "Created $zipPath"
