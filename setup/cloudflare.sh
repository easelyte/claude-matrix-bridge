#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OS="$(uname -s)"

case "$OS" in
  Darwin) exec bash "$SCRIPT_DIR/cloudflare-macos.sh" "$@" ;;
  *)
    echo "ERROR: setup/cloudflare.sh is currently implemented for macOS only." >&2
    echo "For Linux, use your existing infrastructure Cloudflare tunnel setup." >&2
    exit 1
    ;;
esac
