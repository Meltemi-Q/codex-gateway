#!/usr/bin/env bash
# codex-gateway setup script
# Installs codex-gateway as a system service (macOS launchd or Linux systemd).
# Usage: bash setup.sh [options]

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$REPO_DIR/index.mjs"

# ── helpers ─────────────────────────────────────────────────────────────────

bold() { printf '\033[1m%s\033[0m' "$*"; }
green() { printf '\033[32m%s\033[0m' "$*"; }
yellow() { printf '\033[33m%s\033[0m' "$*"; }
red() { printf '\033[31m%s\033[0m' "$*"; }
HAS_TTY=true
{ true </dev/tty; } 2>/dev/null || HAS_TTY=false
FORCE_DEFAULTS=false
SYNC_DROID=false
SET_DEFAULT_DROID=false
DROID_BACKUP=true
PORT_OVERRIDE=""
WORK_DIR_OVERRIDE=""
HTTPS_PROXY_OVERRIDE=""
DROID_BASE_URL_OVERRIDE=""
DROID_API_KEY_OVERRIDE=""
DROID_PROVIDER_OVERRIDE=""

usage() {
  cat <<'EOF'
Usage:
  bash setup.sh [options]

Options:
  --yes, --non-interactive    Use defaults / provided flags without prompts
  --port <port>               Listening port (default: 8319)
  --work-dir <path>           Working directory for codex (default: $HOME)
  --https-proxy <url>         HTTPS proxy to pass to the gateway service
  --sync-droid                Import codex-gateway models into Droid after setup
  --set-default-droid         Also set GPT-5.4 [Codex Gateway] as Droid default
  --droid-base-url <url>      Droid base URL override (default: http://127.0.0.1:<port>/v1)
  --droid-api-key <key>       Droid API key value to write (default: sk-codex-gateway)
  --droid-provider <name>     Droid provider value (default: generic-chat-completion-api)
  --no-droid-backup           Skip .bak backups before writing Droid config
  --help                      Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|--non-interactive)
      FORCE_DEFAULTS=true
      shift
      ;;
    --port)
      PORT_OVERRIDE="${2:-}"
      shift 2
      ;;
    --work-dir)
      WORK_DIR_OVERRIDE="${2:-}"
      shift 2
      ;;
    --https-proxy)
      HTTPS_PROXY_OVERRIDE="${2:-}"
      shift 2
      ;;
    --sync-droid)
      SYNC_DROID=true
      shift
      ;;
    --set-default-droid)
      SYNC_DROID=true
      SET_DEFAULT_DROID=true
      shift
      ;;
    --droid-base-url)
      DROID_BASE_URL_OVERRIDE="${2:-}"
      shift 2
      ;;
    --droid-api-key)
      DROID_API_KEY_OVERRIDE="${2:-}"
      shift 2
      ;;
    --droid-provider)
      DROID_PROVIDER_OVERRIDE="${2:-}"
      shift 2
      ;;
    --no-droid-backup)
      DROID_BACKUP=false
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "$(red 'Unknown option:') $1"
      echo
      usage
      exit 1
      ;;
  esac
done

ask() {
  local prompt="$1" default="$2" var="$3"
  if $FORCE_DEFAULTS; then
    eval "$var=\"$default\""
    printf '%s: %s (configured)\n' "$(bold "$prompt")" "$default"
  elif $HAS_TTY; then
    printf '%s [%s]: ' "$(bold "$prompt")" "$default"
    read -r input </dev/tty
    eval "$var=\"\${input:-$default}\""
  else
    eval "$var=\"$default\""
    printf '%s: %s (default)\n' "$(bold "$prompt")" "$default"
  fi
}
ask_optional() {
  local prompt="$1" var="$2" default="${3:-}"
  if $FORCE_DEFAULTS; then
    eval "$var=\"$default\""
    if [[ -n "$default" ]]; then
      printf '%s: %s (configured)\n' "$(bold "$prompt")" "$default"
    else
      printf '%s: (skipped)\n' "$(bold "$prompt")"
    fi
  elif $HAS_TTY; then
    printf '%s (leave blank to skip): ' "$(bold "$prompt")"
    read -r input </dev/tty
    eval "$var=\"$input\""
  else
    eval "$var=\"$default\""
    printf '%s: (skipped — no TTY)\n' "$(bold "$prompt")"
  fi
}

echo
echo "  $(bold 'codex-gateway') — setup wizard"
echo "  ─────────────────────────────────────"
echo

# ── detect OS ────────────────────────────────────────────────────────────────

OS="$(uname -s)"
if [[ "$OS" == "Darwin" ]]; then
  PLATFORM="macos"
elif [[ "$OS" == "Linux" ]]; then
  PLATFORM="linux"
else
  echo "$(red 'Unsupported OS:') $OS"; exit 1
fi
echo "  Platform: $(green "$PLATFORM")"

# ── detect Node ──────────────────────────────────────────────────────────────

NODE_PATH="$(command -v node 2>/dev/null || true)"
if [[ -z "$NODE_PATH" ]]; then
  echo "$(red 'Error:') node not found on PATH. Install Node.js 18+ first."; exit 1
fi
NODE_VERSION="$("$NODE_PATH" -e 'process.stdout.write(process.version)')"
echo "  Node:     $(green "$NODE_PATH") ($NODE_VERSION)"

# ── detect codex ─────────────────────────────────────────────────────────────

CODEX_DEFAULT=""
NODE_BIN_DIR="$(dirname "$NODE_PATH")"
for candidate in "$NODE_BIN_DIR/codex" /opt/homebrew/bin/codex /usr/local/bin/codex; do
  if [[ -x "$candidate" ]]; then CODEX_DEFAULT="$candidate"; break; fi
done
if [[ -z "$CODEX_DEFAULT" ]]; then
  CODEX_DEFAULT="$(command -v codex 2>/dev/null || true)"
fi
if [[ -z "$CODEX_DEFAULT" ]]; then
  echo
  echo "  $(red 'Error:') Codex CLI not found."
  echo
  echo "  Install it with:"
  echo "    npm install -g @openai/codex"
  echo
  echo "  Then log in:"
  echo "    codex login"
  echo
  echo "  Re-run this setup script after installation."
  exit 1
fi
echo "  Codex:    $(green "$CODEX_DEFAULT")"

# ── check codex login ─────────────────────────────────────────────────────────

CODEX_HOME_DEFAULT="$HOME/.codex"
AUTH_FILE="$CODEX_HOME_DEFAULT/auth.json"
if [[ -f "$AUTH_FILE" ]]; then
  echo "  Auth:     $(green "logged in ($AUTH_FILE)")"
else
  echo
  echo "  $(yellow 'Warning:') Codex CLI is not logged in yet."
  echo
  echo "  Please run:"
  echo "    codex login"
  echo
  echo "  Then re-run this setup script."
  echo
  if $HAS_TTY; then
    printf "  Continue anyway? [y/N]: "
    read -r confirm </dev/tty
    if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
      echo "  Aborted."
      exit 1
    fi
  else
    echo "  $(yellow 'Continuing with defaults (no TTY)...')"
  fi
fi

echo

# ── interactive prompts ───────────────────────────────────────────────────────

PORT_DEFAULT="${PORT_OVERRIDE:-8319}"
WORK_DIR_DEFAULT="${WORK_DIR_OVERRIDE:-$HOME}"
HTTPS_PROXY_DEFAULT="${HTTPS_PROXY_OVERRIDE:-}"

ask "Listening port" "$PORT_DEFAULT" PORT
ask "Working directory for codex" "$WORK_DIR_DEFAULT" WORK_DIR
ask_optional "HTTPS proxy (e.g. http://127.0.0.1:7890)" HTTPS_PROXY_VAL "$HTTPS_PROXY_DEFAULT"

echo

# ── service install ───────────────────────────────────────────────────────────

if [[ "$PLATFORM" == "macos" ]]; then
  PLIST_LABEL="com.codex-gateway"
  PLIST_FILE="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
  LOG_FILE="$HOME/Library/Logs/codex-gateway.log"
  mkdir -p "$(dirname "$PLIST_FILE")" "$(dirname "$LOG_FILE")"

  PROXY_BLOCK=""
  if [[ -n "$HTTPS_PROXY_VAL" ]]; then
    # derive HTTP_PROXY and ALL_PROXY from HTTPS_PROXY
    ALL_PROXY_VAL="${HTTPS_PROXY_VAL/http/socks5}"
    PROXY_BLOCK="
        <key>HTTPS_PROXY</key>
        <string>${HTTPS_PROXY_VAL}</string>
        <key>https_proxy</key>
        <string>${HTTPS_PROXY_VAL}</string>
        <key>HTTP_PROXY</key>
        <string>${HTTPS_PROXY_VAL}</string>
        <key>http_proxy</key>
        <string>${HTTPS_PROXY_VAL}</string>
        <key>ALL_PROXY</key>
        <string>${ALL_PROXY_VAL}</string>
        <key>all_proxy</key>
        <string>${ALL_PROXY_VAL}</string>
        <key>NO_PROXY</key>
        <string>localhost,127.0.0.1,::1</string>
        <key>no_proxy</key>
        <string>localhost,127.0.0.1,::1</string>"
  fi

  cat > "$PLIST_FILE" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>${SCRIPT}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PORT</key>
        <string>${PORT}</string>
        <key>WORK_DIR</key>
        <string>${WORK_DIR}</string>${PROXY_BLOCK}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${LOG_FILE}</string>
    <key>StandardErrorPath</key>
    <string>${LOG_FILE}</string>
</dict>
</plist>
PLIST

  # unload existing if any
  launchctl unload "$PLIST_FILE" 2>/dev/null || true
  launchctl load "$PLIST_FILE"
  echo "  $(green 'Installed:') $PLIST_FILE"
  echo "  $(green 'Started') as launchd service (auto-start on login)"
  echo "  Logs:   $LOG_FILE"

elif [[ "$PLATFORM" == "linux" ]]; then
  UNIT_FILE="/etc/systemd/system/codex-gateway.service"

  PROXY_ENV=""
  if [[ -n "$HTTPS_PROXY_VAL" ]]; then
    ALL_PROXY_VAL="${HTTPS_PROXY_VAL/http/socks5}"
    PROXY_ENV="
Environment=HTTPS_PROXY=${HTTPS_PROXY_VAL}
Environment=https_proxy=${HTTPS_PROXY_VAL}
Environment=HTTP_PROXY=${HTTPS_PROXY_VAL}
Environment=http_proxy=${HTTPS_PROXY_VAL}
Environment=ALL_PROXY=${ALL_PROXY_VAL}
Environment=all_proxy=${ALL_PROXY_VAL}
Environment=NO_PROXY=localhost,127.0.0.1,::1
Environment=no_proxy=localhost,127.0.0.1,::1"
  fi

  cat > "$UNIT_FILE" <<UNIT
[Unit]
Description=codex-gateway - OpenAI-compatible gateway for Codex CLI
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=${WORK_DIR}
ExecStart=${NODE_PATH} ${SCRIPT}
Environment=PORT=${PORT}
Environment=WORK_DIR=${WORK_DIR}
Environment=CODEX_HOME=${HOME}/.codex${PROXY_ENV}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable codex-gateway
  systemctl restart codex-gateway
  echo "  $(green 'Installed:') $UNIT_FILE"
  echo "  $(green 'Started') as systemd service (auto-start on boot)"
  echo "  Logs:   journalctl -u codex-gateway -f"
fi

if $SYNC_DROID; then
  echo
  echo "  $(bold 'Syncing Droid models...')"
  DROID_BASE_URL="${DROID_BASE_URL_OVERRIDE:-http://127.0.0.1:${PORT}/v1}"
  DROID_API_KEY="${DROID_API_KEY_OVERRIDE:-sk-codex-gateway}"
  DROID_PROVIDER="${DROID_PROVIDER_OVERRIDE:-generic-chat-completion-api}"
  DROID_ARGS=(
    "--base-url" "$DROID_BASE_URL"
    "--api-key" "$DROID_API_KEY"
    "--provider" "$DROID_PROVIDER"
  )
  if $SET_DEFAULT_DROID; then
    DROID_ARGS+=("--set-default")
  fi
  if ! $DROID_BACKUP; then
    DROID_ARGS+=("--no-backup")
  fi

  "$NODE_PATH" "$REPO_DIR/scripts/install-droid-models.mjs" "${DROID_ARGS[@]}"
fi

# ── done ─────────────────────────────────────────────────────────────────────

echo
echo "  $(bold '─────────────────────────────────────')"
echo "  $(green 'Setup complete!')"
echo
echo "  Gateway URL:  $(bold "http://127.0.0.1:${PORT}")"
echo
echo "  Quick test:"
echo "    curl http://127.0.0.1:${PORT}/v1/models"
echo
echo "  Chat completion:"
printf "    curl http://127.0.0.1:%s/v1/chat/completions \\\\\n" "$PORT"
echo "      -H 'Content-Type: application/json' \\"
echo "      -d '{\"model\":\"gpt-5.4\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}'"
echo
if [[ ! -f "$AUTH_FILE" ]]; then
  echo "  $(yellow 'Next step:') run '$(bold "codex login")' to authenticate"
  echo
fi
