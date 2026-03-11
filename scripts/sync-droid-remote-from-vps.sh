#!/usr/bin/env bash
set -euo pipefail

SSH_HOST="root@100.74.249.26"
GATEWAY_BASE_URL="http://100.74.249.26:8319/v1"
REMOTE_REPO_DIR="/root/codex-gateway"
SET_DEFAULT=1
EXTRA_ARGS=()

usage() {
  cat <<'EOF'
Sync local Droid config to a codex-gateway running on a remote VPS.

Run this script on the Mac where Droid is installed.

Usage:
  bash sync-droid-remote-from-vps.sh [options] [-- <extra install-droid-models args>]

Options:
  --ssh-host HOST        SSH target used to read the remote gateway config
                         (default: root@100.74.249.26)
  --base-url URL         Droid base URL to write
                         (default: http://100.74.249.26:8319/v1)
  --remote-repo-dir DIR  Remote codex-gateway repo dir
                         (default: /root/codex-gateway)
  --no-set-default       Do not set GPT-5.4 [Codex Gateway] as Droid default
  -h, --help             Show this help

Any args after "--" are forwarded to install-droid-models.mjs.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ssh-host)
      SSH_HOST="${2:?missing value for --ssh-host}"
      shift 2
      ;;
    --base-url)
      GATEWAY_BASE_URL="${2:?missing value for --base-url}"
      shift 2
      ;;
    --remote-repo-dir)
      REMOTE_REPO_DIR="${2:?missing value for --remote-repo-dir}"
      shift 2
      ;;
    --no-set-default)
      SET_DEFAULT=0
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --)
      shift
      EXTRA_ARGS+=("$@")
      break
      ;;
    *)
      EXTRA_ARGS+=("$1")
      shift
      ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "[remote-droid-sync] error: node is required on this Mac" >&2
  exit 1
fi

KEY_CMD="sed -n 's/^Environment=GATEWAY_API_KEY=//p' /etc/systemd/system/codex-gateway.service | tail -n 1"
REMOTE_SCRIPT_PATH="${REMOTE_REPO_DIR%/}/scripts/install-droid-models.mjs"

gateway_key="$(ssh "$SSH_HOST" "$KEY_CMD")"
if [[ -z "$gateway_key" ]]; then
  echo "[remote-droid-sync] error: could not read remote GATEWAY_API_KEY from $SSH_HOST" >&2
  exit 1
fi

node_args=(--base-url "$GATEWAY_BASE_URL")
if [[ "$SET_DEFAULT" -eq 1 ]]; then
  node_args+=(--set-default)
fi
if [[ ${#EXTRA_ARGS[@]} -gt 0 ]]; then
  node_args+=("${EXTRA_ARGS[@]}")
fi

echo "[remote-droid-sync] syncing Droid from $SSH_HOST"
echo "[remote-droid-sync] base_url => $GATEWAY_BASE_URL"
ssh "$SSH_HOST" "cat '$REMOTE_SCRIPT_PATH'" | DROID_API_KEY="$gateway_key" node - "${node_args[@]}"
