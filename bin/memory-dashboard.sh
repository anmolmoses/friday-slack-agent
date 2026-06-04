#!/usr/bin/env bash
# Launch the engram neuron-graph dashboard on Friday's live memory index.
# Usage:  bin/memory-dashboard.sh [port]
# Then open the printed http://127.0.0.1:<port> URL.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="$ROOT/.engram/dashboard.db"
PORT="${1:-7755}"

# Load OPENAI_API_KEY from .env so recall (which embeds the query) works.
# The graph itself renders without it; only the "recall" box needs embeddings.
if [ -f "$ROOT/.env" ]; then
  OPENAI_API_KEY="$(grep -E '^OPENAI_API_KEY=' "$ROOT/.env" | head -1 | cut -d= -f2- | tr -d '"'"'"'')"
  export OPENAI_API_KEY
fi

if [ ! -f "$DB" ]; then
  echo "No memory index at $DB yet — Friday builds it as it captures memories." >&2
  exit 1
fi

exec node "$ROOT/engram/dist/cli.js" dashboard \
  --db "$DB" \
  --provider openai --model text-embedding-3-small --dim 1536 \
  --port "$PORT"
