#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OS="$(uname -s)"

case "$OS" in
  Linux)  exec bash "$SCRIPT_DIR/install-whisper-linux.sh" "$@" ;;
  Darwin) exec bash "$SCRIPT_DIR/install-whisper-macos.sh" "$@" ;;
  *)
    echo "ERROR: unsupported OS: $OS" >&2
    echo "Supported: Linux, Darwin (macOS)" >&2
    exit 1
    ;;
esac
