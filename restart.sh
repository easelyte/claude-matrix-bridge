#!/bin/bash
# Restart the claude-matrix-bridge.
# Kills any process holding the API port and any matching node processes.

cd "$(dirname "$0")"

PORT=9802

echo "Stopping existing bridge processes..."

# Kill by process pattern
pkill -f 'node.*claude-matrix-bridge/index\.js' 2>/dev/null || true

# Kill anything holding our port
PORT_PID=$(lsof -ti :$PORT 2>/dev/null)
if [ -n "$PORT_PID" ]; then
  echo "Killing process on port $PORT (PID: $PORT_PID)"
  kill $PORT_PID 2>/dev/null || true
fi

# Also kill any 'node index.js' started from this directory.
# lsof works on both Linux and macOS; /proc/$pid/cwd is Linux-only.
pgrep -f "node index.js" | while read pid; do
  PROC_CWD=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | awk '/^n/{print substr($0,2); exit}')
  if [ "$PROC_CWD" = "$(pwd)" ]; then
    echo "Killing bridge PID $pid (cwd match)"
    kill $pid 2>/dev/null || true
  fi
done

sleep 2

# Verify port is free
if lsof -ti :$PORT >/dev/null 2>&1; then
  echo "ERROR: Port $PORT still in use after cleanup"
  lsof -i :$PORT
  exit 1
fi

echo "Starting bridge..."
nohup node index.js > /tmp/claude-matrix-bridge.log 2>&1 &
NEW_PID=$!
sleep 1

if kill -0 $NEW_PID 2>/dev/null; then
  echo "Bridge started with PID: $NEW_PID"
  echo "Logs: /tmp/claude-matrix-bridge.log"
else
  echo "ERROR: Bridge failed to start. Check logs:"
  tail -20 /tmp/claude-matrix-bridge.log
  exit 1
fi
