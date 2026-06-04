/**
 * Emotion metadata reader. Auto-captured conversation files carry an `emotion`,
 * `emotion_intensity` and `importance` in their frontmatter (see auto-capture.ts).
 * The dream's promotion scorer reads this lazily at ranking time so emotionally
 * salient short-term memories can consolidate to long-term — the amygdala's job.
 *
 * Files without frontmatter (e.g. older daily notes) read as emotionless and
 * importance 0, so they score exactly as before plus a zero emotion term.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { FRIDAY_ROOT } from "./paths.ts";

export interface EmotionMeta {
  emotion: string;
  /** [0, 1] — amygdala tag strength */
  emotionIntensity: number;
  /** [0, 1] — how consequential, independent of feeling */
  importance: number;
}

export const NEUTRAL_EMOTION: EmotionMeta = {
  emotion: "neutral",
  emotionIntensity: 0,
  importance: 0,
};

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Parse emotion fields out of a markdown file's leading YAML frontmatter.
 * Pure — no filesystem. Returns NEUTRAL_EMOTION when there's no frontmatter
 * block or the fields are absent. Reads both top-level `importance:` and the
 * nested `metadata.emotion` / `metadata.emotion_intensity` written by capture.
 */
export function parseEmotionFrontmatter(content: string): EmotionMeta {
  const lines = content.split("\n");
  // Find the opening fence: first non-empty line must be `---`.
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") i++;
  if (i >= lines.length || lines[i]!.trim() !== "---") return { ...NEUTRAL_EMOTION };

  let emotion = NEUTRAL_EMOTION.emotion;
  let emotionIntensity = NEUTRAL_EMOTION.emotionIntensity;
  let importance = NEUTRAL_EMOTION.importance;

  for (let j = i + 1; j < lines.length; j++) {
    const line = lines[j]!;
    if (line.trim() === "---") break; // end of frontmatter

    const emoMatch = line.match(/^\s*emotion:\s*(.+?)\s*$/);
    if (emoMatch) {
      emotion = emoMatch[1]!.replace(/^["']|["']$/g, "").trim() || emotion;
      continue;
    }
    const intMatch = line.match(/^\s*emotion_intensity:\s*([0-9.]+)\s*$/);
    if (intMatch) {
      emotionIntensity = clamp01(Number.parseFloat(intMatch[1]!));
      continue;
    }
    const impMatch = line.match(/^\s*importance:\s*([0-9.]+)\s*$/);
    if (impMatch) {
      importance = clamp01(Number.parseFloat(impMatch[1]!));
      continue;
    }
  }

  return { emotion, emotionIntensity, importance };
}

const cache = new Map<string, { mtime: number; meta: EmotionMeta }>();

/**
 * Read emotion metadata for a repo-relative path (e.g.
 * "memory/conversations/2026-06-03/....md"). Cached by mtime so the dream can
 * call it once per snippet without re-reading the same file. Missing/unreadable
 * files read as neutral.
 */
export function readEmotionMeta(relPath: string): EmotionMeta {
  const abs = path.isAbsolute(relPath) ? relPath : path.join(FRIDAY_ROOT, relPath);
  let mtime: number;
  try {
    if (!existsSync(abs)) return { ...NEUTRAL_EMOTION };
    mtime = statSync(abs).mtimeMs;
  } catch {
    return { ...NEUTRAL_EMOTION };
  }
  const cached = cache.get(abs);
  if (cached && cached.mtime === mtime) return cached.meta;
  let meta: EmotionMeta;
  try {
    meta = parseEmotionFrontmatter(readFileSync(abs, "utf-8"));
  } catch {
    meta = { ...NEUTRAL_EMOTION };
  }
  cache.set(abs, { mtime, meta });
  return meta;
}
