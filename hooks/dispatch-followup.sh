#!/usr/bin/env bash
# Stop hook — fires after a dispatched Claude run finishes.
#
# Only acts when the run was started via bin/dispatch-claude.sh (which sets
# FRIDAY_DISPATCHED=1). Reads the transcript, extracts the final assistant
# message + any new GitHub PR URLs, posts the followup to the originating
# Slack thread.
#
# Always exits 0 — never block Claude's shutdown.

set -u

# Only fire for dispatched runs. Friday's per-message turns finish via her
# server's onResponse, not this hook — bailing keeps those quiet.
if [ "${FRIDAY_DISPATCHED:-}" != "1" ]; then
  exit 0
fi

if [ -z "${SLACK_BOT_TOKEN:-}" ] || [ -z "${SLACK_CHANNEL:-}" ] || [ -z "${SLACK_THREAD_TS:-}" ]; then
  exit 0
fi

# Stop hook receives JSON on stdin: {session_id, transcript_path, hook_event_name, ...}
INPUT="$(cat || true)"
PARSED="$(printf "%s" "$INPUT" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    print(d.get("transcript_path") or "")
    print(d.get("session_id") or "")
except Exception:
    print("")
    print("")
')"
TRANSCRIPT_PATH="$(printf "%s" "$PARSED" | sed -n 1p)"
CLAUDE_SESSION_ID="$(printf "%s" "$PARSED" | sed -n 2p)"

if [ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ]; then
  exit 0
fi

# Persist the Claude session id keyed by Slack thread so the NEXT dispatch
# in the same thread can resume the conversation. dispatch-claude.sh sets
# FRIDAY_DISPATCH_SESSION_ID_FILE — only present on dispatched runs.
if [ -n "${FRIDAY_DISPATCH_SESSION_ID_FILE:-}" ] && [ -n "$CLAUDE_SESSION_ID" ]; then
  mkdir -p "$(dirname "$FRIDAY_DISPATCH_SESSION_ID_FILE")"
  printf "%s" "$CLAUDE_SESSION_ID" > "$FRIDAY_DISPATCH_SESSION_ID_FILE"
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SLACK_REPLY="$REPO_ROOT/bin/slack-reply.sh"
LOG="${FRIDAY_DISPATCH_LOG:-/tmp/friday-dispatch-followup.log}"

# Read the transcript and return:   <count>\n<last assistant text>
# `count` is the number of non-empty assistant text messages seen so far.
# `last` is the most recent one. Used together as a watermark: we want a
# count strictly greater than the previously-posted one, otherwise we may be
# racing the file flush after Claude's stop and would re-extract the prior
# turn's reply (we saw this in interactive REPL mode).
read_assistant_count_and_text() {
  python3 - "$1" <<'PY'
import json, sys
path = sys.argv[1]
count = 0
last = ""
try:
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except Exception:
                continue
            msg = ev.get("message")
            if isinstance(msg, dict) and msg.get("role") == "assistant":
                content = msg.get("content")
                if isinstance(content, list):
                    text = "".join(
                        c.get("text", "")
                        for c in content
                        if isinstance(c, dict) and c.get("type") == "text"
                    ).strip()
                    if text:
                        count += 1
                        last = text
except Exception:
    pass
print(count)
print(last)
PY
}

# Per-thread watermark: how many assistant messages have we already posted?
COUNT_FILE=""
if [ -n "${FRIDAY_DISPATCH_THREAD_SAFE:-}" ]; then
  COUNT_FILE="/tmp/friday-dispatch/${FRIDAY_DISPATCH_THREAD_SAFE}.assistantcount"
fi
PREV_COUNT=0
if [ -n "$COUNT_FILE" ] && [ -f "$COUNT_FILE" ]; then
  PREV_COUNT="$(cat "$COUNT_FILE" 2>/dev/null || echo 0)"
fi

FINAL_TEXT=""
CUR_COUNT=0
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  RAW="$(read_assistant_count_and_text "$TRANSCRIPT_PATH")"
  CUR_COUNT="$(printf "%s" "$RAW" | sed -n 1p)"
  CUR_TEXT="$(printf "%s\n" "$RAW" | sed -n '2,$p')"
  if [ -n "$CUR_COUNT" ] && [ "$CUR_COUNT" -gt "$PREV_COUNT" ] && [ -n "$CUR_TEXT" ]; then
    FINAL_TEXT="$CUR_TEXT"
    break
  fi
  sleep 0.5
done

# Save the watermark for the next turn.
if [ -n "$COUNT_FILE" ] && [ -n "$CUR_COUNT" ] && [ "$CUR_COUNT" -gt 0 ]; then
  printf "%s" "$CUR_COUNT" > "$COUNT_FILE"
fi

# Scrape GitHub PR URLs that appeared anywhere in the transcript (assistant
# text, tool inputs, tool outputs). The transcript JSONL is the most reliable
# source — older versions used the run log file but that's gone now we run
# claude in interactive mode without a tee.
PR_URLS="$(grep -oE 'https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/pull/[0-9]+' "$TRANSCRIPT_PATH" 2>/dev/null | sort -u | head -3)"

# Compose the message
MSG="$FINAL_TEXT"
if [ -n "$PR_URLS" ]; then
  if [ -n "$MSG" ]; then
    MSG="$MSG"$'\n\nPRs:\n'"$PR_URLS"
  else
    MSG="PRs:"$'\n'"$PR_URLS"
  fi
fi

if [ -z "$MSG" ]; then
  MSG="(dispatched job ${FRIDAY_DISPATCH_JOB_ID:-unknown} finished but produced no result text)"
fi

# Construct the slack-reply.sh URL form.
TS_NO_DOT="${SLACK_THREAD_TS/./}"
THREAD_URL="https://teamgrowthx.slack.com/archives/$SLACK_CHANNEL/p$TS_NO_DOT"

{
  printf "[followup] job=%s posting %d-char result to %s\n" \
    "${FRIDAY_DISPATCH_JOB_ID:-unknown}" "${#MSG}" "$THREAD_URL"
  printf "%s" "$MSG" | "$SLACK_REPLY" "$THREAD_URL" 2>&1 || true
  printf "[followup] done %s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >> "$LOG" 2>&1

exit 0
