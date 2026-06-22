#!/bin/bash
# e2e-report.sh — stream local-e2e progress to a #fridaytest thread.
#
# Posts directly via the Slack Web API (SLACK_BOT_TOKEN), NOT through Friday's
# responder — so the vibes-channel 3-line lint never touches these reports.
#
# Usage:
#   bin/e2e-report.sh start  "<title>"            # creates a thread, prints its ts (the handle)
#   bin/e2e-report.sh update <ts> "<message>"     # threaded reply
#   bin/e2e-report.sh shot   <ts> <file> [caption]# upload a screenshot into the thread
#
# Channel: $FRIDAY_TEST_CHANNEL (default C0AUYJHK6UW = #fridaytest).
# Typical flow:
#   TS=$(bin/e2e-report.sh start "🧪 gx-admin e2e — event theme cards")
#   bin/e2e-report.sh update "$TS" "Booting stack against GX-debug…"
#   bin/e2e-report.sh shot   "$TS" /tmp/login.png "Logged in ✅"
set -euo pipefail

FRIDAY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Load SLACK_BOT_TOKEN (and channel default) from Friday's .env if not already set.
if [ -z "${SLACK_BOT_TOKEN:-}" ] && [ -f "$FRIDAY_ROOT/.env" ]; then
  SLACK_BOT_TOKEN="$(grep -E '^SLACK_BOT_TOKEN=' "$FRIDAY_ROOT/.env" | head -1 | cut -d= -f2-)"
fi
CHANNEL="${FRIDAY_TEST_CHANNEL:-C0AUYJHK6UW}"

if [ -z "${SLACK_BOT_TOKEN:-}" ]; then
  echo "Error: SLACK_BOT_TOKEN not set and not found in $FRIDAY_ROOT/.env" >&2
  exit 1
fi

post_message() {
  # $1 = text, $2 = thread_ts (optional). Echoes the message ts on success.
  local text="$1" thread_ts="${2:-}"
  local payload
  payload=$(jq -n --arg ch "$CHANNEL" --arg t "$text" --arg tt "$thread_ts" \
    '{channel:$ch, text:$t, unfurl_links:false, unfurl_media:false}
     + (if $tt == "" then {} else {thread_ts:$tt} end)')
  local resp
  resp=$(curl -s -X POST "https://slack.com/api/chat.postMessage" \
    -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
    -H "Content-Type: application/json; charset=utf-8" \
    --data "$payload")
  if [ "$(echo "$resp" | jq -r '.ok')" != "true" ]; then
    echo "Error posting message: $resp" >&2
    exit 1
  fi
  echo "$resp" | jq -r '.ts'
}

cmd="${1:-}"
case "$cmd" in
  start)
    [ -n "${2:-}" ] || { echo "Usage: e2e-report.sh start \"<title>\"" >&2; exit 1; }
    post_message "$2" ""
    ;;
  update)
    [ -n "${2:-}" ] && [ -n "${3:-}" ] || { echo "Usage: e2e-report.sh update <ts> \"<message>\"" >&2; exit 1; }
    post_message "$3" "$2" >/dev/null
    echo "ok"
    ;;
  shot)
    [ -n "${2:-}" ] && [ -n "${3:-}" ] || { echo "Usage: e2e-report.sh shot <ts> <file> [caption]" >&2; exit 1; }
    THREAD_TS="$2"; FILE_PATH="$3"; CAPTION="${4:-}"
    [ -f "$FILE_PATH" ] || { echo "Error: file not found: $FILE_PATH" >&2; exit 1; }
    SLACK_BOT_TOKEN="$SLACK_BOT_TOKEN" SLACK_CHANNEL="$CHANNEL" SLACK_THREAD_TS="$THREAD_TS" \
      "$FRIDAY_ROOT/bin/slack-upload.sh" "$FILE_PATH" "$CAPTION"
    ;;
  *)
    echo "Usage: e2e-report.sh {start \"<title>\" | update <ts> \"<msg>\" | shot <ts> <file> [caption]}" >&2
    exit 1
    ;;
esac
