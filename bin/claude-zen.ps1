# Zen Claude launcher for Windows - the PowerShell counterpart of bin/claude-zen.
# One command: starts zen-proxy if it is not running, registers every free Zen
# model in Claude Code's /model picker, and cleans up on exit.
[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $ClaudeArgs)

$ErrorActionPreference = "Stop"

# The installer copies this next to zen-proxy, so $PSScriptRoot is the real location.
$here = $PSScriptRoot
$root = Split-Path $here -Parent

function Fail([string]$msg) { [Console]::Error.WriteLine($msg); exit 1 }

# ---- 1. Claude Code must be installed --------------------------------------
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Fail @"
zen-claude: Claude Code is not installed.

  Install it, then run zen-claude again:
    npm install -g @anthropic-ai/claude-code
    (or: https://claude.com/claude-code)

  If it is installed but not on your PATH, open a new terminal.
"@
}

# ---- 2. Locate the proxy and its config -----------------------------------
$main = $null
foreach ($c in @((Join-Path $root "zen-proxy.mjs"), (Join-Path (Split-Path $root -Parent) "zen-proxy.mjs"))) {
    if (Test-Path $c) { $main = $c; break }
}
if (-not $main) { Fail "zen-claude: could not find zen-proxy.mjs" }

$config = $env:ZEN_PROXY_CONFIG
if (-not $config) {
    foreach ($c in @((Join-Path $root "zen-proxy.json"), (Join-Path (Split-Path $root -Parent) "zen-proxy.json"))) {
        if (Test-Path $c) { $config = $c; break }
    }
}
$port = 8787
if ($config -and (Test-Path $config)) {
    try {
        $parsed = Get-Content $config -Raw | ConvertFrom-Json
        if ($parsed.port) { $port = [int]$parsed.port }
    } catch {}
}

function Test-ZenProxy {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -TimeoutSec 2 -UseBasicParsing
        return $r.StatusCode -eq 200
    } catch { return $false }
}

# ---- 3. Start the proxy if it is not already up ----------------------------
$proc = $null
$log = $null
if (-not (Test-ZenProxy)) {
    [Console]::Error.WriteLine("zen-claude: starting zen-proxy on port $port ...")
    $log = Join-Path $env:TEMP ("zen-proxy." + [guid]::NewGuid().ToString() + ".log")
    $proc = Start-Process -FilePath "node" -ArgumentList $main -PassThru -NoNewWindow `
        -RedirectStandardOutput $log -RedirectStandardError "$log.err"
    $ok = $false
    for ($i = 0; $i -lt 40; $i++) {
        if (Test-ZenProxy) { $ok = $true; break }
        Start-Sleep -Milliseconds 250
        if ($proc.HasExited) { break }
    }
    if (-not $ok) {
        [Console]::Error.WriteLine("zen-claude: zen-proxy failed to start. Log:")
        if (Test-Path $log) { Get-Content $log -Tail 20 | ForEach-Object { [Console]::Error.WriteLine($_) } }
        if ($proc -and -not $proc.HasExited) { $proc.Kill() }
        Fail "zen-claude: zen-proxy did not come up."
    }

    # Watch the proxy for as long as Claude Code runs. A proxy that dies
    # mid-session leaves the agent talking to a closed port, and the only symptom
    # is a connection error with nothing to explain it. $runFlag is how the
    # watcher knows Claude Code is still going.
    $runFlag = Join-Path $env:TEMP ("zen-claude-run." + [guid]::NewGuid().ToString() + ".flag")
    Set-Content -Path $runFlag -Value "1"
    $watcher = Start-ThreadJob -ScriptBlock {
        param($Main, $Port, $Log, $RunFlag)
        $restarts = 0
        while (Test-Path $RunFlag) {
            Start-Sleep -Seconds 2
            if (-not (Test-Path $RunFlag)) { break }
            try { $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2 -UseBasicParsing } catch { $r = $null }
            if ($r) { continue }
            $restarts++
            if ($restarts -gt 10) {
                [Console]::Error.WriteLine("zen-claude: zen-proxy kept dying; giving up on restarts.")
                break
            }
            [Console]::Error.WriteLine("zen-claude: zen-proxy stopped, restarting ($restarts/10)...")
            Start-Process -FilePath "node" -ArgumentList $Main -NoNewWindow `
                -RedirectStandardOutput $Log -RedirectStandardError "$Log.err" | Out-Null
            for ($i = 0; $i -lt 40; $i++) {
                try { $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2 -UseBasicParsing; break } catch { }
                Start-Sleep -Milliseconds 250
            }
        }
    } -ArgumentList $main, $port, $log, $runFlag
}

# ---- 4. Build settings that list every free model -------------------------
$settings = Join-Path $env:TEMP ("zen-claude-settings." + [guid]::NewGuid().ToString() + ".json")
$maker = Join-Path $here "make-settings.mjs"
if (-not (Test-Path $maker)) { $maker = Join-Path $root "bin\make-settings.mjs" }

try {
    $out = & node $maker $port $settings 2>$null
    $count = if ($out) { [int]($out | Select-Object -Last 1) } else { 0 }
} catch { $count = 0 }
if ($count -le 0) { Fail "zen-claude: could not determine the free model list." }

try {
    & claude --settings $settings @ClaudeArgs
} finally {
    if ($runFlag) { Remove-Item $runFlag -ErrorAction SilentlyContinue }
    if ($watcher) {
        # Give the watcher a moment to stop its proxy before we delete its log.
        try { $watcher | Wait-Job -Timeout 4 | Out-Null } catch { }
        Remove-Job $watcher -Force -ErrorAction SilentlyContinue
    }
    Remove-Item $settings -ErrorAction SilentlyContinue
    if ($log) { Remove-Item $log, "$log.err" -ErrorAction SilentlyContinue }
    if ($proc -and -not $proc.HasExited) { $proc.Kill() }
}
exit $LASTEXITCODE