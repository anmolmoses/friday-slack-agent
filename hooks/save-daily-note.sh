#!/usr/bin/env bash
# Stop hook — backup daily note entry
# Always exit 0

TIMESTAMP=$(date +"%H:%M")
TODAY=$(date +"%Y-%m-%d")
THREAD="${SLACK_THREAD_TS:-unknown}"
MEMORY_DIR="$(dirname "$0")/../memory"
DAILY_FILE="$MEMORY_DIR/daily/$TODAY.md"

mkdir -p "$MEMORY_DIR/daily"

# Only append if the file doesn't already have an entry for this thread in the last 5 minutes
if ! tail -5 "$DAILY_FILE" 2>/dev/null | grep -q "Thread $THREAD"; then
  echo "$TIMESTAMP — [Thread $THREAD] Session ended." >> "$DAILY_FILE"
fi

exit 0
