# codex-gateway setup script for Windows
# Installs codex-gateway as a Task Scheduler job (auto-starts on login).
# Usage: powershell -ExecutionPolicy Bypass -File setup.ps1 [options]

param(
    [switch]$Yes,
    [string]$Port,
    [string]$WorkDir,
    [string]$HttpsProxy,
    [switch]$SyncDroid,
    [switch]$SetDefaultDroid,
    [string]$DroidBaseUrl,
    [string]$DroidApiKey,
    [string]$DroidProvider,
    [switch]$NoDroidBackup,
    [switch]$Help
)

$ErrorActionPreference = "Stop"

$RepoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Script   = Join-Path $RepoDir "index.mjs"
$TaskName = "codex-gateway"

function Write-Header { Write-Host "  codex-gateway - setup wizard" -ForegroundColor White }
function Write-Ok($msg)   { Write-Host "  $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  Warning: $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "  Error: $msg" -ForegroundColor Red }
function Write-Sep  { Write-Host "  -------------------------------------" }
function Show-Usage {
    @"
Usage:
  powershell -ExecutionPolicy Bypass -File setup.ps1 [options]

Options:
  -Yes                    Use defaults / provided flags without prompts
  -Port <port>            Listening port (default: 8319)
  -WorkDir <path>         Working directory for codex (default: %USERPROFILE%)
  -HttpsProxy <url>       HTTPS proxy to pass to the gateway service
  -SyncDroid              Import codex-gateway models into Droid after setup
  -SetDefaultDroid        Also set GPT-5.4 [Codex Gateway] as Droid default
  -DroidBaseUrl <url>     Droid base URL override (default: http://127.0.0.1:<port>/v1)
  -DroidApiKey <key>      Droid API key value to write (default: sk-codex-gateway)
  -DroidProvider <name>   Droid provider value (default: generic-chat-completion-api)
  -NoDroidBackup          Skip .bak backups before writing Droid config
  -Help                   Show this help
"@
}
function Read-Value([string]$Prompt, [string]$Default) {
    if ($Yes) {
        Write-Host ("  {0}: {1} (configured)" -f $Prompt, $Default) -ForegroundColor White
        return $Default
    }
    $input = Read-Host ("  {0} [{1}]" -f $Prompt, $Default)
    if ([string]::IsNullOrWhiteSpace($input)) {
        return $Default
    }
    return $input
}
function Read-OptionalValue([string]$Prompt, [string]$Default = "") {
    if ($Yes) {
        if ([string]::IsNullOrWhiteSpace($Default)) {
            Write-Host ("  {0}: (skipped)" -f $Prompt) -ForegroundColor White
            return ""
        }
        Write-Host ("  {0}: {1} (configured)" -f $Prompt, $Default) -ForegroundColor White
        return $Default
    }
    return Read-Host ("  {0} (leave blank to skip)" -f $Prompt)
}

if ($Help) {
    Show-Usage
    exit 0
}

if ($SetDefaultDroid) {
    $SyncDroid = $true
}

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
    if ($Yes) {
        Write-Warn "Continuing with defaults because -Yes was specified."
    } else {
        $confirm = Read-Host "  Continue anyway? [y/N]"
        if ($confirm -ne "y" -and $confirm -ne "Y") {
            Write-Host "  Aborted."
            exit 1
        }
    }
}

Write-Host ""

# ── interactive prompts ───────────────────────────────────────────────────────

$defaultPort    = if ($Port) { $Port } else { "8319" }
$defaultWorkDir = if ($WorkDir) { $WorkDir } else { $env:USERPROFILE }
$defaultProxy   = if ($HttpsProxy) { $HttpsProxy } else { "" }

$PORT = Read-Value "Listening port" $defaultPort
$WORK_DIR = Read-Value "Working directory for codex" $defaultWorkDir
$HTTPS_PROXY_VAL = Read-OptionalValue "HTTPS proxy, e.g. http://127.0.0.1:7890" $defaultProxy

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
    $lines += "set https_proxy=$HTTPS_PROXY_VAL"
    $lines += "set HTTP_PROXY=$HTTP_PROXY_VAL"
    $lines += "set http_proxy=$HTTP_PROXY_VAL"
    $lines += "set ALL_PROXY=$ALL_PROXY_VAL"
    $lines += "set all_proxy=$ALL_PROXY_VAL"
    $lines += "set NO_PROXY=localhost,127.0.0.1,::1"
    $lines += "set no_proxy=localhost,127.0.0.1,::1"
}
$lines += "`"$NodePath`" `"$Script`" >> `"$LogFile`" 2>&1"

$WrapperBat = Join-Path $env:APPDATA "codex-gateway\run.bat"
Set-Content -Path $WrapperBat -Value ($lines -join "`r`n") -Encoding ASCII

# VBScript launcher — runs the bat silently with no visible window
$WrapperVbs = Join-Path $env:APPDATA "codex-gateway\run.vbs"
$vbsContent  = "CreateObject(`"WScript.Shell`").Run `"`"`"$WrapperBat`"`"`", 0, False"
Set-Content -Path $WrapperVbs -Value $vbsContent -Encoding ASCII

# ── register Task Scheduler job ───────────────────────────────────────────────

# Remove old task if it exists (ignore error if not found)
try { $null = schtasks /delete /tn $TaskName /f 2>&1 } catch {}

# Create: trigger = ONLOGON, run wscript (no window) as current user
$CurrentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$TrCommand   = "wscript.exe `"$WrapperVbs`""
$null = schtasks /create /tn $TaskName /tr $TrCommand /sc ONLOGON /ru $CurrentUser /rl HIGHEST /f 2>&1
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

if ($SyncDroid) {
    Write-Host ""
    Write-Host "  Syncing Droid models..." -ForegroundColor White
    $resolvedDroidBaseUrl = if ($DroidBaseUrl) { $DroidBaseUrl.TrimEnd("/") } else { "http://127.0.0.1:$PORT/v1" }
    $resolvedDroidApiKey = if ($DroidApiKey) { $DroidApiKey } else { "sk-codex-gateway" }
    $resolvedDroidProvider = if ($DroidProvider) { $DroidProvider } else { "generic-chat-completion-api" }
    $droidArgs = @(
        (Join-Path $RepoDir "scripts\install-droid-models.mjs"),
        "--base-url", $resolvedDroidBaseUrl,
        "--api-key", $resolvedDroidApiKey,
        "--provider", $resolvedDroidProvider
    )
    if ($SetDefaultDroid) {
        $droidArgs += "--set-default"
    }
    if ($NoDroidBackup) {
        $droidArgs += "--no-backup"
    }
    & $NodePath $droidArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Droid sync failed."
        exit $LASTEXITCODE
    }
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
