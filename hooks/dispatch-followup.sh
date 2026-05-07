#!/usr/bin/env bash
# Stop hook — fires after any Friday-owned Claude run finishes.
#
# Two modes, distinguished by env:
#   FRIDAY_DISPATCHED=1  — run started via bin/dispatch-claude.sh (long-lived
#                          tmux REPL). Posts the final assistant text +
#                          PR URLs back to the originating Slack thread,
#                          AND triggers memory extraction.
#   FRIDAY_SPAWNED=1     — Friday's per-message claude -p (src/claude/spawner).
#                          Slack post is handled by Friday's server onResponse,
#                          so we ONLY trigger memory extraction here.
#
# Always exits 0 — never block Claude's shutdown.

set -u

# Bail for foreground / non-Friday Claude sessions.
if [ "${FRIDAY_DISPATCHED:-}" != "1" ] && [ "${FRIDAY_SPAWNED:-}" != "1" ]; then
  exit 0
fi

# Sub-Claudes spawned from inside this hook (e.g. memory extraction) inherit
# the dispatch env. Without this fence their own Stop hook fires this script
# again, reads the wrong transcript, posts a bogus "no result text" message,
# and clobbers FRIDAY_DISPATCH_SESSION_ID_FILE. The fence is set on their
# spawn env below.
if [ "${FRIDAY_DISABLE_FOLLOWUP:-}" = "1" ]; then
  exit 0
fi

# Slack creds are only needed for the dispatched-followup post path.
# Memory extraction works without them.
IS_DISPATCH=0
if [ "${FRIDAY_DISPATCHED:-}" = "1" ] \
  && [ -n "${SLACK_BOT_TOKEN:-}" ] \
  && [ -n "${SLACK_CHANNEL:-}" ] \
  && [ -n "${SLACK_THREAD_TS:-}" ]; then
  IS_DISPATCH=1
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
# Guarded by IS_DISPATCH so memory-extraction sub-Claudes (which we already
# scrub the env of) can't clobber it even if the fence ever leaks.
if [ "$IS_DISPATCH" = "1" ] \
  && [ -n "${FRIDAY_DISPATCH_SESSION_ID_FILE:-}" ] \
  && [ -n "$CLAUDE_SESSION_ID" ]; then
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
# Only relevant for dispatched (long-lived REPL) runs. Spawned runs get a
# fresh transcript per process so there's nothing to dedupe.
COUNT_FILE=""
if [ "$IS_DISPATCH" = "1" ] && [ -n "${FRIDAY_DISPATCH_THREAD_SAFE:-}" ]; then
  COUNT_FILE="/tmp/friday-dispatch/${FRIDAY_DISPATCH_THREAD_SAFE}.assistantcount"
fi
PREV_COUNT=0
if [ -n "$COUNT_FILE" ] && [ -f "$COUNT_FILE" ]; then
  PREV_COUNT="$(cat "$COUNT_FILE" 2>/dev/null || echo 0)"
fi

FINAL_TEXT=""
CUR_COUNT=0
CUR_TEXT=""
if [ "$IS_DISPATCH" = "1" ]; then
  # Wait for the transcript to stabilize on the FINAL assistant text. The
  # JSONL is flushed incrementally — a single Claude turn can emit an interim
  # text block ("Now let me locate the upload card…"), then tool calls, then
  # the final answer. Breaking on the first count-bump would post the
  # interim text and miss the real reply (this is exactly how the
  # events/create upload-card bug-triage swallowed a 1648-char "I can't
  # reproduce without a screenshot" message in May 2026).
  #
  # Strategy: poll up to ~12s. We require BOTH (a) count > previous
  # watermark AND (b) two consecutive reads return the same
  # (count, last-text-hash) — i.e. the transcript stopped growing. Hard
  # cap fires the latest seen text even if it never stabilized, since the
  # alternative is silent loss.
  LAST_KEY=""
  STABLE_HITS=0
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24; do
    RAW="$(read_assistant_count_and_text "$TRANSCRIPT_PATH")"
    CUR_COUNT="$(printf "%s" "$RAW" | sed -n 1p)"
    CUR_TEXT="$(printf "%s\n" "$RAW" | sed -n '2,$p')"
    if [ -n "$CUR_COUNT" ] && [ "$CUR_COUNT" -gt "$PREV_COUNT" ] && [ -n "$CUR_TEXT" ]; then
      KEY="$CUR_COUNT:${#CUR_TEXT}:$(printf "%s" "$CUR_TEXT" | tail -c 80)"
      if [ "$KEY" = "$LAST_KEY" ]; then
        STABLE_HITS=$((STABLE_HITS + 1))
        if [ "$STABLE_HITS" -ge 1 ]; then
          FINAL_TEXT="$CUR_TEXT"
          break
        fi
      else
        STABLE_HITS=0
        LAST_KEY="$KEY"
      fi
    fi
    sleep 0.5
  done
  # Hard cap: if we have any new text but it never stabilized in 12s, post
  # whatever we last saw — better than dropping it.
  if [ -z "$FINAL_TEXT" ] && [ -n "$CUR_TEXT" ] && [ -n "$CUR_COUNT" ] && [ "$CUR_COUNT" -gt "$PREV_COUNT" ]; then
    FINAL_TEXT="$CUR_TEXT"
  fi
else
  # Spawned (per-message) run: Friday's server already posted the response.
  # We only need to know IF the transcript has any assistant text so the
  # memory-extraction gate can decide. One read, no polling, no watermark.
  RAW="$(read_assistant_count_and_text "$TRANSCRIPT_PATH")"
  CUR_COUNT="$(printf "%s" "$RAW" | sed -n 1p)"
  CUR_TEXT="$(printf "%s\n" "$RAW" | sed -n '2,$p')"
fi

# Save the watermark for the next turn — only if it advanced. A regression
# (e.g. wrong transcript path) would otherwise let stale earlier-turn text
# get re-posted.
if [ -n "$COUNT_FILE" ] && [ -n "$CUR_COUNT" ] && [ "$CUR_COUNT" -gt "$PREV_COUNT" ]; then
  printf "%s" "$CUR_COUNT" > "$COUNT_FILE"
fi

if [ "$IS_DISPATCH" = "1" ]; then
  # Friday returns these sentinels when she's already posted via the
  # friday-slack MCP and the final assistant text is purely a marker.
  # Mirrors src/slack/responder.ts:SKIP_REPLY_SENTINELS — keep them in sync.
  # Without this, the literal "NO_SLACK_MESSAGE" string ends up in Slack
  # right after her actual reply (a vibes channel thread, May 2026).
  SKIP_TEXT="$(printf "%s" "$FINAL_TEXT" \
    | sed -E 's/^[[:space:]*_`>]+|[[:space:]*_`.!]+$//g' \
    | tr '[:lower:]' '[:upper:]')"
  case "$SKIP_TEXT" in
    NO_SLACK_MESSAGE|NO_SLACK_REPLY|"[NO_REPLY]"|NO_REPLY)
      FINAL_TEXT=""
      ;;
  esac

  # Construct the originating thread URL for both the (suppressed) thread
  # post and the DM-to-the user path below.
  TS_NO_DOT="${SLACK_THREAD_TS/./}"
  THREAD_URL="https://your-workspace.slack.com/archives/$SLACK_CHANNEL/p$TS_NO_DOT"

  # Ask-the user sentinel routing — when the dispatched Claude wraps a
  # blocking question in <ask-owner>...</ask-owner> (or <cant-resolve>
  # or <needs-input>), the question is posted to BOTH the originating
  # Slack thread AND the user's DM. Per the user's 2026-06-08 directive: DM in
  # addition to the thread reply, not instead of it — a question that only
  # lands in a DM is too easy to miss, and the thread author often holds the
  # missing info. See feedback_dm-on-blocking-decisions.md.
  ASK_OWNER_USER="U_OWNER"
  SLACK_DM="$REPO_ROOT/bin/slack-dm.sh"
  ASK_QUESTION=""
  if printf "%s" "$FINAL_TEXT" | grep -qiE '<(ask-owner|cant-resolve|needs-input)>'; then
    # Extract the inner content. python is more reliable than sed for
    # multiline / case-insensitive tag matching.
    ASK_QUESTION="$(printf "%s" "$FINAL_TEXT" | python3 -c '
import re, sys
text = sys.stdin.read()
m = re.search(r"<(ask-owner|cant-resolve|needs-input)>(.*?)</\1>", text, re.DOTALL | re.IGNORECASE)
if m:
    sys.stdout.write(m.group(2).strip())
')"
  fi

  if [ -n "$ASK_QUESTION" ]; then
    # DM the user with the question + originating thread URL, AND post the
    # question into the originating thread (set MSG, which the post step
    # below uses). Thread + DM — neither path suppresses the other.
    DM_BODY="Dispatched Claude is blocked and needs your input.

Thread: $THREAD_URL
Job: ${FRIDAY_DISPATCH_JOB_ID:-unknown}
tmux: friday-thread-${FRIDAY_DISPATCH_THREAD_SAFE:-unknown}

Question:
$ASK_QUESTION

Reply here with the answer; relay it into the tmux session via bin/dispatch-claude.sh, or just paste directly into the live tmux pane."
    {
      printf "[followup] job=%s ASK-OWNER detected (%d chars) — DMing %s + posting to thread\n" \
        "${FRIDAY_DISPATCH_JOB_ID:-unknown}" "${#ASK_QUESTION}" "$ASK_OWNER_USER"
      if [ -x "$SLACK_DM" ]; then
        printf "%s" "$DM_BODY" | "$SLACK_DM" "$ASK_OWNER_USER" 2>&1 || true
      else
        printf "ERROR: %s not executable — DM skipped; thread post still happens\n" "$SLACK_DM"
      fi
      printf "[followup] dm done %s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    } >> "$LOG" 2>&1

    # Post the question to the originating thread too. MSG takes precedence
    # over FINAL_TEXT in the post step below.
    MSG="$ASK_QUESTION"
  fi

  # Scrape GitHub PR URLs that appeared anywhere in the transcript (assistant
  # text, tool inputs, tool outputs). The transcript JSONL is the most reliable
  # source — older versions used the run log file but that's gone now we run
  # claude in interactive mode without a tee.
  PR_URLS="$(grep -oE 'https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/pull/[0-9]+' "$TRANSCRIPT_PATH" 2>/dev/null | sort -u | head -3)"

  # Compose the message
  MSG="${MSG:-$FINAL_TEXT}"
  if [ -n "$PR_URLS" ]; then
    if [ -n "$MSG" ]; then
      MSG="$MSG"$'\n\nPRs:\n'"$PR_URLS"
    else
      MSG="PRs:"$'\n'"$PR_URLS"
    fi
  fi

  # Nothing new since the last followup — skip the Slack post. Memory
  # extraction below still runs (the run may have moved internal state
  # forward via tool work even if no new assistant text was produced).
  if [ -z "$MSG" ]; then
    printf "[followup] job=%s no new assistant text since watermark=%s — skipping post\n" \
      "${FRIDAY_DISPATCH_JOB_ID:-unknown}" "$PREV_COUNT" >> "$LOG" 2>&1
  else
    {
      printf "[followup] job=%s posting %d-char result to %s\n" \
        "${FRIDAY_DISPATCH_JOB_ID:-unknown}" "${#MSG}" "$THREAD_URL"
      printf "%s" "$MSG" | "$SLACK_REPLY" "$THREAD_URL" 2>&1 || true
      printf "[followup] done %s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    } >> "$LOG" 2>&1
  fi
fi

# Memory extraction: spawn a background `claude -p` to scan the transcript
# for durable learnings and write to Friday's auto-memory dir. Runs detached
# so it never blocks Claude's shutdown. Fires for BOTH dispatched and spawned
# Friday runs, so every Claude turn Friday owns has a chance to leave memory
# behind. Opt-out by setting FRIDAY_DISABLE_MEMORY_EXTRACT=1.
#
# Gate: only run if the transcript actually contains assistant text. Skips
# trivial/empty turns (and avoids burning a sub-Claude on transcripts that
# died before the model said anything).
TRANSCRIPT_HAS_TEXT=0
# Default empty/non-numeric to 0 so `-gt` doesn't blow up under `set -u`.
if [ -n "${CUR_COUNT:-}" ] && [ "$CUR_COUNT" -eq "$CUR_COUNT" ] 2>/dev/null && [ "$CUR_COUNT" -gt 0 ]; then
  TRANSCRIPT_HAS_TEXT=1
fi
if [ "${FRIDAY_DISABLE_MEMORY_EXTRACT:-0}" != "1" ] && [ "$TRANSCRIPT_HAS_TEXT" = "1" ]; then
  # Single source of truth: the repo's memory/ dir. Previously pointed at
  # $HOME/.claude/projects/-Users-anmol-Documents-GitHub-Friday/memory
  # which created a parallel tree that drifted from the repo (Friday wrote
  # daily notes to one place during main spawns and another during dispatch
  # extraction). Reconciled May 2026 — auto-memory copies were merged back
  # into the repo and the old dir is now read-only / informational.
  MEM_DIR="$REPO_ROOT/memory"
  # Job id for the log filename — dispatched runs have a real id, spawned
  # runs don't, so fall back to the Claude session id (stable, unique).
  JOB_TAG="${FRIDAY_DISPATCH_JOB_ID:-spawn-${CLAUDE_SESSION_ID:-unknown}}"
  EXTRACT_LOG_DIR="$REPO_ROOT/logs/dispatch"
  mkdir -p "$EXTRACT_LOG_DIR"
  EXTRACT_LOG="$EXTRACT_LOG_DIR/${JOB_TAG}.memory.log"
  EXTRACT_PROMPT="You are a memory-extraction sub-agent. A Friday-owned Claude run just finished. Read its transcript at: $TRANSCRIPT_PATH

Decide whether anything in this run is worth preserving as a durable memory entry for future Friday sessions. Apply STRICT criteria — most runs have nothing worth saving:

SAVE only if you find:
- feedback: the user/a teammate corrected the agent's approach in a way that should change future behavior, OR explicitly confirmed a non-obvious choice was right
- project: a non-obvious fact about ongoing work, deadlines, why-decisions that won't be derivable from code/git history
- reference: a pointer to where info lives in an external system (Linear board, dashboard, channel)

DO NOT save:
- code patterns, file paths, architecture (derivable from the repo)
- one-off bug fixes (the commit message already captures it)
- ephemeral state (current task progress, PR URLs, dispatch job IDs)
- restating what already exists in $MEM_DIR/MEMORY.md

If nothing meets the bar, print exactly: NO_MEMORY
Otherwise:
  1. Write a new file to $MEM_DIR/<type>_<short-kebab-name>.md with the standard frontmatter (name, description, type) and body. For feedback/project entries include **Why:** and **How to apply:** lines.
  2. Append a one-line index entry to $MEM_DIR/MEMORY.md: \`- [Title](file.md) — short hook\`
  3. Print exactly: SAVED <filename>

Be terse. Do not narrate. Do not write more than one memory file per run."

  CLAUDE_BIN="${CLAUDE_BIN:-$HOME/.local/bin/claude}"
  if [ ! -x "$CLAUDE_BIN" ]; then
    CLAUDE_BIN="$(command -v claude || true)"
  fi
  # CRITICAL: scrub all Friday env and set FRIDAY_DISABLE_FOLLOWUP=1 so this
  # child's own Stop hook short-circuits. Without the fence the child
  # re-enters dispatch-followup.sh, reads its own NO_MEMORY transcript,
  # posts a bogus "no result text" message to Slack, and clobbers
  # FRIDAY_DISPATCH_SESSION_ID_FILE — the root cause of the May 2026
  # events/create bug-triage where the real screenshot ask never reached
  # Slack. We also drop FRIDAY_SPAWNED so the spawned-run code path doesn't
  # spawn another memory-extraction child recursively.
  (
    cd /tmp
    unset FRIDAY_DISPATCHED FRIDAY_SPAWNED \
          FRIDAY_DISPATCH_JOB_ID FRIDAY_DISPATCH_LOG \
          FRIDAY_DISPATCH_THREAD_SAFE FRIDAY_DISPATCH_SESSION_ID_FILE \
          FRIDAY_SPAWN_CWD
    export FRIDAY_DISABLE_FOLLOWUP=1
    "$CLAUDE_BIN" -p "$EXTRACT_PROMPT" \
      --permission-mode bypassPermissions \
      --add-dir "$MEM_DIR" \
      --max-turns 8 \
      >> "$EXTRACT_LOG" 2>&1
  ) &
  EXTRACT_PID=$!
  disown $EXTRACT_PID 2>/dev/null || true
  # Log to dispatch log if we have one; otherwise fall back to a per-mode log.
  EXTRACT_LOG_TARGET="${LOG}"
  if [ "$IS_DISPATCH" != "1" ]; then
    EXTRACT_LOG_TARGET="$EXTRACT_LOG_DIR/spawn-followup.log"
  fi
  printf "[followup] memory extraction spawned mode=%s pid=%s log=%s transcript=%s\n" \
    "$([ "$IS_DISPATCH" = "1" ] && echo dispatch || echo spawn)" \
    "$EXTRACT_PID" "$EXTRACT_LOG" "$TRANSCRIPT_PATH" \
    >> "$EXTRACT_LOG_TARGET" 2>&1
fi

exit 0
