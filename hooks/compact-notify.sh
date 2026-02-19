#!/bin/bash
# PreCompact hook — notifies the matrix bridge that compaction is starting
INPUT=$(cat)
SID=$(echo "$INPUT" | jq -r '.session_id // empty')
PORT="${MATRIX_BRIDGE_API_PORT:-${API_PORT:-9802}}"
curl -s -X POST "http://127.0.0.1:${PORT}/compact-start" \
  -H 'Content-Type: application/json' \
  -d "{\"session_id\":\"$SID\"}" > /dev/null
exit 0
