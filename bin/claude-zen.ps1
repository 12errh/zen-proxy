# Zen Claude launcher for Windows — the PowerShell counterpart of bin/claude-zen.
#
# Claude Code reads env from %USERPROFILE%\.claude\settings.json, and that takes
# precedence over the shell. Exporting ANTHROPIC_BASE_URL is therefore not enough
# when that file already sets one — this passes --settings instead, which does
# win, and leaves the existing Claude Code configuration untouched.
[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $ClaudeArgs)

$ErrorActionPreference = "Stop"

# Locate the settings file beside this script (installer copies the pair together).
$here = $PSScriptRoot
$settings = $null
foreach ($cand in @(
    (Join-Path $here "..\claude\zen-proxy.settings.json"),
    (Join-Path $here "claude\zen-proxy.settings.json"),
    (Join-Path $here "zen-proxy.settings.json"))) {
    if (Test-Path $cand) { $settings = (Resolve-Path $cand).Path; break }
}
if (-not $settings) {
    [Console]::Error.WriteLine("zen-claude: could not find claude\zen-proxy.settings.json")
    exit 1
}

# The proxy's port comes from its own config, so a non-default setup is honoured.
$config = $env:ZEN_PROXY_CONFIG
if (-not $config) {
    foreach ($cand in @((Join-Path $here "..\zen-proxy.json"), (Join-Path $here "zen-proxy.json"))) {
        if (Test-Path $cand) { $config = $cand; break }
    }
}
$port = 8787
if ($config -and (Test-Path $config)) {
    try {
        $parsed = Get-Content $config -Raw | ConvertFrom-Json
        if ($parsed.port) { $port = [int]$parsed.port }
    } catch {}
}

# Check /health first so we never launch Claude Code against nothing.
try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -TimeoutSec 3 -UseBasicParsing
    if ($r.StatusCode -ne 200) { throw "unhealthy" }
} catch {
    # stderr, not Write-Host, so a caller can detect the failure.
    [Console]::Error.WriteLine("zen-claude: no zen-proxy responding on port $port - start it first:")
    [Console]::Error.WriteLine("            zen-proxy")
    exit 1
}

$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude) {
    [Console]::Error.WriteLine("zen-claude: 'claude' not found on PATH - install Claude Code first")
    exit 1
}

& claude --settings $settings @ClaudeArgs
exit $LASTEXITCODE