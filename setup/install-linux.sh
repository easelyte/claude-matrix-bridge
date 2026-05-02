#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
SERVICE_USER="${SERVICE_USER:-$(whoami)}"

echo "=== Claude Matrix Bridge - Install ==="
echo "Repo: $REPO_DIR"
echo "User: $SERVICE_USER"
echo

# Install node dependencies
echo "Installing npm dependencies..."
cd "$REPO_DIR"
npm install

# Generate HMAC secret if .env doesn't exist
if [ ! -f "$REPO_DIR/.env" ]; then
  echo "Creating .env from .env.example..."
  cp "$REPO_DIR/.env.example" "$REPO_DIR/.env"
  HMAC=$(openssl rand -hex 32)
  sed -i "s/^HMAC_SECRET=$/HMAC_SECRET=$HMAC/" "$REPO_DIR/.env"
  echo "⚠️  Edit .env to set MATRIX_ACCESS_TOKEN, ALLOWED_USER_IDS, etc."
else
  echo ".env already exists, skipping."
fi

echo
echo "Done. Next steps:"
echo "  1. Edit .env with your settings (MATRIX_ACCESS_TOKEN, ALLOWED_USER_IDS)"
echo "  2. Run: sudo bash setup/service.sh"
