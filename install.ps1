# codex-gateway bootstrap installer for Windows
# Safe to run via:
#   powershell -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Meltemi-Q/codex-gateway/main/install.ps1))) -Yes -SyncDroid -SetDefaultDroid"

param(
    [string]$Dir = (Join-Path $env:USERPROFILE "codex-gateway"),
    [string]$RepoUrl = "https://github.com/Meltemi-Q/codex-gateway.git",
    [string]$Branch = "main",
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

function Show-Usage {
    @"
Usage:
  powershell -ExecutionPolicy Bypass -File install.ps1 [options]

Examples:
  powershell -ExecutionPolicy Bypass -File install.ps1 -Yes -SyncDroid -SetDefaultDroid

  powershell -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Meltemi-Q/codex-gateway/main/install.ps1))) -Yes -SyncDroid -SetDefaultDroid"

Options:
  -Dir <path>              Clone/update the repo into this directory (default: %USERPROFILE%\codex-gateway)
  -RepoUrl <url>           Git remote to clone from
  -Branch <name>           Git branch to install (default: main)
  -Yes                     Use defaults / provided flags without prompts
  -Port <port>             Listening port (forwarded to setup.ps1)
  -WorkDir <path>          Working directory for codex (forwarded to setup.ps1)
  -HttpsProxy <url>        HTTPS proxy (forwarded to setup.ps1)
  -SyncDroid              Import codex-gateway models into Droid after setup
  -SetDefaultDroid        Also set GPT-5.4 [Codex Gateway] as Droid default
  -DroidBaseUrl <url>      Droid base URL override
  -DroidApiKey <key>       Droid API key value to write
  -DroidProvider <name>    Droid provider value to write
  -NoDroidBackup           Skip .bak backups before writing Droid config
  -Help                    Show this help
"@
}

function Sync-CheckoutFromGit([string]$DestinationDir, [string]$RepoUrl, [string]$Branch) {
    $tempDir = Join-Path $env:TEMP ("codex-gateway-bootstrap-" + [guid]::NewGuid().ToString())
    try {
        & git clone --depth=1 --branch $Branch $RepoUrl $tempDir
        if ($LASTEXITCODE -ne 0) {
            exit $LASTEXITCODE
        }

        $items = Get-ChildItem -Force $tempDir | Where-Object { $_.Name -ne ".git" }
        foreach ($item in $items) {
            $target = Join-Path $DestinationDir $item.Name
            if (Test-Path $target) {
                Remove-Item -Recurse -Force $target
            }
            Copy-Item $item.FullName -Destination $target -Recurse -Force
        }
    } finally {
        if (Test-Path $tempDir) {
            Remove-Item -Recurse -Force $tempDir
        }
    }
}

if ($Help) {
    Show-Usage
    exit 0
}

$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCmd) {
    Write-Error "git not found on PATH. Install git first."
}

if (Test-Path (Join-Path $Dir ".git")) {
    Write-Host "Updating existing repo: $Dir" -ForegroundColor White
    $repoDirty = (& git -C $Dir status --porcelain)
    if ($repoDirty) {
        Write-Host "Repo has local changes; skipping git pull and using local checkout." -ForegroundColor Yellow
    } else {
        & git -C $Dir pull --ff-only origin $Branch
        if ($LASTEXITCODE -ne 0) {
            exit $LASTEXITCODE
        }
    }
} elseif (Test-Path $Dir) {
    $hasLocalCheckout = (Test-Path (Join-Path $Dir "setup.ps1")) -and (Test-Path (Join-Path $Dir "index.mjs"))
    $dirEntries = @(Get-ChildItem -Force -ErrorAction SilentlyContinue $Dir)
    if ($hasLocalCheckout) {
        Write-Host "Refreshing existing local checkout without git metadata: $Dir" -ForegroundColor Yellow
        Sync-CheckoutFromGit -DestinationDir $Dir -RepoUrl $RepoUrl -Branch $Branch
    } elseif ($dirEntries.Count -eq 0) {
        Write-Host "Cloning repo into existing empty directory: $Dir" -ForegroundColor White
        & git clone --depth=1 --branch $Branch $RepoUrl $Dir
        if ($LASTEXITCODE -ne 0) {
            exit $LASTEXITCODE
        }
    } else {
        Write-Error "Install dir exists but is not a git repo: $Dir"
    }
} else {
    Write-Host "Cloning repo into: $Dir" -ForegroundColor White
    & git clone --depth=1 --branch $Branch $RepoUrl $Dir
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

$setupScript = Join-Path $Dir "setup.ps1"
if (-not (Test-Path $setupScript)) {
    Write-Error "setup.ps1 not found in $Dir"
}

$setupArgs = @()
if ($Yes) { $setupArgs += "-Yes" }
if ($Port) { $setupArgs += @("-Port", $Port) }
if ($WorkDir) { $setupArgs += @("-WorkDir", $WorkDir) }
if ($HttpsProxy) { $setupArgs += @("-HttpsProxy", $HttpsProxy) }
if ($SyncDroid) { $setupArgs += "-SyncDroid" }
if ($SetDefaultDroid) { $setupArgs += "-SetDefaultDroid" }
if ($DroidBaseUrl) { $setupArgs += @("-DroidBaseUrl", $DroidBaseUrl) }
if ($DroidApiKey) { $setupArgs += @("-DroidApiKey", $DroidApiKey) }
if ($DroidProvider) { $setupArgs += @("-DroidProvider", $DroidProvider) }
if ($NoDroidBackup) { $setupArgs += "-NoDroidBackup" }

& powershell -ExecutionPolicy Bypass -File $setupScript @setupArgs
exit $LASTEXITCODE
