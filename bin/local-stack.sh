#!/bin/bash
# local-stack.sh — boot gx-backend + gx-admin-client locally, SAFELY, for dev e2e.
#
#   bin/local-stack.sh up --backend-cwd <path> [--admin-cwd <path>] [--backend-port 8000] [--no-admin]
#   bin/local-stack.sh down
#   bin/local-stack.sh status
#
# SAFETY (the whole point):
#  - Points the backend at the GX-debug cluster ($GX_E2E_DEBUG_DB_STRING from Friday's .env).
#  - HARD-BLOCKS production: aborts if the resolved DB_STRING looks like prod, if the
#    AWS Secret Manager resource is set (it would override our DB with prod secrets), or
#    if NODE_ENV=production.
#  - Blanks the dedicated outbound-comms senders (WhatsApp/push/calls/e-sign) so an
#    accidental flow can't message real users. (AWS creds are KEPT for S3/CloudFront
#    reads → SES email shares them and is a documented residual risk: don't exercise
#    email-send flows in e2e.)
#  - dotenv in gx-backend does NOT override vars already in the env, so these overrides win.
#
# Never run against Anmol's personal checkouts for write-flows — pass Friday's
# worktree paths (the code under test) as --backend-cwd / --admin-cwd.
set -euo pipefail

FRIDAY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$FRIDAY_ROOT/logs/e2e"
STATE_FILE="$STATE_DIR/stack.json"
mkdir -p "$STATE_DIR"

env_from_friday() { # read a var from Friday's .env if not already in env
  local name="$1"
  if [ -z "${!name:-}" ] && [ -f "$FRIDAY_ROOT/.env" ]; then
    grep -E "^$name=" "$FRIDAY_ROOT/.env" | head -1 | cut -d= -f2-
  else
    echo "${!name:-}"
  fi
}

redact_db() { sed -E 's#://[^@]*@#://***:***@#'; }

# ---- outbound-comms kill-list: blanked in the backend launch env ----
KILL_KEYS=(
  AISENSY_API_KEY
  CLEVERTAP_ACCOUNT_TOKEN
  EXOTEL_SID EXOTEL_TOKEN EXOTEL_USERNAME EXOTEL_PASSWORD
  BOLD_SIGN_API_KEY BOLD_SIGN_API_KEY_PROD
)

up() {
  local BACKEND_CWD="" ADMIN_CWD="" BACKEND_PORT="8000" RUN_ADMIN=1
  while [ $# -gt 0 ]; do
    case "$1" in
      --backend-cwd) BACKEND_CWD="$2"; shift 2;;
      --admin-cwd) ADMIN_CWD="$2"; shift 2;;
      --backend-port) BACKEND_PORT="$2"; shift 2;;
      --no-admin) RUN_ADMIN=0; shift;;
      *) echo "unknown arg: $1" >&2; exit 1;;
    esac
  done
  [ -n "$BACKEND_CWD" ] || { echo "Error: --backend-cwd required" >&2; exit 1; }
  [ -d "$BACKEND_CWD" ] || { echo "Error: backend cwd not found: $BACKEND_CWD" >&2; exit 1; }

  local DB_STRING; DB_STRING="$(env_from_friday GX_E2E_DEBUG_DB_STRING)"
  [ -n "$DB_STRING" ] || { echo "Error: GX_E2E_DEBUG_DB_STRING not set in $FRIDAY_ROOT/.env" >&2; exit 1; }

  # ---------- PROD GUARD ----------
  echo "▶ prod-guard: DB = $(echo "$DB_STRING" | redact_db)"
  if echo "$DB_STRING" | grep -qiE 'growthx-production|gx-prod-database'; then
    echo "✗ ABORT: DB_STRING looks like PRODUCTION. local-stack only runs against GX-debug." >&2
    exit 2
  fi
  if [ -n "${AWS_SECRET_MANAGER_RESOURCE_NAME:-}" ]; then
    echo "✗ ABORT: AWS_SECRET_MANAGER_RESOURCE_NAME is set — it would override the DB with prod secrets." >&2
    exit 2
  fi
  if [ "${NODE_ENV:-}" = "production" ]; then
    echo "✗ ABORT: NODE_ENV=production." >&2; exit 2
  fi
  echo "✓ prod-guard passed (GX-debug)"

  # ---------- port check ----------
  if lsof -iTCP:"$BACKEND_PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "✗ ABORT: port $BACKEND_PORT already in use. Free it or pass --backend-port." >&2; exit 1
  fi

  # ---------- local redis (best-effort) ----------
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    if ! docker ps --format '{{.Names}}' | grep -qx redis-instance; then
      echo "▶ starting local redis (docker)…"
      docker rm -f redis-instance >/dev/null 2>&1 || true
      docker run -d --name redis-instance -p 6379:6379 redis:latest >/dev/null && echo "✓ redis up on 6379"
    else
      echo "✓ redis-instance already running"
    fi
  else
    echo "⚠ docker not running — skipping redis. Redis-backed endpoints may error." >&2
  fi

  # ---------- ensure boot-critical assets exist ----------
  # gx-backend reads several assets via getAssetPath() at MODULE LOAD (e.g.
  # data/*.json are JSON.parsed at import) — but those files are .gitignored and
  # absent in a fresh clone, so the backend crashes before listening. Stub any
  # referenced-but-missing asset: valid `[]` for JSON, empty file otherwise.
  local ASSET_DIR="$BACKEND_CWD/apps/backend/assets"
  if [ -d "$BACKEND_CWD/apps/backend" ]; then
    local stubbed=0
    while IFS= read -r rel; do
      [ -n "$rel" ] || continue
      local target="$ASSET_DIR/$rel"
      [ -f "$target" ] && continue
      mkdir -p "$(dirname "$target")"
      case "$rel" in *.json) printf '[]' > "$target";; *) : > "$target";; esac
      stubbed=$((stubbed+1))
    done < <(grep -rhoE "getAssetPath\(['\"][^'\"]+['\"]\)" "$BACKEND_CWD/apps/backend" 2>/dev/null \
              | sed -E "s/getAssetPath\(['\"]([^'\"]+)['\"]\)/\1/" | sort -u)
    [ "$stubbed" -gt 0 ] && echo "▶ stubbed $stubbed missing .gitignored asset(s) so boot can proceed"
  fi

  # ---------- boot backend ----------
  # Run the backend app's tsx directly (apps/backend `npm run dev` = `tsx watch app.ts`),
  # NOT the root `npm run backend` (turbo). Turbo 2.x defaults to STRICT env mode and
  # strips undeclared vars (DB_STRING, AWS_SECRET_MANAGER_RESOURCE_NAME, the kill-list)
  # from the task — which silently defeated these overrides and let the backend fall back
  # to the prod .env. Bypassing turbo gives the child full env inheritance. The
  # e2e-db-guard preload then fail-closes if any override still didn't make it through.
  local APP_DIR="$BACKEND_CWD/apps/backend"
  [ -d "$APP_DIR" ] || { echo "Error: apps/backend not found under $BACKEND_CWD" >&2; exit 1; }
  echo "▶ booting backend from $APP_DIR on :$BACKEND_PORT (direct tsx, no turbo)"
  local kill_env=(); for k in "${KILL_KEYS[@]}"; do kill_env+=("$k="); done
  (
    cd "$APP_DIR"
    env \
      NODE_OPTIONS="--require $FRIDAY_ROOT/bin/e2e-db-guard.cjs ${NODE_OPTIONS:-}" \
      DB_STRING="$DB_STRING" \
      PORT="$BACKEND_PORT" \
      NODE_ENV="local" \
      AWS_SECRET_MANAGER_RESOURCE_NAME="" \
      RABBITMQ_HOST="" \
      REDIS_HOST="localhost" REDIS_PORT="6379" REDIS_USERNAME="" REDIS_PASSWORD="" \
      "${kill_env[@]}" \
      npm run dev
  ) > "$STATE_DIR/backend.log" 2>&1 &
  local BACKEND_PID=$!
  echo "  backend pid=$BACKEND_PID  log=$STATE_DIR/backend.log"

  # Fast-fail: the e2e-db-guard preload prints a verdict within ~2s. If it rejected
  # the env (prod / stripped override), abort now instead of waiting out the health timeout.
  for _ in 1 2 3 4 5 6; do
    grep -q "E2E DB GUARD" "$STATE_DIR/backend.log" 2>/dev/null && break; sleep 0.5
  done
  if grep -q "refusing to boot" "$STATE_DIR/backend.log" 2>/dev/null; then
    echo "✗ ABORT: e2e DB guard rejected the env —"; grep "E2E DB GUARD" "$STATE_DIR/backend.log" | tail -1
    kill_tree "$BACKEND_PID"; kill_port "$BACKEND_PORT"; exit 2
  fi
  grep "✓ E2E DB GUARD" "$STATE_DIR/backend.log" 2>/dev/null | tail -1

  # ---------- boot admin ----------
  local ADMIN_PID="" ADMIN_PORT=3002 ENVBAK=""
  if [ "$RUN_ADMIN" = "1" ]; then
    [ -n "$ADMIN_CWD" ] && [ -d "$ADMIN_CWD" ] || { echo "Error: --admin-cwd required (or pass --no-admin)" >&2; kill "$BACKEND_PID" 2>/dev/null || true; exit 1; }
    echo "▶ pointing admin .env.local at http://localhost:$BACKEND_PORT"
    ENVBAK="$ADMIN_CWD/.env.local.local-stack-bak"
    cp "$ADMIN_CWD/.env.local" "$ENVBAK"
    # API_URL -> local backend. The backend mounts its router at /api/v1
    # (config/app.ts), and the admin's axios baseURL is API_URL + '/admin/...',
    # so the prefix MUST be included or every call 404s. COOKIE_DOMAIN -> empty
    # (host-only cookies on localhost, shared across :3002/:8000).
    { grep -vE '^(API_URL|COOKIE_DOMAIN)=' "$ENVBAK"; \
      echo "API_URL=http://localhost:$BACKEND_PORT/api/v1"; \
      echo "COOKIE_DOMAIN="; } > "$ADMIN_CWD/.env.local"
    echo "▶ booting admin from $ADMIN_CWD on :$ADMIN_PORT"
    ( cd "$ADMIN_CWD" && npm run dev ) > "$STATE_DIR/admin.log" 2>&1 &
    ADMIN_PID=$!
    echo "  admin pid=$ADMIN_PID  log=$STATE_DIR/admin.log"
  fi

  # ---------- state ----------
  jq -n --arg bp "$BACKEND_PID" --arg bport "$BACKEND_PORT" --arg bcwd "$BACKEND_CWD" \
        --arg ap "$ADMIN_PID" --arg aport "$ADMIN_PORT" --arg acwd "${ADMIN_CWD:-}" \
        --arg envbak "$ENVBAK" \
        '{backend:{pid:$bp,port:$bport,cwd:$bcwd}, admin:{pid:$ap,port:$aport,cwd:$acwd,envbak:$envbak}}' \
        > "$STATE_FILE"

  # ---------- health checks ----------
  wait_http "backend" "http://localhost:$BACKEND_PORT" 90 "$STATE_DIR/backend.log" || { echo "✗ backend did not come up" >&2; exit 1; }
  if [ "$RUN_ADMIN" = "1" ]; then
    wait_http "admin" "http://localhost:$ADMIN_PORT" 120 "$STATE_DIR/admin.log" || { echo "✗ admin did not come up" >&2; exit 1; }
  fi
  echo "✅ stack up. backend :$BACKEND_PORT  admin :$ADMIN_PORT"
  echo "   tear down with: bin/local-stack.sh down"
}

wait_http() { # name url timeout logfile
  local name="$1" url="$2" timeout="$3" logf="$4" i=0
  echo -n "▶ waiting for $name ($url) "
  while [ "$i" -lt "$timeout" ]; do
    if curl -s -o /dev/null -m 3 "$url" 2>/dev/null; then echo " ✓"; return 0; fi
    sleep 1; i=$((i+1)); [ $((i % 5)) -eq 0 ] && echo -n "."
  done
  echo " ✗ (timeout)"; echo "--- last log lines ($logf) ---" >&2; tail -20 "$logf" >&2 || true; return 1
}

kill_tree() { # recursively SIGTERM a pid and all descendants (npm→turbo→tsx→node, next dev workers)
  local pid="$1"; [ -n "$pid" ] || return 0
  local kids; kids=$(pgrep -P "$pid" 2>/dev/null || true)
  for k in $kids; do kill_tree "$k"; done
  kill "$pid" 2>/dev/null || true
}

kill_port() { # kill whatever LISTENs on a port — the reliable backstop for orphaned grandchildren
  local port="$1"; [ -n "$port" ] || return 0
  local pids; pids=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
  [ -n "$pids" ] && echo "$pids" | xargs kill 2>/dev/null && echo "  freed :$port" || true
}

down() {
  [ -f "$STATE_FILE" ] || { echo "no stack state — nothing to tear down"; return 0; }
  local BPID APID BPORT APORT ENVBAK ACWD
  BPID=$(jq -r '.backend.pid // empty' "$STATE_FILE")
  APID=$(jq -r '.admin.pid // empty' "$STATE_FILE")
  BPORT=$(jq -r '.backend.port // empty' "$STATE_FILE")
  APORT=$(jq -r '.admin.port // empty' "$STATE_FILE")
  ENVBAK=$(jq -r '.admin.envbak // empty' "$STATE_FILE")
  ACWD=$(jq -r '.admin.cwd // empty' "$STATE_FILE")
  for pid in "$BPID" "$APID"; do
    [ -n "$pid" ] && kill_tree "$pid" && echo "killed tree $pid" || true
  done
  # Backstop: free the ports regardless of how the tree was spawned.
  kill_port "$BPORT"
  [ -n "$APID" ] && kill_port "$APORT"
  if [ -n "$ENVBAK" ] && [ -f "$ENVBAK" ]; then
    mv "$ENVBAK" "$ACWD/.env.local" && echo "restored admin .env.local"
  fi
  rm -f "$STATE_FILE"
  echo "✓ stack down"
}

status() {
  [ -f "$STATE_FILE" ] || { echo "no stack running"; return 0; }
  cat "$STATE_FILE" | jq .
  local BPID APID
  BPID=$(jq -r '.backend.pid // empty' "$STATE_FILE")
  APID=$(jq -r '.admin.pid // empty' "$STATE_FILE")
  [ -n "$BPID" ] && (kill -0 "$BPID" 2>/dev/null && echo "backend pid $BPID: alive" || echo "backend pid $BPID: DEAD")
  [ -n "$APID" ] && (kill -0 "$APID" 2>/dev/null && echo "admin pid $APID: alive" || echo "admin pid $APID: DEAD")
}

case "${1:-}" in
  up) shift; up "$@";;
  down) down;;
  status) status;;
  *) echo "Usage: local-stack.sh {up --backend-cwd <path> [--admin-cwd <path>] [--backend-port 8000] [--no-admin] | down | status}" >&2; exit 1;;
esac
