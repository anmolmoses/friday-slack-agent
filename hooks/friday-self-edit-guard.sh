#!/usr/bin/env bash
# PreToolUse hook — blocks non-owner Slack users from making Friday modify
# her own source code. Allows everything for the user (U_OWNER); allows
# everything for Claude sessions that aren't Friday-spawned (so this hook
# is a no-op in normal foreground coding sessions).
#
# Wire-up: registered as a PreToolUse hook in ~/.claude/settings.json.
#
# Hook protocol (Claude Code):
#   stdin   = JSON {tool_name, tool_input, ...}
#   exit 0  = allow
#   exit 2  = block (stderr message is shown to the model + the user)
#
# Allowed within Friday for any user: writes under memory/ and logs/ — those
# are part of Friday's normal protocol regardless of who invoked her.

set -u

OWNER_USER_ID="U_OWNER"
FRIDAY_ROOT="$HOME/Documents/GitHub/Friday"

# Only enforce for Friday-spawned subprocesses or Friday-dispatched sub-Claudes.
# Foreground coding sessions (no FRIDAY_* env) are unaffected.
if [ "${FRIDAY_SPAWNED:-}" != "1" ] && [ "${FRIDAY_DISPATCHED:-}" != "1" ]; then
  exit 0
fi

# the user has full access.
if [ "${SLACK_USER_ID:-}" = "$OWNER_USER_ID" ]; then
  exit 0
fi

INPUT="$(cat || true)"

PYTHON_BIN="${PYTHON_BIN:-/usr/bin/python3}"
if [ ! -x "$PYTHON_BIN" ]; then
  PYTHON_BIN="$(command -v python3 || true)"
fi
if [ -z "$PYTHON_BIN" ]; then
  # Fail closed — without a parser we can't safely evaluate the tool call.
  echo "Blocked: friday-self-edit-guard requires python3 but none was found in PATH or at /usr/bin/python3." >&2
  exit 2
fi

# Sentinel-delimited so an empty field doesn't collapse into the next one.
# `python3 -c` keeps stdin free for the JSON payload; using `python3 -` with
# a heredoc would feed both script and JSON into stdin and they'd collide.
PARSE_SCRIPT='
import json, sys
try:
    d = json.load(sys.stdin)
    tool = (d.get("tool_name") or "").strip()
    ti = d.get("tool_input") or {}
    fp = (ti.get("file_path") or ti.get("path") or ti.get("notebook_path") or "").strip()
    cmd = (ti.get("command") or "").strip()
    sys.stdout.write("FRIDAY_GUARD_OK\x1f" + tool + "\x1f" + fp + "\x1f" + cmd)
except Exception as e:
    sys.stdout.write("FRIDAY_GUARD_ERR\x1f" + type(e).__name__ + ": " + str(e))
'
PARSED="$(printf "%s" "$INPUT" | "$PYTHON_BIN" -c "$PARSE_SCRIPT")"

if [ "${PARSED%%$'\x1f'*}" != "FRIDAY_GUARD_OK" ]; then
  # Couldn't parse the hook input — fail closed.
  echo "Blocked: friday-self-edit-guard could not parse PreToolUse input. Detail: ${PARSED}" >&2
  exit 2
fi

# Strip the sentinel and split on \x1f
REST="${PARSED#FRIDAY_GUARD_OK$'\x1f'}"
TOOL="${REST%%$'\x1f'*}"
REST="${REST#*$'\x1f'}"
FILE_PATH="${REST%%$'\x1f'*}"
COMMAND="${REST#*$'\x1f'}"

# Returns 0 if path is under Friday and outside the always-allowed memory/logs.
is_protected_path() {
  local p="$1"
  case "$p" in
    "$FRIDAY_ROOT"/memory/*|"$FRIDAY_ROOT"/logs/*) return 1 ;;
    "$FRIDAY_ROOT"|"$FRIDAY_ROOT"/*) return 0 ;;
    *) return 1 ;;
  esac
}

block() {
  local why="$1"
  local who="${SLACK_USER_ID:-<none>}"
  echo "Blocked: only the user (U_OWNER) can mutate Friday's source code (${FRIDAY_ROOT}). Requester=${who}. ${why}" >&2
  echo "Friday's memory/ and logs/ subtrees are still writable for any user." >&2
  exit 2
}

case "$TOOL" in
  Edit|Write|MultiEdit|NotebookEdit)
    if [ -n "$FILE_PATH" ] && is_protected_path "$FILE_PATH"; then
      block "Tool=$TOOL file=$FILE_PATH"
    fi
    ;;
  Bash)
    [ -z "$COMMAND" ] && exit 0

    # 1. Any path mention to Friday's source. Extract every Friday path
    # token and check each one. If one is protected AND the command has a
    # write-y verb, block.
    MENTIONS="$(printf "%s" "$COMMAND" | grep -oE "${FRIDAY_ROOT}[^[:space:]\"';|&><]*" || true)"
    if [ -n "$MENTIONS" ]; then
      while IFS= read -r p; do
        [ -z "$p" ] && continue
        if is_protected_path "$p"; then
          if printf "%s" "$COMMAND" | grep -qE '(>>?[[:space:]]*"?'"$FRIDAY_ROOT"'|(^|[[:space:];|&])(rm|mv|cp|sed[[:space:]]+-i|tee|install|chmod|chown|ln|touch|mkdir|patch|dd)([[:space:]]|$)|git[[:space:]]+(apply|am|reset[[:space:]]+--hard|clean[[:space:]]+-f|checkout[[:space:]]+--))'; then
            block "Tool=Bash protected-path=$p"
          fi
        fi
      done <<< "$MENTIONS"
    fi

    # 2. `cd $HOME/Documents/GitHub/Friday && <git-write-or-shell-write>`
    if printf "%s" "$COMMAND" | grep -qE "(^|[[:space:]&;|])cd[[:space:]]+\"?${FRIDAY_ROOT}(/[^[:space:]\"']*)?\"?([[:space:]]|;|&|\$|/)"; then
      if printf "%s" "$COMMAND" | grep -qE 'git[[:space:]]+(commit|push|reset|rebase|merge|cherry-pick|apply|am|filter-branch|checkout[[:space:]]+--|clean[[:space:]]+-f)|>>?|(^|[[:space:];|&])(rm|mv|cp|sed[[:space:]]+-i|tee|chmod|chown|ln|touch|patch)([[:space:]]|$)'; then
        block "Tool=Bash cd-then-mutation"
      fi
    fi

    # 3. git -C <Friday> <write-op>
    if printf "%s" "$COMMAND" | grep -qE "git[[:space:]]+-C[[:space:]]+\"?${FRIDAY_ROOT}\"?[[:space:]]+(commit|push|reset|rebase|merge|cherry-pick|apply|am|filter-branch|checkout[[:space:]]+--|clean[[:space:]]+-f)"; then
      block "Tool=Bash git -C with write-op"
    fi

    # 4. Spawn cwd is Friday → relative-path writes (rm -rf src, sed -i foo.ts,
    # echo x > bar) target Friday's own files. Block any write verb. We're
    # strict here because we already know this is non-owner and the working
    # directory IS Friday.
    if [ -n "${FRIDAY_SPAWN_CWD:-}" ]; then
      case "$FRIDAY_SPAWN_CWD" in
        "$FRIDAY_ROOT"/memory|"$FRIDAY_ROOT"/memory/*|"$FRIDAY_ROOT"/logs|"$FRIDAY_ROOT"/logs/*) ;;
        "$FRIDAY_ROOT"|"$FRIDAY_ROOT"/*)
          if printf "%s" "$COMMAND" | grep -qE '(>>?|(^|[[:space:];|&])(rm|mv|cp|sed[[:space:]]+-i|tee|install|chmod|chown|ln|touch|patch|dd)([[:space:]]|$)|git[[:space:]]+(commit|push|reset|rebase|merge|cherry-pick|apply|am|filter-branch|checkout[[:space:]]+--|clean[[:space:]]+-f))'; then
            block "Tool=Bash cwd=$FRIDAY_SPAWN_CWD (Friday root) + write-verb"
          fi
          ;;
      esac
    fi
    ;;
esac

exit 0
