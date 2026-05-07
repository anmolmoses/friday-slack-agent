#!/usr/bin/env bash
# Reply to a Slack message (in its thread) by URL.
#
# Usage: slack-reply.sh [--as-user] <slack-message-url> <text>
#        echo "<text>" | slack-reply.sh [--as-user] <slack-message-url>
#
# By default posts as Friday (SLACK_BOT_TOKEN). Pass --as-user to post as
# the human (SLACK_USER_TOKEN, an xoxp-… token) — required when you want to
# *invoke* Friday from the terminal, since her event handler drops messages
# carrying her own bot_id as self-loop noise.
#
# Bot token is your-workspace. For exampleclub, this will fail — that workspace
# isn't wired for posting.

set -euo pipefail

AS_USER=false
if [ "${1:-}" = "--as-user" ]; then
  AS_USER=true
  shift
fi

URL="${1:-}"
TEXT="${2:-}"

if [ -z "$URL" ]; then
  echo "Usage: slack-reply.sh [--as-user] <slack-message-url> <text>" >&2
  exit 1
fi

if [ -z "$TEXT" ] && [ ! -t 0 ]; then
  TEXT="$(cat)"
fi

if [ -z "$TEXT" ]; then
  echo "Error: no reply text provided (pass as 2nd arg or via stdin)" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Load tokens from .env if not already in env.
if [ -z "${SLACK_BOT_TOKEN:-}" ] && [ -f "$REPO_ROOT/.env" ]; then
  SLACK_BOT_TOKEN="$(grep -E '^SLACK_BOT_TOKEN=' "$REPO_ROOT/.env" | head -1 | cut -d= -f2-)"
fi
if [ -z "${SLACK_USER_TOKEN:-}" ] && [ -f "$REPO_ROOT/.env" ]; then
  SLACK_USER_TOKEN="$(grep -E '^SLACK_USER_TOKEN=' "$REPO_ROOT/.env" | head -1 | cut -d= -f2-)"
fi

if $AS_USER; then
  if [ -z "${SLACK_USER_TOKEN:-}" ]; then
    echo "Error: --as-user requires SLACK_USER_TOKEN (xoxp-…) in env or .env" >&2
    exit 1
  fi
  POST_TOKEN="$SLACK_USER_TOKEN"
  IDENTITY="user"
else
  if [ -z "${SLACK_BOT_TOKEN:-}" ]; then
    echo "Error: SLACK_BOT_TOKEN not set and not found in .env" >&2
    exit 1
  fi
  POST_TOKEN="$SLACK_BOT_TOKEN"
  IDENTITY="bot"
fi

# Lookup-token: even when posting as user, channel-history lookup needs a
# token with channels:history. The bot has it; the user token may or may not.
LOOKUP_TOKEN="${SLACK_BOT_TOKEN:-$POST_TOKEN}"

parsed=$(python3 - "$URL" <<'PY'
import sys, re, urllib.parse
url = sys.argv[1]
m = re.match(r"https?://([^.]+)\.slack\.com/archives/([^/]+)/p(\d+)(?:\?(.*))?", url)
if not m:
    print("ERROR: not a Slack message URL", file=sys.stderr); sys.exit(2)
workspace, channel, pnum, query = m.groups()
ts = pnum[:-6] + "." + pnum[-6:]
thread_ts = ""
if query:
    q = urllib.parse.parse_qs(query)
    thread_ts = q.get("thread_ts", [""])[0]
print(workspace); print(channel); print(ts); print(thread_ts)
PY
)
WORKSPACE=$(echo "$parsed" | sed -n 1p)
CHANNEL=$(echo "$parsed" | sed -n 2p)
TS=$(echo "$parsed" | sed -n 3p)
THREAD_TS_QS=$(echo "$parsed" | sed -n 4p)

# Determine the thread root. If URL includes ?thread_ts=, use that.
# Else look up the message and see if it's already in a thread.
if [ -n "$THREAD_TS_QS" ]; then
  THREAD_ROOT="$THREAD_TS_QS"
else
  LOOKUP=$(curl -sS --max-time 15 -G "https://slack.com/api/conversations.history" \
    -H "Authorization: Bearer $LOOKUP_TOKEN" \
    --data-urlencode "channel=$CHANNEL" \
    --data-urlencode "oldest=$TS" \
    --data-urlencode "inclusive=true" \
    --data-urlencode "limit=1")
  MSG_THREAD=$(echo "$LOOKUP" | python3 -c '
import json,sys
d=json.load(sys.stdin)
if not d.get("ok"): print(""); sys.exit(0)
m=(d.get("messages") or [{}])[0]
print(m.get("thread_ts") or "")
')
  THREAD_ROOT="${MSG_THREAD:-$TS}"
fi

RESP=$(curl -sS --max-time 15 -X POST "https://slack.com/api/chat.postMessage" \
  -H "Authorization: Bearer $POST_TOKEN" \
  -H "Content-Type: application/json; charset=utf-8" \
  --data "$(python3 -c '
import json, sys
payload={"channel": sys.argv[1], "thread_ts": sys.argv[2], "text": sys.argv[3]}
print(json.dumps(payload))
' "$CHANNEL" "$THREAD_ROOT" "$TEXT")")

OK=$(echo "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("ok"))')
if [ "$OK" != "True" ] && [ "$OK" != "true" ]; then
  echo "Error posting reply: $RESP" >&2
  exit 1
fi
POSTED_TS=$(echo "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("ts",""))')
echo "Reply posted as $IDENTITY to thread $THREAD_ROOT in channel $CHANNEL (ts=$POSTED_TS)"
