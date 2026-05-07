#!/usr/bin/env bash
# Grep-based recall across memory/. Ranked by recency (newer files first).
# Usage: memory-search.sh <query> [--limit N] [--scope daily|runbooks|people|threads|all]
#
# Prints matches as: memory/<path>:<line>: <text>
# Caps to LIMIT (default 30) to keep output readable.

set -euo pipefail

QUERY=""
LIMIT=30
SCOPE="all"

while [ $# -gt 0 ]; do
  case "$1" in
    --limit) LIMIT="$2"; shift 2;;
    --scope) SCOPE="$2"; shift 2;;
    --help|-h)
      echo "Usage: memory-search.sh <query> [--limit N] [--scope daily|runbooks|people|threads|all]" >&2
      exit 0;;
    *)
      if [ -z "$QUERY" ]; then
        QUERY="$1"
      else
        QUERY="$QUERY $1"
      fi
      shift;;
  esac
done

if [ -z "$QUERY" ]; then
  echo "Usage: memory-search.sh <query> [--limit N] [--scope daily|runbooks|people|threads|all]" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MEMORY="$ROOT/memory"

case "$SCOPE" in
  daily) SEARCH_PATH="$MEMORY/daily";;
  runbooks) SEARCH_PATH="$MEMORY/runbooks";;
  people) SEARCH_PATH="$MEMORY/people";;
  threads) SEARCH_PATH="$MEMORY/threads";;
  all) SEARCH_PATH="$MEMORY";;
  *) echo "Unknown scope: $SCOPE" >&2; exit 1;;
esac

if [ ! -d "$SEARCH_PATH" ]; then
  echo "No such memory dir: $SEARCH_PATH" >&2
  exit 1
fi

# Walk files newest-first; grep each; stop once we've collected LIMIT lines.
printed=0
# Use find -print0 so paths with spaces survive; sort by mtime descending.
tmplist=$(mktemp)
trap "rm -f $tmplist" EXIT

# shellcheck disable=SC2016
find "$SEARCH_PATH" -type f \( -name "*.md" -o -name "*.json" \) -print0 \
  | xargs -0 stat -f '%m %N' 2>/dev/null \
  | sort -rn \
  | awk '{print substr($0, index($0, " ") + 1)}' > "$tmplist"

while IFS= read -r file; do
  # Emit matches with line numbers, prefixed by repo-relative path
  relpath="${file#"$ROOT"/}"
  while IFS= read -r match; do
    echo "$relpath:$match"
    printed=$((printed + 1))
    if [ "$printed" -ge "$LIMIT" ]; then
      exit 0
    fi
  done < <(grep -n -i -F -- "$QUERY" "$file" 2>/dev/null || true)
done < "$tmplist"
