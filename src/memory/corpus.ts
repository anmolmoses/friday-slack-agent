import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { MEMORY_DIR, FRIDAY_ROOT } from "./paths.ts";
import { tokenize } from "./concepts.ts";

export interface Snippet {
  path: string; // relative to repo root, e.g. "memory/daily/2026-04-23.md"
  startLine: number;
  endLine: number;
  text: string;
  tokens: string[];
  mtime: number;
}

const SNIPPET_WINDOW = 20;
const SNIPPET_STEP = 15;

interface CacheEntry {
  mtime: number;
  snippets: Snippet[];
}

const fileCache = new Map<string, CacheEntry>();

const SKIP_NAMES = new Set([
  ".dreams",
  "sessions.json",
  "sessions.json.tmp",
  "DREAMS.md",
]);

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue; // skip all dotfiles/dotdirs
    if (SKIP_NAMES.has(name)) continue;
    const full = path.join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, out);
    } else if (/\.(md|json|txt)$/i.test(name)) {
      out.push(full);
    }
  }
}

function splitIntoSnippets(absPath: string, mtime: number): Snippet[] {
  const relPath = path.relative(FRIDAY_ROOT, absPath);
  const content = readFileSync(absPath, "utf-8");
  const lines = content.split("\n");
  const snippets: Snippet[] = [];

  for (let i = 0; i < lines.length; i += SNIPPET_STEP) {
    const startLine = i + 1;
    const endLine = Math.min(i + SNIPPET_WINDOW, lines.length);
    const slice = lines.slice(i, endLine).join("\n").trim();
    if (!slice) continue;
    snippets.push({
      path: relPath,
      startLine,
      endLine,
      text: slice,
      tokens: tokenize(slice),
      mtime,
    });
    if (endLine >= lines.length) break;
  }

  return snippets;
}

export function loadCorpus(): Snippet[] {
  const files: string[] = [];
  walk(MEMORY_DIR, files);

  const out: Snippet[] = [];
  for (const abs of files) {
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    const cached = fileCache.get(abs);
    if (cached && cached.mtime === st.mtimeMs) {
      out.push(...cached.snippets);
      continue;
    }
    const snippets = splitIntoSnippets(abs, st.mtimeMs);
    fileCache.set(abs, { mtime: st.mtimeMs, snippets });
    out.push(...snippets);
  }

  return out;
}

/** Recent daily-note snippets, newest-first. Bounded to `limit` lookback days. */
export function loadRecentDailySnippets(lookbackDays: number): Snippet[] {
  const dailyDir = path.join(MEMORY_DIR, "daily");
  let entries: string[];
  try {
    entries = readdirSync(dailyDir);
  } catch {
    return [];
  }
  const cutoff = Date.now() - lookbackDays * 24 * 3600 * 1000;
  const out: Snippet[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const abs = path.join(dailyDir, name);
    let st;
    try {
      st = statSync(abs);
    } catch { continue; }
    if (st.mtimeMs < cutoff) continue;
    const cached = fileCache.get(abs);
    const snippets = cached && cached.mtime === st.mtimeMs
      ? cached.snippets
      : (() => {
          const s = splitIntoSnippets(abs, st.mtimeMs);
          fileCache.set(abs, { mtime: st.mtimeMs, snippets: s });
          return s;
        })();
    out.push(...snippets);
  }
  // Newest first by file mtime
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

export function invalidateCache(): void {
  fileCache.clear();
}
