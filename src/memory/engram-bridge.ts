/**
 * Live bridge from Friday's turn loop to the engram associative-memory engine.
 *
 * Friday already walks into each turn with a static snapshot (MEMORY.md + recent
 * dailies, see claude/args.ts). This adds *associative* recall: given the
 * incoming message, pull the memories engram judges most relevant — including
 * ones that share no words with the message but sit a graph-edge away — and
 * inject them as an extra system-prompt block.
 *
 * engram uses better-sqlite3 (Node-only; won't load under Bun), so we shell out
 * to its compiled CLI under Node — the same bridge the dashboard uses, against
 * the same `.engram/dashboard.db`. Everything here fails soft: a missing build,
 * a missing index, a slow/erroring CLI → empty context, never a broken turn.
 *
 * OFF BY DEFAULT. Enable with ENGRAM_RECALL=1 so the live bot's prompt only
 * changes when explicitly opted in.
 */

import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { log } from "../logger.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const ENGRAM_DIR = path.join(REPO_ROOT, "engram");
const ENGRAM_CLI = path.join(ENGRAM_DIR, "dist", "cli.js");
const DB = path.join(REPO_ROOT, ".engram", "dashboard.db");
const MEMORY_DIR = path.join(REPO_ROOT, "memory");

export function engramRecallEnabled(): boolean {
  return process.env.ENGRAM_RECALL === "1";
}

function ready(): boolean {
  return existsSync(ENGRAM_CLI) && existsSync(DB);
}

interface RecallHit { content: string; source: string | null; why: string }

/**
 * Recall the memories most relevant to `query` and format them as a
 * system-prompt block. Returns "" when disabled, not built/indexed, or on any
 * failure — callers can inject it unconditionally.
 */
export async function recallContext(query: string, k = 5, timeoutMs = 8_000): Promise<string> {
  if (!engramRecallEnabled() || !ready() || !query.trim()) return "";
  try {
    const proc = Bun.spawn(
      ["node", ENGRAM_CLI, "recall", query, "--db", DB, "--associative", "--reinforce", "--mark-used", "-k", String(k), "--json"],
      { cwd: ENGRAM_DIR, stdout: "pipe", stderr: "pipe" },
    );
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, timeoutMs);
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(timer);
    if (code !== 0) return "";

    const hits = JSON.parse(out) as RecallHit[];
    if (!Array.isArray(hits) || hits.length === 0) return "";
    const lines = hits.map((h, i) => {
      const src = h.source ? ` (${h.source})` : "";
      return `${i + 1}. ${h.content.replace(/\s+/g, " ").trim().slice(0, 320)}${src}`;
    });
    return (
      `<associative-memory note="Recalled by engram for this message — related past context, ` +
      `including memories that share no keywords. Use if relevant; ignore if not.">\n` +
      `${lines.join("\n")}\n</associative-memory>`
    );
  } catch (err) {
    log.warn("engram", `recallContext failed: ${err}`);
    return "";
  }
}

/** Rebuild the engram index from Friday's memory/ dir. Fire-and-forget on boot. */
export async function reindexFriday(timeoutMs = 120_000): Promise<boolean> {
  return runIndex(["--fresh"], timeoutMs, "index refreshed");
}

/**
 * Incremental reindex — only embeds new/changed content (skips unchanged
 * chunks). Cheap enough to run after each auto-captured exchange so it's
 * recallable within seconds, even with a paid embedder.
 */
export async function reindexIncremental(timeoutMs = 60_000): Promise<boolean> {
  return runIndex(["--incremental"], timeoutMs, "incremental index");
}

async function runIndex(extraArgs: string[], timeoutMs: number, label: string): Promise<boolean> {
  if (!existsSync(ENGRAM_CLI) || !existsSync(MEMORY_DIR)) return false;
  try {
    mkdirSync(path.dirname(DB), { recursive: true });
    const proc = Bun.spawn(["node", ENGRAM_CLI, "index", MEMORY_DIR, "--db", DB, ...extraArgs], {
      cwd: ENGRAM_DIR, stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, timeoutMs);
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(timer);
    if (code === 0) { log.info("engram", `${label}: ${out.trim().split("\n")[0]}`); return true; }
    return false;
  } catch (err) {
    log.warn("engram", `${label} failed: ${err}`);
    return false;
  }
}
