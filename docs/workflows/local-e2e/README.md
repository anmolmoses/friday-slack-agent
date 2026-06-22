# Local dev e2e — gx-admin + gx-backend

Run both repos locally against **dev (GX-debug)**, drive the admin UI with
Playwright, and stream progress to a **#fridaytest** thread — so a change is
proven through the real UI before it's called done. Foundation for
client-next/mobile later.

**Operational runbook (the steps Friday follows):**
[`memory/runbooks/repos/local-e2e.md`](../../../memory/runbooks/repos/local-e2e.md).
This doc is the design/why.

## Pieces

| Piece | What it does |
|---|---|
| `bin/local-stack.sh` | Boots backend (`:8000`) + admin (`:3002`) safely; `up` / `down` / `status`. |
| `bin/e2e-report.sh` | Posts a #fridaytest thread + threaded updates + screenshots, bypassing the vibes 3-line lint. |
| `memory/runbooks/repos/local-e2e.md` | The procedure: boot → Playwright login → navigate → report → teardown. |
| `.env` (gitignored) | `GX_E2E_DEBUG_DB_STRING`, `GX_ADMIN_E2E_EMAIL/PASSWORD`. |

## Why it's built this way (safety)

`gx-backend/apps/backend/.env` line 48 is the **live prod Mongo**; the env also
carries prod third-party sender keys. Naively booting the backend could hit prod
data or message real users. So the launcher enforces **defense in depth**:

1. **Prod hard-guard** — aborts if the resolved `DB_STRING` matches
   `growthx-production`/`gx-prod-database`, if `AWS_SECRET_MANAGER_RESOURCE_NAME`
   is set (it would override our DB with prod secrets via `setSecretsInEnv`), or if
   `NODE_ENV=production`.
2. **Env-override wins** — `gx-backend`'s `configureDotenv()` uses `dotenv.config()`,
   which does **not** override vars already in the launch env. So the launcher's
   `DB_STRING=<GX-debug>`, `PORT`, `NODE_ENV=development`,
   `AWS_SECRET_MANAGER_RESOURCE_NAME=""`, `RABBITMQ_HOST=""` all take precedence over `.env`.
3. **Outbound-comms kill-list** — blanks AISENSY (WhatsApp), CleverTap (push),
   Exotel (calls), BoldSign (e-sign). AWS creds are **kept** (S3/CloudFront reads);
   SES email shares them → documented residual risk, so don't test email-send flows.

## How the two-port setup works

- Admin (Next 13) reads the backend base URL from `API_URL`, **inlined into the
  browser bundle at dev-server start** (`next.config.mjs` `env` block). The launcher
  rewrites the worktree's `.env.local` to `API_URL=http://localhost:8000` +
  `COOKIE_DOMAIN=` (empty) before `next dev`, and restores it on `down`.
- Login is **email+password** → `POST /admin/login`, setting `adminToken` (httpOnly)
  + `adminIsLoggedIn` cookies. Cookies are **host-only** (no Domain attr on localhost),
  so they're **port-agnostic** — shared across `:3002` and `:8000`. That's why the
  split-port local stack authenticates correctly.

## Defense in depth against the turbo trap

gx-backend is a turbo monorepo; **turbo 2.x strict env mode strips undeclared vars**
from the task. That silently defeated the `DB_STRING` / `AWS_SECRET_MANAGER_RESOURCE_NAME`
overrides on the first run — the backend booted against **prod** via the AWS secret manager
while the launcher *thought* it was on GX-debug. Two layers now prevent it:

1. **Bypass turbo** — the launcher runs the backend's own `tsx watch app.ts` directly from
   `apps/backend` (`npm run dev`), so the child inherits the full env. No turbo filtering.
2. **Fail-closed preload** — `bin/e2e-db-guard.cjs` is loaded via `NODE_OPTIONS=--require`
   and aborts the node process (exit 13) if `DB_STRING` is prod/missing or the secret-manager
   var survived. It runs *before* the app, so a stripped override fails closed, not open.

## Other gotchas the launcher handles

- **`/api/v1` router prefix** — admin `API_URL` must include it or every call 404s.
- **`NODE_ENV=local`** (not `development`) — required for the backend to allow `localhost` CORS.
- **Missing .gitignored assets** — `getAssetPath('data/*.json')` files are JSON.parsed at boot
  but absent in a clone; the launcher auto-stubs any referenced-but-missing asset.
- **Playwright profile** — `~/.friday/browser-profile` is root-owned by default; `chown` it to
  `anmol` once or the browser MCP can't start.

## Verified (full loop, end to end)

- Prod-guard aborts on a prod-looking DB (exit 2); e2e-db-guard fail-closes a stripped override.
- Backend boots against GX-debug (Mongo + Postgres connected) with secret-manager OFF.
- Playwright logs into the admin UI (`localhost:3002` → `/api/v1/admin/login`) and lands on the
  `/home` Super Admin Dashboard — screenshot posted to a #fridaytest thread, **zero prod writes**.
- `down` frees both ports (tree-kill + port-kill backstop) and restores admin `.env.local`.
- Clean first-try boot confirmed after removing stubs (auto-stub → guard → login 200).
