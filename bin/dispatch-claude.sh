#!/usr/bin/env bash
# Per-Slack-thread persistent Claude Code REPL, backed by tmux.
#
# First call for a thread:  creates a tmux session, opens Terminal.app
#                            attached to it, and starts an interactive
#                            `claude` REPL inside the pane. The first prompt
#                            is pasted in.
# Subsequent calls:          tmux session + Terminal window are reused.
#                            The new prompt is pasted into the same live
#                            REPL — one continuous Claude conversation, full
#                            interactive UI visible throughout.
#
# Each Claude turn fires a Stop hook (hooks/dispatch-followup.sh, registered
# in ~/.claude/settings.json) which posts the final assistant text + any
# new GitHub PR URLs back to the originating Slack thread.
#
# Usage:
#   dispatch-claude.sh <cwd> <prompt>
#   echo "<prompt>" | dispatch-claude.sh <cwd>
#
# Required env (Friday's spawner sets these):
#   SLACK_BOT_TOKEN, SLACK_CHANNEL, SLACK_THREAD_TS

set -euo pipefail

CWD="${1:-}"
PROMPT="${2:-}"

if [ -z "$CWD" ]; then
  echo "Usage: dispatch-claude.sh <cwd> <prompt>" >&2
  exit 1
fi
if [ -z "$PROMPT" ] && [ ! -t 0 ]; then
  PROMPT="$(cat)"
fi
if [ -z "$PROMPT" ]; then
  echo "Error: no prompt provided" >&2
  exit 1
fi
if [ -z "${SLACK_BOT_TOKEN:-}" ] || [ -z "${SLACK_CHANNEL:-}" ] || [ -z "${SLACK_THREAD_TS:-}" ]; then
  echo "Error: SLACK_BOT_TOKEN, SLACK_CHANNEL, SLACK_THREAD_TS must be set" >&2
  exit 1
fi
if [ ! -d "$CWD" ]; then
  echo "Error: cwd does not exist: $CWD" >&2
  exit 1
fi

TMUX_BIN="${TMUX_BIN:-/opt/homebrew/bin/tmux}"
if ! command -v "$TMUX_BIN" >/dev/null 2>&1; then
  TMUX_BIN="$(command -v tmux || true)"
fi
if [ -z "$TMUX_BIN" ]; then
  echo "Error: tmux not found (brew install tmux)" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$REPO_ROOT/logs/dispatch"
STATE_DIR="/tmp/friday-dispatch"
mkdir -p "$LOG_DIR" "$STATE_DIR"

THREAD_SAFE="${SLACK_THREAD_TS//./-}"
TMUX_SESSION="friday-thread-$THREAD_SAFE"
SESSION_ID_FILE="$STATE_DIR/$THREAD_SAFE.sessionid"

JOB_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
LOG_FILE="$LOG_DIR/$JOB_ID.log"
PROMPT_FILE="$STATE_DIR/$THREAD_SAFE-$(date -u +%H%M%S%N || date -u +%H%M%S).prompt"
printf "%s" "$PROMPT" > "$PROMPT_FILE"

start_claude_in_pane() {
  # If we have a saved Claude session id from a prior tmux life (rare —
  # only if tmux was killed externally but state file survived), --resume
  # to recover the conversation. Otherwise fresh.
  local resume_arg=""
  if [ -s "$SESSION_ID_FILE" ]; then
    resume_arg=" --resume $(cat "$SESSION_ID_FILE")"
  fi
  "$TMUX_BIN" send-keys -t "$TMUX_SESSION" \
    "claude --permission-mode bypassPermissions${resume_arg}" Enter
  # Give the REPL ~2.5s to boot before pasting the prompt.
  sleep 2.5
}

paste_prompt() {
  local file="$1"
  local buf="friday-prompt-$JOB_ID"
  "$TMUX_BIN" load-buffer -b "$buf" "$file"
  # -p uses bracketed paste mode so multi-line prompts go in as one paste.
  # -d deletes the buffer after.
  "$TMUX_BIN" paste-buffer -b "$buf" -t "$TMUX_SESSION" -d -p
  # Bracketed-paste end-marker takes a beat to be processed by Claude's REPL;
  # without this sleep the immediately-following Enter gets eaten and the
  # user has to press Enter manually to submit.
  sleep 0.4
  "$TMUX_BIN" send-keys -t "$TMUX_SESSION" C-m
}

ensure_claude_alive() {
  local cur
  cur="$("$TMUX_BIN" list-panes -t "$TMUX_SESSION" -F "#{pane_current_command}" 2>/dev/null | head -1 || true)"
  case "$cur" in
    claude|*claude*|node|2.1.*|2.0.*)
      return 0
      ;;
    *)
      # Shell prompt back — REPL exited. Restart it.
      start_claude_in_pane
      ;;
  esac
}

if ! "$TMUX_BIN" has-session -t "$TMUX_SESSION" 2>/dev/null; then
  # First-time setup: create session + export env in the shell + open Terminal
  "$TMUX_BIN" new-session -d -s "$TMUX_SESSION" -c "$CWD" -x 220 -y 60

  "$TMUX_BIN" send-keys -t "$TMUX_SESSION" \
    "export FRIDAY_DISPATCHED=1" Enter \
    "export FRIDAY_DISPATCH_JOB_ID=$(printf %q "$JOB_ID")" Enter \
    "export FRIDAY_DISPATCH_LOG=$(printf %q "$LOG_FILE")" Enter \
    "export FRIDAY_DISPATCH_THREAD_SAFE=$(printf %q "$THREAD_SAFE")" Enter \
    "export FRIDAY_DISPATCH_SESSION_ID_FILE=$(printf %q "$SESSION_ID_FILE")" Enter \
    "export SLACK_BOT_TOKEN=$(printf %q "$SLACK_BOT_TOKEN")" Enter \
    "export SLACK_CHANNEL=$(printf %q "$SLACK_CHANNEL")" Enter \
    "export SLACK_THREAD_TS=$(printf %q "$SLACK_THREAD_TS")" Enter \
    "clear" Enter \
    "printf '\\033[1;35m═══ Friday — Slack thread $SLACK_THREAD_TS ═══\\033[0m\\n'" Enter \
    "printf 'Repo: %s\\n' $(printf %q "$CWD")" Enter \
    "printf '\\033[1;35m═══════════════════════════════════════════\\033[0m\\n\\n'" Enter

  start_claude_in_pane

  /usr/bin/osascript >/dev/null 2>&1 <<APPLESCRIPT || true
tell application "Terminal"
  activate
  do script "$TMUX_BIN attach-session -t $TMUX_SESSION"
end tell
APPLESCRIPT
else
  # Reuse existing session — just make sure claude REPL is still alive.
  ensure_claude_alive
fi

paste_prompt "$PROMPT_FILE"

echo "dispatched job=$JOB_ID tmux=$TMUX_SESSION mode=$([ -f "$SESSION_ID_FILE" ] && echo continued || echo new)"
