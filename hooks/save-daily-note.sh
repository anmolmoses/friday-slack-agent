#!/usr/bin/env bash
# Stop hook — backup daily note entry
# Only fires for Friday-spawned Claude sessions (identified by FRIDAY_SPAWNED=1).
# Sessions opened directly in this repo by the user are skipped so their
# activity doesn't pollute Friday's daily notes.
# Always exit 0

if [ "${FRIDAY_SPAWNED:-}" != "1" ]; then
  exit 0
fi

THREAD="${SLACK_THREAD_TS:-unknown}"
if [ "$THREAD" = "unknown" ]; then
  exit 0
fi

TIMESTAMP=$(date +"%H:%M")
TODAY=$(date +"%Y-%m-%d")
MEMORY_DIR="$(dirname "$0")/../memory"
DAILY_FILE="$MEMORY_DIR/daily/$TODAY.md"

mkdir -p "$MEMORY_DIR/daily"

if ! tail -5 "$DAILY_FILE" 2>/dev/null | grep -q "Thread $THREAD"; then
  echo "$TIMESTAMP — [Thread $THREAD] Session ended." >> "$DAILY_FILE"
fi

exit 0
