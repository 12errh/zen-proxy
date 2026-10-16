# Zen Proxy installer for Windows (PowerShell)
# Usage (run in PowerShell):
#   irm https://raw.githubusercontent.com/12errh/zen-proxy/main/install.ps1 | iex
#   # or, from a local checkout:
#   powershell -ExecutionPolicy Bypass -File install.ps1 -LocalSrc C:\path\to\zen-proxy
#
# Env options:
#   ZEN_PROXY_REPO   GitHub "owner/repo" (default: 12errh/zen-proxy)
#   ZEN_PROXY_DIR    install directory (default: $HOME\.zen-proxy)
#   ZEN_PROXY_PORT   default port (default: 8787)

param(
  [string]$LocalSrc = ""
)

$ErrorActionPreference = "Stop"
$Repo = $env:ZEN_PROXY_REPO
if (-not $Repo) { $Repo = "12errh/zen-proxy" }
$InstallDir = $env:ZEN_PROXY_DIR
if (-not $InstallDir) { $InstallDir = Join-Path $HOME ".zen-proxy" }
$Port = $env:ZEN_PROXY_PORT
if (-not $Port) { $Port = "8787" }

function Info($m) { Write-Host $m -ForegroundColor Green }
function Die($m) { Write-Host $m -ForegroundColor Red; exit 1 }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Die "Node.js >= 18 is required. Install from https://nodejs.org then re-run."
}

if ([string]::IsNullOrWhiteSpace($InstallDir) -or $InstallDir -eq "/") {
  Die "Refusing to install into '$InstallDir'"
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Info "Installing zen-proxy to $InstallDir"

$ConfigPath = Join-Path $InstallDir "zen-proxy.json"
$CfgBak = $null
if (Test-Path $ConfigPath) {
  $CfgBak = Join-Path $env:TEMP ("zen-proxy-config-" + [guid]::NewGuid().ToString() + ".json")
  Copy-Item $ConfigPath $CfgBak -Force
}

if ($LocalSrc) {
  if (-not (Test-Path $LocalSrc)) { Die "Local source not found: $LocalSrc" }
  Copy-Item -Path (Join-Path $LocalSrc "*") -Destination $InstallDir -Recurse -Force
  Info "Copied from local source: $LocalSrc"
}
else {
  $Tarball = "https://codeload.github.com/$Repo/tar.gz/refs/heads/main"
  Info "Downloading $Tarball ..."
  $Tmp = Join-Path $env:TEMP ("zen-proxy-" + [guid]::NewGuid().ToString())
  New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
  Invoke-WebRequest -Uri $Tarball -OutFile (Join-Path $Tmp "repo.tar.gz")
  tar -xzf (Join-Path $Tmp "repo.tar.gz") -C $Tmp
  Get-ChildItem $InstallDir | Remove-Item -Recurse -Force
  $inner = Get-ChildItem $Tmp -Directory | Select-Object -First 1
  Copy-Item -Path (Join-Path $inner.FullName "*") -Destination $InstallDir -Recurse -Force
  Remove-Item $Tmp -Recurse -Force
  Info "Downloaded and extracted $Repo"
}

if ($CfgBak -and (Test-Path $CfgBak)) {
  Copy-Item $CfgBak $ConfigPath -Force
  Remove-Item $CfgBak -Force
}

if (-not (Test-Path (Join-Path $InstallDir "zen-proxy.mjs"))) {
  Die "zen-proxy.mjs not found after install - check ZEN_PROXY_REPO"
}

if (-not (Test-Path $ConfigPath)) {
  Set-Content -Path $ConfigPath -Value "{ `"host`": `"127.0.0.1`", `"port`": $Port }"
  Info "Created default config with port $Port"
}

$Script = Join-Path $InstallDir "zen-proxy.ps1"
Set-Content -Path $Script -Value @"
# Zen Proxy launcher
node "$InstallDir\zen-proxy.mjs" `$args
"@

# Put `zen-proxy` and `zen-claude` on PATH so Windows gets the same two-command
# experience as Linux and macOS, instead of a long powershell -File invocation.
$BinDir = Join-Path $HOME ".local\bin"
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

Set-Content -Path (Join-Path $BinDir "zen-proxy.cmd") -Value @"
@echo off
node "$InstallDir\zen-proxy.mjs" %*
"@

foreach ($shim in @("claude-zen.ps1", "claude-zen.cmd")) {
    $src = Join-Path $InstallDir "bin\$shim"
    if (Test-Path $src) { Copy-Item $src (Join-Path $BinDir $shim) -Force }
}
# The command is zen-claude; the script is claude-zen.ps1. Provide both names.
if (Test-Path (Join-Path $BinDir "claude-zen.cmd")) {
    Copy-Item (Join-Path $BinDir "claude-zen.cmd") (Join-Path $BinDir "zen-claude.cmd") -Force
}

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not $userPath) { $userPath = "" }
if (($userPath -split ";") -notcontains $BinDir) {
    [Environment]::SetEnvironmentVariable("Path", "$userPath;$BinDir", "User")
    Info "Added $BinDir to your user PATH (restart the terminal to pick it up)"
}

Info ""
Info "  zen-proxy installed!"
Info "  Dashboard: http://127.0.0.1:$Port"
Info ""
Info "  Run it:   zen-proxy"
Info "  Or:       powershell -ExecutionPolicy Bypass -File `"$Script`""
Info ""
if (Get-Command claude -ErrorAction SilentlyContinue) {
    Info "  Claude Code:  zen-claude   (starts the proxy and Claude Code together)"
    Info ""
}
Info "  Point your AI agent at:"
Info "    baseURL = http://127.0.0.1:$Port/v1"
Info "    apiKey  = public"
Info "    model   = space-bunny-free   (or any model listed in the dashboard)"