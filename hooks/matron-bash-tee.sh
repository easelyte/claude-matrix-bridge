#!/bin/bash
# PreToolUse hook for Bash commands - rewrites command to tee output to a log
# file via matron-tee. Only active when MATRON_BASH_TEE_ENABLED=1. Passes
# through (exit 0, empty stdout) on any unexpected input.
INPUT=$(cat)
ENABLED="${MATRON_BASH_TEE_ENABLED:-0}"
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
TUID=$(echo "$INPUT" | jq -r '.tool_use_id // empty' 2>/dev/null)

if [ "$ENABLED" != "1" ] || [ "$TOOL" != "Bash" ] || [ -z "$CMD" ] || [ -z "$TUID" ]; then
  exit 0
fi

# Defense-in-depth: tool_use_id is API-generated as `toolu_[A-Za-z0-9_]+`.
# Reject anything else to avoid path traversal or shell-metacharacter injection
# via the log path or rewritten command.
if [[ ! "$TUID" =~ ^toolu_[A-Za-z0-9_]+$ ]]; then
  exit 0
fi

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEE_BIN="$HOOK_DIR/matron-tee"
LOG_PATH="/tmp/matron-cmd-${TUID}.log"

QUOTED_CMD=$(echo "$INPUT" | jq -r '.tool_input.command | @sh')
NEW_CMD="$TEE_BIN $LOG_PATH -- bash -c $QUOTED_CMD"

jq -n --arg c "$NEW_CMD" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    updatedInput: { command: $c }
  }
}'
