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

# ── Worktree isolation ───────────────────────────────────────────────────────
# Run the dispatched Claude in a per-thread git worktree so concurrent
# dispatches on the same repo never collide on branch / working-tree state
# (CLAUDE.md rule #5). Only engages when <cwd> is a clone ROOT inside
# friday-workspace (Friday's own clones) — never Anmol's personal checkouts,
# never an already-nested worktree, never a non-repo cwd (e.g. the Friday repo
# itself for Mongo/CSV tasks). Light + instant: raw `git worktree add`, env
# files copied, node_modules symlinked from the clone so typecheck/build work
# without a fresh install. MCPs already come via --mcp-config, so the heavy
# setup-worktree.sh (npm install + MCP migration) is intentionally skipped
# here to keep dispatch non-blocking. Opt out with FRIDAY_DISPATCH_NO_WORKTREE=1.
_link_node_modules() {
  local s="$1" t="$2"          # absolute src + dst node_modules paths
  [ -d "$s" ] || return 0
  [ -e "$t" ] && return 0
  mkdir -p "$(dirname "$t")" 2>/dev/null || true
  ln -s "$s" "$t" 2>/dev/null || true
}

_provision_worktree() {
  local src="$1" dst="$2"      # clone root, worktree dir
  # env files (root + apps/*) — quick copies, never fatal.
  ( shopt -s nullglob
    [ -f "$src/.envrc" ] && cp "$src/.envrc" "$dst/" 2>/dev/null || true
    for f in "$src"/.env*; do [ -f "$f" ] && cp "$f" "$dst/" 2>/dev/null || true; done
    for d in "$src"/apps/*/; do
      [ -d "$d" ] || continue
      app="$(basename "$d")"
      mkdir -p "$dst/apps/$app" 2>/dev/null || true
      for f in "$d".env* "$d"*.pem; do [ -f "$f" ] && cp "$f" "$dst/apps/$app/" 2>/dev/null || true; done
    done ) >/dev/null 2>&1 || true
  # node_modules — symlink from the clone (root + each workspace subdir) so
  # deps resolve without a per-worktree install.
  _link_node_modules "$src/node_modules" "$dst/node_modules"
  for d in "$src"/apps/*/ "$src"/packages/*/; do
    [ -d "${d}node_modules" ] || continue
    rel="${d#$src/}"
    _link_node_modules "${d}node_modules" "$dst/${rel}node_modules"
  done
}

# Echoes the cwd the dispatched Claude should actually run in (a worktree when
# applicable, else the input unchanged). All diagnostics go to stderr so stdout
# stays clean for capture.
_resolve_worktree_cwd() {
  local cwd="$1"
  [ "${FRIDAY_DISPATCH_NO_WORKTREE:-}" = "1" ] && { printf '%s' "$cwd"; return; }
  case "$cwd" in */.claude/worktrees/*) printf '%s' "$cwd"; return ;; esac   # already a worktree
  case "$cwd" in */friday-workspace/*) ;; *) printf '%s' "$cwd"; return ;; esac  # her clones only
  local top
  top="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || true)"
  [ -n "$top" ] && [ "$top" = "$cwd" ] || { printf '%s' "$cwd"; return; }   # must be the clone root

  # Match the session manager's naming EXACTLY (slack-<raw thread ts>, dot and
  # all) so Friday's own-spawn worktree and this dispatch worktree are the SAME
  # dir — no duplication, and the reaper/dashboard associate it with the session.
  local wt="$cwd/.claude/worktrees/slack-$SLACK_THREAD_TS"
  if [ ! -d "$wt" ]; then
    local branch="slack/$SLACK_THREAD_TS"
    # Base ref: origin/main, except gx-client-expo bases off origin/dev.
    local base="origin/main"
    case "$(basename "$cwd")" in gx-client-expo) base="origin/dev" ;; esac
    git -C "$cwd" fetch origin --prune >/dev/null 2>&1 || true
    # Three-case branch resolution (mirror setup-worktree.sh): reuse a local or
    # remote slack branch if present, else cut a fresh one off the base.
    if git -C "$cwd" rev-parse --verify --quiet "$branch" >/dev/null 2>&1; then
      git -C "$cwd" worktree add "$wt" "$branch" >/dev/null 2>&1 || { printf '%s' "$cwd"; return; }
    elif git -C "$cwd" rev-parse --verify --quiet "origin/$branch" >/dev/null 2>&1; then
      git -C "$cwd" worktree add -b "$branch" "$wt" "origin/$branch" >/dev/null 2>&1 || { printf '%s' "$cwd"; return; }
    else
      git -C "$cwd" worktree add --no-track -b "$branch" "$wt" "$base" >/dev/null 2>&1 \
        || git -C "$cwd" worktree add --no-track -b "$branch" "$wt" >/dev/null 2>&1 \
        || { printf '%s' "$cwd"; return; }
    fi
    _provision_worktree "$cwd" "$wt"
  fi
  printf '%s' "$wt"
}

# Per-thread MCP config — Friday's main spawn writes this via
# generateMcpConfig() in src/claude/mcp-config.ts. Without `--mcp-config`,
# the dispatched tmux Claude has no access to mongodb / friday-slack /
# friday-status MCPs and falls back to grep-and-bail on any bug that
# needs real data lookup. May 2026 cafeteria/recurring-event incident:
# UD reported a bug, dispatched Claude said "no MongoDB MCP available
# in this env" and bailed. Fix: pass the same per-thread config Friday
# uses, generating it inline if it doesn't exist yet (e.g. on a manual
# dispatch with no preceding main spawn).
MCP_DIR="/tmp/friday-mcp"
MCP_CONFIG="$MCP_DIR/$SLACK_THREAD_TS.json"
if [ ! -f "$MCP_CONFIG" ]; then
  BUN_BIN="${BUN_BIN:-$(command -v bun || true)}"
  if [ -n "$BUN_BIN" ]; then
    (
      cd "$REPO_ROOT"
      "$BUN_BIN" -e "import { generateMcpConfig } from './src/claude/mcp-config.ts'; generateMcpConfig('$SLACK_THREAD_TS');" 2>&1 \
        || echo "Warning: failed to generate MCP config for thread $SLACK_THREAD_TS — dispatched Claude will run without MCPs" >&2
    ) >/dev/null
  else
    echo "Warning: bun not found, can't generate MCP config — dispatched Claude will run without MCPs (mongodb/friday-slack/friday-status)" >&2
  fi
fi
MCP_ARG=""
if [ -f "$MCP_CONFIG" ]; then
  MCP_ARG=" --mcp-config $(printf %q "$MCP_CONFIG")"
fi

JOB_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
LOG_FILE="$LOG_DIR/$JOB_ID.log"
PROMPT_FILE="$STATE_DIR/$THREAD_SAFE-$(date -u +%H%M%S%N || date -u +%H%M%S).prompt"
printf "%s" "$PROMPT" > "$PROMPT_FILE"

wait_for_claude_ready() {
  # Poll the pane until Claude's REPL has finished booting. The
  # "bypass permissions on" footer is the last thing rendered, so its
  # appearance is a reliable readiness signal across welcome and --resume
  # screens. Time out at ~20s.
  local deadline=$(( $(date +%s) + 20 ))
  while [ $(date +%s) -lt $deadline ]; do
    local pane
    pane="$("$TMUX_BIN" capture-pane -t "$TMUX_SESSION" -p 2>/dev/null || true)"
    if printf '%s' "$pane" | grep -q "bypass permissions"; then
      return 0
    fi
    sleep 0.3
  done
  return 1
}

start_claude_in_pane() {
  # If we have a saved Claude session id from a prior tmux life (rare —
  # only if tmux was killed externally but state file survived), --resume
  # to recover the conversation. Otherwise fresh.
  local resume_arg=""
  if [ -s "$SESSION_ID_FILE" ]; then
    resume_arg=" --resume $(cat "$SESSION_ID_FILE")"
  fi
  "$TMUX_BIN" send-keys -t "$TMUX_SESSION" \
    "claude --permission-mode bypassPermissions${MCP_ARG}${resume_arg}" Enter
  if ! wait_for_claude_ready; then
    echo "Error: Claude REPL did not become ready within 20s in tmux session $TMUX_SESSION" >&2
    return 1
  fi
}

paste_prompt() {
  local file="$1"
  local buf="friday-prompt-$JOB_ID"
  # Marker for verifying the paste actually landed: first ~30 chars of the
  # prompt, whitespace-collapsed. Multi-line prompts get bracketed-pasted
  # by Claude as "[Pasted #N, +K lines]" which hides the literal text, so
  # we ALSO compare pane snapshots before/after as a fallback signal.
  local marker
  marker="$(head -c 400 "$file" | tr '\n\t' '  ' | tr -s ' ' | sed 's/^ *//' | head -c 30)"

  local attempt
  for attempt in 1 2 3; do
    local before
    before="$("$TMUX_BIN" capture-pane -t "$TMUX_SESSION" -p 2>/dev/null || true)"
    "$TMUX_BIN" load-buffer -b "$buf" "$file"
    # -p uses bracketed paste mode so multi-line prompts go in as one paste.
    # -d deletes the buffer after.
    "$TMUX_BIN" paste-buffer -b "$buf" -t "$TMUX_SESSION" -d -p
    # Bracketed-paste end-marker takes a beat to be processed by Claude's REPL;
    # without this sleep the immediately-following Enter gets eaten and the
    # prompt sits in the input buffer un-submitted (the dispatch returns OK
    # but Claude never starts working). 0.6s wasn't enough — 2026-05-11
    # incident: PR-758 review prompt sat un-submitted until manually resent.
    sleep 1.2
    local after
    after="$("$TMUX_BIN" capture-pane -t "$TMUX_SESSION" -p 2>/dev/null || true)"
    if printf '%s' "$after" | grep -qF "$marker" || [ "$before" != "$after" ]; then
      "$TMUX_BIN" send-keys -t "$TMUX_SESSION" C-m
      return 0
    fi
    echo "Warning: paste attempt $attempt did not land in $TMUX_SESSION; retrying" >&2
    sleep 0.8
  done

  echo "Error: prompt paste failed after 3 attempts in tmux session $TMUX_SESSION" >&2
  return 1
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
  # Resolve to a per-thread worktree at session birth only (an existing session
  # keeps whatever cwd it was created with, so live dispatches are undisturbed).
  ORIG_CWD="$CWD"
  CWD="$(_resolve_worktree_cwd "$CWD")"
  if [ "$CWD" != "$ORIG_CWD" ]; then
    echo "dispatch: isolated worktree -> $CWD (from $ORIG_CWD)" >&2
  fi

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
    "export SLACK_USER_ID=$(printf %q "${SLACK_USER_ID:-}")" Enter \
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
