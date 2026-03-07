#!/usr/bin/env bash
# codex-gateway bootstrap installer
# Safe to run via curl | bash. Clones/updates the repo, then runs setup.sh.

set -euo pipefail

REPO_URL="${CODEX_GATEWAY_REPO_URL:-https://github.com/Meltemi-Q/codex-gateway.git}"
BRANCH="${CODEX_GATEWAY_BRANCH:-main}"
INSTALL_DIR="${CODEX_GATEWAY_DIR:-$HOME/codex-gateway}"
SETUP_ARGS=()

usage() {
  cat <<'EOF'
Usage:
  bash install.sh [bootstrap-options] [-- setup-options]

Bootstrap options:
  --dir <path>         Clone/update the repo into this directory (default: ~/codex-gateway)
  --repo-url <url>     Git remote to clone from
  --branch <name>      Git branch to install (default: main)
  --help               Show this help

Any other options are forwarded to setup.sh. Example:
  curl -fsSL https://raw.githubusercontent.com/Meltemi-Q/codex-gateway/main/install.sh | \
    bash -s -- --yes --sync-droid --set-default-droid
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)
      INSTALL_DIR="${2:-}"
      shift 2
      ;;
    --repo-url)
      REPO_URL="${2:-}"
      shift 2
      ;;
    --branch)
      BRANCH="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --)
      shift
      SETUP_ARGS+=("$@")
      break
      ;;
    *)
      SETUP_ARGS+=("$1")
      shift
      ;;
  esac
done

if ! command -v git >/dev/null 2>&1; then
  echo "Error: git not found on PATH. Install git first." >&2
  exit 1
fi

if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "Updating existing repo: $INSTALL_DIR"
  if [[ -n "$(git -C "$INSTALL_DIR" status --porcelain)" ]]; then
    echo "Repo has local changes; skipping git pull and using local checkout."
  else
    git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
  fi
elif [[ -e "$INSTALL_DIR" ]]; then
  echo "Error: install dir exists but is not a git repo: $INSTALL_DIR" >&2
  exit 1
else
  echo "Cloning repo into: $INSTALL_DIR"
  git clone --depth=1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

exec bash "$INSTALL_DIR/setup.sh" "${SETUP_ARGS[@]}"
