#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
SCOPE="${SCOPE:-user}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "ERROR: node not found. Install Node.js 20+ (e.g. 'brew install node@20')." >&2
  exit 1
fi

if [ ! -f "$REPO_DIR/.env" ]; then
  echo "ERROR: $REPO_DIR/.env not found. Run setup/install.sh first." >&2
  exit 1
fi

case "$SCOPE" in
  user)
    PLIST_DIR="$HOME/Library/LaunchAgents"
    LOG_DIR="$HOME/Library/Logs"
    TARGET="gui/$(id -u)"
    ;;
  system)
    if [ "$(id -u)" -ne 0 ]; then
      echo "ERROR: SCOPE=system requires sudo." >&2
      echo "Re-run as: sudo SCOPE=system $0" >&2
      exit 1
    fi
    PLIST_DIR="/Library/LaunchDaemons"
    LOG_DIR="/var/log"
    TARGET="system"
    ;;
  *)
    echo "ERROR: SCOPE must be 'user' or 'system' (got: $SCOPE)" >&2
    exit 1
    ;;
esac

mkdir -p "$PLIST_DIR" "$LOG_DIR"

BRIDGE_LABEL="chat.matron.claude-matrix-bridge"
VIEWER_LABEL="chat.matron.claude-matrix-file-viewer"
BRIDGE_PLIST="$PLIST_DIR/$BRIDGE_LABEL.plist"
VIEWER_PLIST="$PLIST_DIR/$VIEWER_LABEL.plist"

echo "=== Installing launchd services ($SCOPE scope) ==="
echo "Repo: $REPO_DIR"
echo "Node: $NODE_BIN"
echo "Plist dir: $PLIST_DIR"
echo

# XML-escape a string for inclusion in plist string values.
xml_escape() {
  local s="$1"
  # bash 5.2 can treat & specially in ${var//pat/repl}; macOS bash 3.2
  # does not. Disabling the option where available gives one portable form.
  shopt -u patsub_replacement 2>/dev/null || true
  s="${s//&/&amp;}"
  s="${s//</&lt;}"
  s="${s//>/&gt;}"
  s="${s//\"/&quot;}"
  printf '%s' "$s"
}

# Read .env and emit plist <key>/<string> pairs for every non-empty,
# non-comment KEY=VALUE line. Strips surrounding quotes from VALUE.
emit_env_keys() {
  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) continue ;;
    esac
    case "$line" in
      *=*) ;;
      *) continue ;;
    esac
    key="${line%%=*}"
    val="${line#*=}"
    key="${key#"${key%%[![:space:]]*}"}"
    case "$key" in
      [A-Za-z_]*) ;;
      *) continue ;;
    esac
    case "$val" in
      \"*\") val="${val#\"}"; val="${val%\"}" ;;
      \'*\') val="${val#\'}"; val="${val%\'}" ;;
    esac
    [ -z "$val" ] && continue
    printf '    <key>%s</key>\n    <string>%s</string>\n' \
      "$(xml_escape "$key")" "$(xml_escape "$val")"
  done < "$REPO_DIR/.env"
}

write_plist() {
  local out="$1" label="$2" script="$3" stdout_log="$4"
  cat > "$out" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$label")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$NODE_BIN")</string>
    <string>$(xml_escape "$REPO_DIR/$script")</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$REPO_DIR")</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$stdout_log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$stdout_log")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(xml_escape "$HOME")/.local/bin:$(xml_escape "$HOME")/.claude/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
$(emit_env_keys)
  </dict>
</dict>
</plist>
EOF
  chmod 600 "$out"
  if ! plutil -lint "$out" >/dev/null; then
    echo "ERROR: generated plist failed plutil -lint: $out" >&2
    plutil -lint "$out" >&2 || true
    exit 1
  fi
}

reload_service() {
  local label="$1" plist="$2"
  launchctl bootout "$TARGET" "$plist" 2>/dev/null || launchctl bootout "$TARGET/$label" 2>/dev/null || true
  launchctl bootstrap "$TARGET" "$plist"
  launchctl enable "$TARGET/$label" || true
  launchctl kickstart -k "$TARGET/$label"
}

write_plist "$BRIDGE_PLIST" "$BRIDGE_LABEL" "index.js" "$LOG_DIR/claude-matrix-bridge.log"
write_plist "$VIEWER_PLIST" "$VIEWER_LABEL" "viewer/server.js" "$LOG_DIR/claude-matrix-file-viewer.log"

reload_service "$BRIDGE_LABEL" "$BRIDGE_PLIST"
reload_service "$VIEWER_LABEL" "$VIEWER_PLIST"

echo
echo "✅ Services installed and started ($SCOPE scope):"
echo "    Bridge plist:  $BRIDGE_PLIST"
echo "    Viewer plist:  $VIEWER_PLIST"
echo "    Bridge log:    $LOG_DIR/claude-matrix-bridge.log"
echo "    Viewer log:    $LOG_DIR/claude-matrix-file-viewer.log"
echo
echo "Lifecycle:"
echo "    Restart:   launchctl kickstart -k $TARGET/$BRIDGE_LABEL"
echo "    Stop:      launchctl kill TERM $TARGET/$BRIDGE_LABEL"
echo "    Status:    launchctl print $TARGET/$BRIDGE_LABEL | head -20"
echo "    Logs:      tail -f $LOG_DIR/claude-matrix-bridge.log"
echo "    Uninstall: launchctl bootout $TARGET/$BRIDGE_LABEL && rm $BRIDGE_PLIST"
echo "               launchctl bootout $TARGET/$VIEWER_LABEL && rm $VIEWER_PLIST"
echo
echo "Re-run setup/service.sh after editing .env to apply env changes."
