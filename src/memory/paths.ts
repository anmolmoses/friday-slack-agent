import path from "node:path";

export const FRIDAY_ROOT = path.resolve(import.meta.dir, "..", "..");
export const MEMORY_DIR = path.join(FRIDAY_ROOT, "memory");
export const DAILY_DIR = path.join(MEMORY_DIR, "daily");
export const DREAMS_DIR = path.join(MEMORY_DIR, ".dreams");
export const RECALL_FILE = path.join(DREAMS_DIR, "short-term-recall.json");
export const PHASE_SIGNAL_FILE = path.join(DREAMS_DIR, "phase-signals.json");
export const MEMORY_MD = path.join(MEMORY_DIR, "MEMORY.md");
export const DREAMS_MD = path.join(MEMORY_DIR, "DREAMS.md");

export function snippetKey(relPath: string, startLine: number, endLine: number): string {
  return `memory:${relPath}:${startLine}:${endLine}`;
}

export function parseSnippetKey(
  key: string,
): { source: string; path: string; startLine: number; endLine: number } | null {
  const parts = key.split(":");
  if (parts.length < 4) return null;
  const endLine = Number.parseInt(parts[parts.length - 1]!, 10);
  const startLine = Number.parseInt(parts[parts.length - 2]!, 10);
  const source = parts[0]!;
  const pathPart = parts.slice(1, parts.length - 2).join(":");
  if (Number.isNaN(startLine) || Number.isNaN(endLine)) return null;
  return { source, path: pathPart, startLine, endLine };
}
