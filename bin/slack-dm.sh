#!/usr/bin/env bash
# DM a Slack user by user ID using the bot token.
# Usage: slack-dm.sh <user-id> <text>
#        echo "<text>" | slack-dm.sh <user-id>
# Requires: SLACK_BOT_TOKEN in env (or sourced from repo .env).
#
# Bot token is your-workspace. The bot must be installed in the workspace and
# have im:write scope. Slack resolves a user ID passed as `channel` to the
# user's DM channel automatically.

set -euo pipefail

USER_ID="${1:-}"
TEXT="${2:-}"

if [ -z "$USER_ID" ]; then
  echo "Usage: slack-dm.sh <user-id> <text>" >&2
  exit 1
fi

if [ -z "$TEXT" ] && [ ! -t 0 ]; then
  TEXT="$(cat)"
fi

if [ -z "$TEXT" ]; then
  echo "Error: no message text provided (pass as 2nd arg or via stdin)" >&2
  exit 1
fi

if [ -z "${SLACK_BOT_TOKEN:-}" ]; then
  REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
  if [ -f "$REPO_ROOT/.env" ]; then
    SLACK_BOT_TOKEN="$(grep -E '^SLACK_BOT_TOKEN=' "$REPO_ROOT/.env" | head -1 | cut -d= -f2-)"
  fi
fi

if [ -z "${SLACK_BOT_TOKEN:-}" ]; then
  echo "Error: SLACK_BOT_TOKEN not set and not found in .env" >&2
  exit 1
fi

RESP=$(curl -sS --max-time 15 -X POST "https://slack.com/api/chat.postMessage" \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H "Content-Type: application/json; charset=utf-8" \
  --data "$(python3 -c '
import json, sys
payload={"channel": sys.argv[1], "text": sys.argv[2]}
print(json.dumps(payload))
' "$USER_ID" "$TEXT")")

OK=$(echo "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("ok"))')
if [ "$OK" != "True" ] && [ "$OK" != "true" ]; then
  echo "Error posting DM: $RESP" >&2
  exit 1
fi
POSTED_TS=$(echo "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("ts",""))')
CHANNEL_ID=$(echo "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("channel",""))')
echo "DM posted to user $USER_ID (channel=$CHANNEL_ID, ts=$POSTED_TS)"
