#!/usr/bin/env bash
# codex-gateway setup script
# Installs codex-gateway as a system service (macOS launchd or Linux systemd).
# Usage: bash setup.sh

set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$REPO_DIR/index.mjs"

# ── helpers ─────────────────────────────────────────────────────────────────

bold() { printf '\033[1m%s\033[0m' "$*"; }
green() { printf '\033[32m%s\033[0m' "$*"; }
yellow() { printf '\033[33m%s\033[0m' "$*"; }
red() { printf '\033[31m%s\033[0m' "$*"; }
HAS_TTY=true
{ true </dev/tty; } 2>/dev/null || HAS_TTY=false

ask() {
  local prompt="$1" default="$2" var="$3"
  if $HAS_TTY; then
    printf '%s [%s]: ' "$(bold "$prompt")" "$default"
    read -r input </dev/tty
    eval "$var=\"\${input:-$default}\""
  else
    eval "$var=\"$default\""
    printf '%s: %s (default)\n' "$(bold "$prompt")" "$default"
  fi
}
ask_optional() {
  local prompt="$1" var="$2"
  if $HAS_TTY; then
    printf '%s (leave blank to skip): ' "$(bold "$prompt")"
    read -r input </dev/tty
    eval "$var=\"$input\""
  else
    eval "$var=\"\""
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

ask "Listening port" "8319" PORT
ask "Working directory for codex" "$HOME" WORK_DIR
ask_optional "HTTPS proxy (e.g. http://127.0.0.1:7890)" HTTPS_PROXY_VAL

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
        <key>HTTP_PROXY</key>
        <string>${HTTPS_PROXY_VAL}</string>
        <key>ALL_PROXY</key>
        <string>${ALL_PROXY_VAL}</string>
        <key>NO_PROXY</key>
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
Environment=HTTP_PROXY=${HTTPS_PROXY_VAL}
Environment=ALL_PROXY=${ALL_PROXY_VAL}
Environment=NO_PROXY=localhost,127.0.0.1,::1"
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
