# codex-gateway setup script for Windows
# Installs codex-gateway as a Task Scheduler job (auto-starts on login).
# Usage: powershell -ExecutionPolicy Bypass -File setup.ps1

$ErrorActionPreference = "Stop"

$RepoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Script   = Join-Path $RepoDir "index.mjs"
$TaskName = "codex-gateway"

function Write-Header { Write-Host "  codex-gateway - setup wizard" -ForegroundColor White }
function Write-Ok($msg)   { Write-Host "  $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  Warning: $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "  Error: $msg" -ForegroundColor Red }
function Write-Sep  { Write-Host "  -------------------------------------" }

Write-Host ""
Write-Header
Write-Sep
Write-Host ""

# ── detect Node ───────────────────────────────────────────────────────────────

$_nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$NodePath = if ($_nodeCmd) { $_nodeCmd.Source } else { $null }
if (-not $NodePath) {
    Write-Err "node not found. Install Node.js 18+ from https://nodejs.org"
    exit 1
}
$NodeVersion = & node -e "process.stdout.write(process.version)"
Write-Ok "Node:  $NodePath ($NodeVersion)"

# ── detect codex ─────────────────────────────────────────────────────────────

$CodexPath = $null
$NodeBinDir = Split-Path $NodePath
foreach ($c in @(
    (Join-Path $NodeBinDir "codex.cmd"),
    (Join-Path $NodeBinDir "codex"),
    "C:\Program Files\nodejs\codex.cmd"
)) {
    if (Test-Path $c) { $CodexPath = $c; break }
}
if (-not $CodexPath) {
    $_codexCmd = Get-Command codex -ErrorAction SilentlyContinue
    $CodexPath = if ($_codexCmd) { $_codexCmd.Source } else { $null }
}
if (-not $CodexPath) {
    Write-Host ""
    Write-Err "Codex CLI not found."
    Write-Host ""
    Write-Host "  Install it with:" -ForegroundColor White
    Write-Host "    npm install -g @openai/codex" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Then log in:" -ForegroundColor White
    Write-Host "    codex login" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Re-run this setup script after installation." -ForegroundColor White
    exit 1
}
Write-Ok "Codex: $CodexPath"

# ── check codex login ─────────────────────────────────────────────────────────

$CodexHome = Join-Path $env:USERPROFILE ".codex"
$AuthFile  = Join-Path $CodexHome "auth.json"
if (Test-Path $AuthFile) {
    Write-Ok "Auth:  logged in ($AuthFile)"
} else {
    Write-Host ""
    Write-Warn "Codex CLI is not logged in yet."
    Write-Host ""
    Write-Host "  Please run:" -ForegroundColor White
    Write-Host "    codex login" -ForegroundColor Cyan
    Write-Host ""
    $confirm = Read-Host "  Continue anyway? [y/N]"
    if ($confirm -ne "y" -and $confirm -ne "Y") {
        Write-Host "  Aborted."
        exit 1
    }
}

Write-Host ""

# ── interactive prompts ───────────────────────────────────────────────────────

$defaultPort    = "8319"
$defaultWorkDir = $env:USERPROFILE
$defaultProxy   = ""

$portInput = Read-Host "  Listening port [$defaultPort]"
$PORT      = if ($portInput) { $portInput } else { $defaultPort }

$wdInput  = Read-Host "  Working directory for codex [$defaultWorkDir]"
$WORK_DIR = if ($wdInput) { $wdInput } else { $defaultWorkDir }

$HTTPS_PROXY_VAL = Read-Host "  HTTPS proxy, e.g. http://127.0.0.1:7890 (leave blank to skip)"

Write-Host ""

# ── build the command that Task Scheduler will run ────────────────────────────

# Env vars are passed via a wrapper cmd that sets them before launching node
$LogDir  = Join-Path $env:APPDATA "codex-gateway\logs"
$LogFile = Join-Path $LogDir "codex-gateway.log"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# Build wrapper bat — each `set` on its own line to avoid trailing-space bug
$lines = @(
    "@echo off",
    "set PORT=$PORT",
    "set WORK_DIR=$WORK_DIR",
    "set CODEX_HOME=$CodexHome",
    "set CODEX_PATH=$CodexPath"
)
if ($HTTPS_PROXY_VAL) {
    $HTTP_PROXY_VAL = $HTTPS_PROXY_VAL
    $ALL_PROXY_VAL  = $HTTPS_PROXY_VAL -replace "^http", "socks5"
    $lines += "set HTTPS_PROXY=$HTTPS_PROXY_VAL"
    $lines += "set HTTP_PROXY=$HTTP_PROXY_VAL"
    $lines += "set ALL_PROXY=$ALL_PROXY_VAL"
    $lines += "set NO_PROXY=localhost,127.0.0.1,::1"
}
$lines += "`"$NodePath`" `"$Script`" >> `"$LogFile`" 2>&1"

$WrapperBat = Join-Path $env:APPDATA "codex-gateway\run.bat"
Set-Content -Path $WrapperBat -Value ($lines -join "`r`n") -Encoding ASCII

# ── register Task Scheduler job ───────────────────────────────────────────────

# Remove old task if it exists (ignore error if not found)
try { $null = schtasks /delete /tn $TaskName /f 2>&1 } catch {}

# Create: trigger = ONLOGON, run as current user, start immediately
$CurrentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$null = schtasks /create /tn $TaskName /tr "`"$WrapperBat`"" /sc ONLOGON /ru $CurrentUser /rl HIGHEST /f 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Err "Failed to create Task Scheduler job. Try running as Administrator."
    exit 1
}

Write-Ok "Installed: Task Scheduler job '$TaskName'"
Write-Ok "Wrapper:   $WrapperBat"
Write-Ok "Logs:      $LogFile"
Write-Host ""

# ── start now ────────────────────────────────────────────────────────────────

Write-Host "  Starting now..." -ForegroundColor White
schtasks /run /tn $TaskName | Out-Null
Start-Sleep -Seconds 3

# ── verify ───────────────────────────────────────────────────────────────────

try {
    $resp = Invoke-RestMethod "http://127.0.0.1:$PORT/v1/models" -ErrorAction Stop
    $count = $resp.data.Count
    Write-Ok "Running! $count models available."
} catch {
    Write-Warn "Could not reach http://127.0.0.1:$PORT/v1/models — check logs at $LogFile"
}

# ── done ─────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Sep
Write-Ok "Setup complete!"
Write-Host ""
Write-Host "  Gateway URL: http://127.0.0.1:$PORT" -ForegroundColor White
Write-Host ""
Write-Host "  Quick test:" -ForegroundColor White
Write-Host "    curl http://127.0.0.1:$PORT/v1/models" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Chat completion:" -ForegroundColor White
Write-Host "    curl http://127.0.0.1:$PORT/v1/chat/completions \" -ForegroundColor Cyan
Write-Host "      -H 'Content-Type: application/json' \" -ForegroundColor Cyan
Write-Host "      -d '{`"model`":`"gpt-5.4`",`"messages`":[{`"role`":`"user`",`"content`":`"hi`"}]}'" -ForegroundColor Cyan
Write-Host ""
