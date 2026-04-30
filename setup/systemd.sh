#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
SERVICE_USER="${SERVICE_USER:-${SUDO_USER:-$USER}}"
SERVICE_HOME="${SERVICE_HOME:-$(getent passwd "$SERVICE_USER" | cut -d: -f6)}"
NODE_BIN="${NODE_BIN:-$(which node)}"

if [ -z "$SERVICE_HOME" ]; then
  echo "Could not determine home directory for SERVICE_USER=$SERVICE_USER" >&2
  exit 1
fi

echo "=== Installing systemd services ==="
echo "Repo: $REPO_DIR"
echo "User: $SERVICE_USER"
echo "Home: $SERVICE_HOME"
echo "Node: $NODE_BIN"
echo

# Bridge service
cat > /etc/systemd/system/claude-matrix-bridge.service << EOF
[Unit]
Description=Claude Code Matrix Bridge
After=network.target docker.service

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$REPO_DIR
EnvironmentFile=$REPO_DIR/.env
ExecStart=$NODE_BIN $REPO_DIR/index.js
Restart=always
RestartSec=5
Environment=PATH=$SERVICE_HOME/.local/bin:$SERVICE_HOME/.claude/bin:/usr/local/bin:/usr/bin:/bin
Environment=ELECTRON_RUN_AS_NODE=

[Install]
WantedBy=multi-user.target
EOF

# Viewer service
cat > /etc/systemd/system/claude-matrix-file-viewer.service << EOF
[Unit]
Description=Code File Viewer for Matrix Bridge (signed URL file server)
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$REPO_DIR
EnvironmentFile=$REPO_DIR/.env
ExecStart=$NODE_BIN $REPO_DIR/viewer/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable claude-matrix-bridge claude-matrix-file-viewer
systemctl restart claude-matrix-bridge claude-matrix-file-viewer

echo
echo "✅ Services installed and started:"
systemctl status claude-matrix-bridge --no-pager -l | head -5
echo "---"
systemctl status claude-matrix-file-viewer --no-pager -l | head -5
