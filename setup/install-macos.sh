#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
SERVICE_USER="${SERVICE_USER:-$(whoami)}"
BOT_BLOB="${BOT_BLOB:-}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --blob)
      BOT_BLOB="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: setup/install-macos.sh [--blob db1:...]"
      exit 0
      ;;
    *)
      echo "ERROR: unknown option: $1" >&2
      echo "Usage: setup/install-macos.sh [--blob db1:...]" >&2
      exit 64
      ;;
  esac
done

echo "=== Claude Matrix Bridge - Install (macOS) ==="
echo "Repo: $REPO_DIR"
echo "User: $SERVICE_USER"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node not found on PATH. Install Node.js 20+ (e.g. 'brew install node@20')." >&2
  exit 1
fi

echo "Installing npm dependencies..."
cd "$REPO_DIR"
npm install

if [ ! -f "$REPO_DIR/.env" ]; then
  echo "Creating .env from .env.example..."
  cp "$REPO_DIR/.env.example" "$REPO_DIR/.env"
  chmod 600 "$REPO_DIR/.env"
  HMAC=$(openssl rand -hex 32)
  # BSD sed requires an explicit empty backup-suffix argument after -i.
  sed -i '' "s/^HMAC_SECRET=$/HMAC_SECRET=$HMAC/" "$REPO_DIR/.env"
  sed -i '' "s|^DEFAULT_WORKDIR=.*$|DEFAULT_WORKDIR=$HOME|" "$REPO_DIR/.env"
  echo "⚠️  Edit .env to set MATRIX_ACCESS_TOKEN, ALLOWED_USER_IDS, etc."
else
  echo ".env already exists, skipping."
  chmod 600 "$REPO_DIR/.env"
fi

if [ -n "$BOT_BLOB" ]; then
  echo "Importing Matrix bot credentials blob into .env..."
  node "$SCRIPT_DIR/import-bot-blob.mjs" --env "$REPO_DIR/.env" "$BOT_BLOB"
fi

echo
echo "Done. Next steps:"
echo "  1. If you did not pass --blob, edit .env with MATRIX_ACCESS_TOKEN or imported bot creds."
echo "     To import later: node setup/import-bot-blob.mjs 'db1:...'"
echo "  2. Run: setup/service.sh                       # user-scoped LaunchAgent"
echo "     or: sudo SCOPE=system setup/service.sh      # system-wide LaunchDaemon"
