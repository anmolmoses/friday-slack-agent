/**
 * Dashboard bridge to the engram associative-memory engine.
 *
 * engram is a sibling package (./engram) with its OWN git repo. It uses
 * better-sqlite3, which does NOT load under Bun (Friday's runtime) — so we do
 * NOT import engram here. Instead we shell out to its compiled CLI under Node,
 * which speaks JSON: `graph`, `recall --trace`, `index`. This keeps engram the
 * single source of truth (no duplicated store/recall logic) and sidesteps the
 * runtime mismatch entirely.
 *
 * The dashboard DB is a derived cache built from Friday's own `memory/` dir,
 * stored at `.engram/dashboard.db`. Rebuild it via POST /api/engram/reindex.
 */

import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { log } from "../../logger.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const ENGRAM_DIR = path.join(REPO_ROOT, "engram");
const ENGRAM_CLI = path.join(ENGRAM_DIR, "dist", "cli.js");
const DASHBOARD_DB = path.join(REPO_ROOT, ".engram", "dashboard.db");
const MEMORY_DIR = path.join(REPO_ROOT, "memory");

interface CliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Run the engram node CLI with args. Never uses a shell, so args are safe. */
async function runEngram(args: string[], timeoutMs = 30_000): Promise<CliResult> {
  const proc = Bun.spawn(["node", ENGRAM_CLI, ...args], {
    cwd: ENGRAM_DIR,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => {
    try { proc.kill(); } catch { /* already gone */ }
  }, timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { ok: code === 0, stdout, stderr, code };
}

/** Common guard: engram must be built, and the dashboard DB must exist. */
function preflight(requireDb: boolean): Response | null {
  if (!existsSync(ENGRAM_CLI)) {
    return Response.json(
      { error: "engram not built", hint: "run `npm run build` in ./engram" },
      { status: 503 },
    );
  }
  if (requireDb && !existsSync(DASHBOARD_DB)) {
    return Response.json({ needsIndex: true, nodes: [], edges: [], stats: null }, { status: 200 });
  }
  return null;
}

// GET /api/engram/graph — the whole associative graph (nodes + edges + stats).
export async function handleEngramGraph(): Promise<Response> {
  const pre = preflight(true);
  if (pre) return pre;
  const r = await runEngram(["graph", "--db", DASHBOARD_DB]);
  if (!r.ok) {
    log.warn("engram", `graph failed: ${r.stderr.trim()}`);
    return Response.json({ error: "graph export failed", detail: r.stderr.trim() }, { status: 500 });
  }
  try {
    return new Response(r.stdout, { headers: { "content-type": "application/json" } });
  } catch {
    return Response.json({ error: "bad graph JSON" }, { status: 500 });
  }
}

// POST /api/engram/recall { query, k? } — recall + full activation trace.
export async function handleEngramRecall(req: Request): Promise<Response> {
  const pre = preflight(true);
  if (pre) return pre;

  let body: { query?: string; k?: number };
  try { body = await req.json(); }
  catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }
  const query = (body.query ?? "").trim();
  if (!query) return Response.json({ error: "query required" }, { status: 400 });

  // --reinforce: each dashboard recall Hebbian-strengthens the co-retrieved
  // edges, so repeating a query visibly thickens its synapses over time.
  const args = ["recall", query, "--db", DASHBOARD_DB, "--trace", "--json", "--reinforce"];
  if (body.k && Number.isFinite(body.k)) args.push("-k", String(Math.min(50, Math.max(1, body.k))));

  const r = await runEngram(args);
  if (!r.ok) {
    log.warn("engram", `recall failed: ${r.stderr.trim()}`);
    return Response.json({ error: "recall failed", detail: r.stderr.trim() }, { status: 500 });
  }
  return new Response(r.stdout, { headers: { "content-type": "application/json" } });
}

// POST /api/engram/dream — run a consolidation pass (cold-archive low-salience).
export async function handleEngramDream(req: Request): Promise<Response> {
  const pre = preflight(true);
  if (pre) return pre;
  let body: { capacity?: number } = {};
  try { body = await req.json(); } catch { /* capacity optional */ }
  const args = ["dream", "--db", DASHBOARD_DB, "--json"];
  if (body.capacity && Number.isFinite(body.capacity)) args.push("--capacity", String(Math.max(1, Math.floor(body.capacity))));
  const r = await runEngram(args);
  if (!r.ok) {
    log.warn("engram", `dream failed: ${r.stderr.trim()}`);
    return Response.json({ error: "dream failed", detail: r.stderr.trim() }, { status: 500 });
  }
  return new Response(r.stdout, { headers: { "content-type": "application/json" } });
}

// POST /api/engram/reindex — rebuild the dashboard DB from Friday's memory/ dir.
export async function handleEngramReindex(): Promise<Response> {
  const pre = preflight(false);
  if (pre) return pre;
  if (!existsSync(MEMORY_DIR)) {
    return Response.json({ error: "memory/ dir not found" }, { status: 404 });
  }
  // better-sqlite3 won't create the parent dir; ensure .engram/ exists first.
  mkdirSync(path.dirname(DASHBOARD_DB), { recursive: true });
  const r = await runEngram(["index", MEMORY_DIR, "--db", DASHBOARD_DB, "--fresh"], 120_000);
  if (!r.ok) {
    log.warn("engram", `reindex failed: ${r.stderr.trim()}`);
    return Response.json({ error: "reindex failed", detail: r.stderr.trim() }, { status: 500 });
  }
  log.info("engram", `dashboard DB reindexed: ${r.stdout.trim()}`);
  return Response.json({ ok: true, output: r.stdout.trim() });
}
