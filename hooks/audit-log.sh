#!/usr/bin/env bash
# PostToolUse hook — log tool usage
# Always exit 0 (non-blocking)

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | grep -o '"tool_name":"[^"]*"' | head -1 | cut -d'"' -f4)
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
THREAD="${SLACK_THREAD_TS:-unknown}"
LOG_DIR="$(dirname "$0")/../logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/tool-usage-$(date +%Y-%m-%d).log"

echo "$TIMESTAMP | thread=$THREAD | tool=$TOOL_NAME" >> "$LOG_FILE"
exit 0
