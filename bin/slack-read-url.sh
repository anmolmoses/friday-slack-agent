#!/usr/bin/env bash
# Read a Slack message (and thread replies, if any) by URL using the bot token.
# Usage: slack-read-url.sh <slack-message-url>
# Requires: SLACK_BOT_TOKEN in env (or sourced from .env in repo root).
#
# Bot token is for your-workspace.slack.com. For exampleclub.slack.com messages,
# use the slack-lookup skill instead (it uses a separate user token).

set -euo pipefail

URL="${1:-}"
if [ -z "$URL" ]; then
  echo "Usage: slack-read-url.sh <slack-message-url>" >&2
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

parsed=$(python3 - "$URL" <<'PY'
import sys, re, urllib.parse
url = sys.argv[1]
m = re.match(r"https?://([^.]+)\.slack\.com/archives/([^/]+)/p(\d+)(?:\?(.*))?", url)
if not m:
    print("ERROR: not a recognized Slack message URL", file=sys.stderr); sys.exit(2)
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
THREAD_TS=$(echo "$parsed" | sed -n 4p)

if [ "$WORKSPACE" != "your-workspace" ]; then
  echo "Warning: URL is for '$WORKSPACE.slack.com'. Bot token is for your-workspace — this call will likely fail with channel_not_found." >&2
fi

api() {
  local endpoint="$1"; shift
  curl -sS --max-time 15 -G "https://slack.com/api/$endpoint" \
    -H "Authorization: Bearer $SLACK_BOT_TOKEN" "$@"
}

resolve_user() {
  local uid="$1"
  [ -z "$uid" ] && { echo ""; return; }
  api users.info --data-urlencode "user=$uid" | python3 -c '
import json,sys
try:
  d=json.load(sys.stdin); u=d.get("user",{}) or {}; p=u.get("profile",{}) or {}
  print(p.get("real_name") or p.get("display_name") or u.get("name") or "?")
except Exception: print("?")
'
}

channel_name() {
  api conversations.info --data-urlencode "channel=$CHANNEL" | python3 -c '
import json,sys
try:
  d=json.load(sys.stdin); c=d.get("channel",{}) or {}
  print(c.get("name") or c.get("name_normalized") or "")
except Exception: print("")
'
}

print_message() {
  local ts="$1"
  api conversations.history \
    --data-urlencode "channel=$CHANNEL" \
    --data-urlencode "oldest=$ts" \
    --data-urlencode "inclusive=true" \
    --data-urlencode "limit=1" \
  | python3 -c '
import json,sys
d=json.load(sys.stdin)
if not d.get("ok"):
  print("__ERR__:" + d.get("error","unknown")); sys.exit(0)
msgs=d.get("messages",[]) or []
if not msgs:
  print("__ERR__:not_found"); sys.exit(0)
m=msgs[0]
print("__USER__:" + (m.get("user") or m.get("bot_id") or ""))
print("__TS__:" + (m.get("ts") or ""))
print("__THREAD__:" + (m.get("thread_ts") or ""))
print("__TEXT_START__")
print(m.get("text",""))
print("__TEXT_END__")
'
}

CNAME=$(channel_name)
echo "# Slack message"
echo "workspace: $WORKSPACE"
echo "channel:   ${CNAME:+#$CNAME }($CHANNEL)"
echo "url:       $URL"
echo

RAW=$(print_message "$TS")
if echo "$RAW" | grep -q '^__ERR__:'; then
  echo "Error reading message: $(echo "$RAW" | sed -n 's/^__ERR__://p')" >&2
  exit 1
fi
USER_ID=$(echo "$RAW" | sed -n 's/^__USER__://p')
MSG_THREAD=$(echo "$RAW" | sed -n 's/^__THREAD__://p')
AUTHOR=$(resolve_user "$USER_ID")

echo "from: $AUTHOR ($USER_ID)"
echo "ts:   $TS"
echo "---"
echo "$RAW" | awk '/^__TEXT_START__$/{f=1; next} /^__TEXT_END__$/{f=0} f'

# Follow thread if this is a thread root or reply
ROOT_TS="${THREAD_TS:-$MSG_THREAD}"
if [ -n "$ROOT_TS" ] && [ "$ROOT_TS" != "$TS" ]; then
  echo
  echo "(message is a reply in thread rooted at $ROOT_TS — fetching full thread)"
  ROOT_TS_FOR_REPLIES="$ROOT_TS"
elif [ -z "$THREAD_TS" ] && [ -z "$MSG_THREAD" ]; then
  ROOT_TS_FOR_REPLIES=""
else
  ROOT_TS_FOR_REPLIES="$TS"
fi

if [ -n "$ROOT_TS_FOR_REPLIES" ]; then
  echo
  echo "# Thread replies"
  api conversations.replies \
    --data-urlencode "channel=$CHANNEL" \
    --data-urlencode "ts=$ROOT_TS_FOR_REPLIES" \
  | python3 -c '
import json,sys
d=json.load(sys.stdin)
if not d.get("ok"):
  print("(error: " + d.get("error","unknown") + ")"); sys.exit(0)
msgs=d.get("messages",[]) or []
for m in msgs:
  uid=m.get("user") or m.get("bot_id") or ""
  ts=m.get("ts","")
  text=(m.get("text","") or "").replace("\n","\n    ")
  print(f"- [{ts}] <{uid}> {text}")
'
fi
