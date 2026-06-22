// e2e-db-guard — node --require preload that runs BEFORE the gx-backend app code.
// It asserts the prod-safe launch env actually reached this process. This catches
// the class of bug where a wrapper (turbo strict-env mode, etc.) silently strips
// our DB_STRING / AWS_SECRET_MANAGER_RESOURCE_NAME overrides — which would let the
// backend fall back to the prod .env and pull prod secrets. Fail CLOSED.
//
// Wired by bin/local-stack.sh via NODE_OPTIONS="--require <this file>".
'use strict';

function die(msg) {
  console.error('\n\x1b[31m✗ E2E DB GUARD: ' + msg + ' — refusing to boot.\x1b[0m\n');
  process.exit(13);
}

const db = process.env.DB_STRING || '';
const secret = process.env.AWS_SECRET_MANAGER_RESOURCE_NAME;

// DB_STRING must be present in the env at startup (before dotenv runs). If a wrapper
// stripped it, it's empty/undefined here → fail closed rather than let dotenv load prod.
if (!db) die('DB_STRING is not in the process env (override stripped before node started?)');
if (/growthx-production|gx-prod-database/i.test(db)) die('DB_STRING points at PRODUCTION');

// Must be the empty string we set (not undefined-from-strip, not the prod .env value).
// If undefined, the override was stripped and dotenv will re-enable the prod secret pull.
if (secret === undefined) die('AWS_SECRET_MANAGER_RESOURCE_NAME override was stripped (undefined) — dotenv would re-enable the prod secret manager');
if (secret !== '') die('AWS_SECRET_MANAGER_RESOURCE_NAME is set (' + secret + ') — it would override DB_STRING with prod secrets');

console.error('\x1b[32m✓ E2E DB GUARD: DB=' + db.replace(/:\/\/[^@]*@/, '://***@') + ' · secret-manager OFF\x1b[0m');
