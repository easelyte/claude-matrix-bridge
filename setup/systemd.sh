#!/usr/bin/env bash
set -euo pipefail
# Deprecated entry point. Use setup/service.sh.
echo "WARNING: setup/systemd.sh is deprecated; use setup/service.sh" >&2
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec bash "$SCRIPT_DIR/service.sh" "$@"
