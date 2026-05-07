/**
 * Short-term decay (T2) — "fades unless it mattered."
 *
 * Captured short-term files age out on a half-life, but emotion stretches that
 * life: a felt memory survives far longer than neutral chatter (flashbulb
 * persistence). Anything recalled recently or already promoted to long-term is
 * always kept. Decayed files are ARCHIVED (moved to memory/.archive/, a dotdir
 * the corpus + engram walks skip) rather than deleted — they leave recall but
 * aren't lost.
 *
 * Pure decision core + thin IO shell, same shape as promote.ts / salience.ts.
 */

import { readdirSync, readFileSync, statSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { FRIDAY_ROOT, MEMORY_DIR } from "./paths.ts";
import { parseEmotionFrontmatter } from "./emotion.ts";
import { loadRecallStore } from "./recall.ts";

const CONV_ROOT = path.join(MEMORY_DIR, "conversations");
const ARCHIVE_ROOT = path.join(MEMORY_DIR, ".archive");

export const DEFAULT_DECAY = {
  halfLifeDays: 14,
  /** emotion multiplier: effectiveAge = ageDays / (1 + k·intensity). k=4 →
   *  intensity 1 lasts ~5× as long (~70d), intensity 0.5 ~3× (~42d). */
  k: 4,
  /** A recall within this many days pins the memory regardless of age. */
  recentDays: 7,
};

function clamp01(n: number): number {
  return !Number.isFinite(n) ? 0 : n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Age scaled down by emotional intensity — high emotion ⇒ slower decay. */
export function decayEffectiveAge(ageDays: number, emotionIntensity: number, k: number): number {
  return ageDays / (1 + k * clamp01(emotionIntensity));
}

export interface RetainInput {
  ageDays: number;
  emotionIntensity: number;
  recentlyRecalled: boolean;
  promoted: boolean;
}

/** Decide whether a short-term memory should be archived out of recall. */
export function shouldArchive(
  input: RetainInput,
  opts: { halfLifeDays: number; k: number } = DEFAULT_DECAY,
): boolean {
  if (input.promoted || input.recentlyRecalled) return false; // consolidated/active → keep
  return decayEffectiveAge(input.ageDays, input.emotionIntensity, opts.k) > opts.halfLifeDays;
}

/** Pull the `date:` field out of a file's frontmatter (epoch ms), or null. */
function frontmatterDateMs(content: string): number | null {
  const m = content.match(/^\s*date:\s*(.+?)\s*$/m);
  if (!m) return null;
  const ms = Date.parse(m[1]!.replace(/^["']|["']$/g, ""));
  return Number.isFinite(ms) ? ms : null;
}

function walkMd(dir: string, out: string[]): void {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const full = path.join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walkMd(full, out);
    else if (name.endsWith(".md")) out.push(full);
  }
}

export interface PruneOptions {
  root?: string;
  archiveRoot?: string;
  halfLifeDays?: number;
  k?: number;
  recentDays?: number;
  /** Epoch ms "now" — injectable for deterministic tests. */
  now?: number;
  dryRun?: boolean;
  /** Repo-relative paths recalled recently; built from the recall store if omitted. */
  recentlyRecalled?: Set<string>;
  /** Repo-relative paths already promoted; built from the recall store if omitted. */
  promoted?: Set<string>;
}

export interface PruneResult {
  scanned: number;
  archived: number;
  kept: number;
  archivedPaths: string[];
}

/**
 * Build the recently-recalled + promoted path sets from the recall store. A
 * file is "active" if ANY of its snippet entries is recent/promoted.
 */
function recallActivity(now: number, recentDays: number): { recent: Set<string>; promoted: Set<string> } {
  const recent = new Set<string>();
  const promoted = new Set<string>();
  const store = loadRecallStore();
  const cutoff = now - recentDays * 24 * 3600 * 1000;
  for (const entry of Object.values(store.entries)) {
    if (entry.promotedAt) promoted.add(entry.path);
    const last = Date.parse(entry.lastRecalledAt);
    if (Number.isFinite(last) && last >= cutoff) recent.add(entry.path);
  }
  return { recent, promoted };
}

/**
 * Walk short-term conversation files and archive those that have decayed.
 * IO shell — the keep/drop call lives in shouldArchive.
 */
export function pruneShortTerm(opts: PruneOptions = {}): PruneResult {
  const root = opts.root ?? CONV_ROOT;
  const archiveRoot = opts.archiveRoot ?? ARCHIVE_ROOT;
  const halfLifeDays = opts.halfLifeDays ?? DEFAULT_DECAY.halfLifeDays;
  const k = opts.k ?? DEFAULT_DECAY.k;
  const recentDays = opts.recentDays ?? DEFAULT_DECAY.recentDays;
  const now = opts.now ?? Date.now();

  const activity = (opts.recentlyRecalled && opts.promoted)
    ? { recent: opts.recentlyRecalled, promoted: opts.promoted }
    : recallActivity(now, recentDays);
  const recent = opts.recentlyRecalled ?? activity.recent;
  const promoted = opts.promoted ?? activity.promoted;

  const files: string[] = [];
  walkMd(root, files);

  const result: PruneResult = { scanned: 0, archived: 0, kept: 0, archivedPaths: [] };
  for (const abs of files) {
    result.scanned++;
    let content: string, mtimeMs: number;
    try {
      content = readFileSync(abs, "utf-8");
      mtimeMs = statSync(abs).mtimeMs;
    } catch { result.kept++; continue; }

    const dateMs = frontmatterDateMs(content) ?? mtimeMs;
    const ageDays = Math.max(0, (now - dateMs) / (24 * 3600 * 1000));
    const { emotionIntensity } = parseEmotionFrontmatter(content);
    const relPath = path.relative(FRIDAY_ROOT, abs);

    const archive = shouldArchive(
      {
        ageDays,
        emotionIntensity,
        recentlyRecalled: recent.has(relPath),
        promoted: promoted.has(relPath),
      },
      { halfLifeDays, k },
    );

    if (!archive) { result.kept++; continue; }

    result.archived++;
    result.archivedPaths.push(relPath);
    if (opts.dryRun) continue;
    try {
      const dest = path.join(archiveRoot, path.relative(root, abs));
      mkdirSync(path.dirname(dest), { recursive: true });
      renameSync(abs, dest);
    } catch { /* leave in place if the move fails */ }
  }
  return result;
}
