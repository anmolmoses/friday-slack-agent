import { readFileSync, existsSync } from "node:fs";
import { MEMORY_MD } from "./paths.ts";
import { loadRecallStore, loadPhaseSignalStore, markPromoted } from "./recall.ts";
import { readEmotionMeta } from "./emotion.ts";
import type {
  PromotionCandidate,
  PromotionComponents,
  PromotionWeights,
} from "./types.ts";
import {
  DEFAULT_WEIGHTS,
  FLASHBULB_EMOTION_MIN,
  FLASHBULB_IMPORTANCE_MIN,
} from "./types.ts";
import { tokenize } from "./concepts.ts";

export interface PromotionOptions {
  limit?: number;
  minScore?: number;
  minRecallCount?: number;
  minUniqueQueries?: number;
  recencyHalfLifeDays?: number;
  maxAgeDays?: number;
  weights?: PromotionWeights;
  /** Emotion intensity at/above which the flashbulb bypass can fire. */
  flashbulbEmotionMin?: number;
  /** Importance at/above which the flashbulb bypass can fire. */
  flashbulbImportanceMin?: number;
}

/** Raw signals for one short-term entry, independent of where they're loaded from. */
export interface ScoreInput {
  recallCount: number;
  maxScore: number;
  uniqueQueries: number;
  dailyCount: number;
  signalCount: number;
  conceptTagCount: number;
  ageDays: number;
  emotionIntensity: number; // [0, 1]
}

/**
 * The seven component scores, each normalized to [0, 1]. Pure — no IO.
 * Mirrors openclaw's model; `emotion` is friday's addition (amygdala salience).
 */
export function computeComponents(
  input: ScoreInput,
  recencyHalfLifeDays: number,
): PromotionComponents {
  return {
    // frequency: log-scaled recallCount (saturates around 20)
    frequency: Math.min(1, Math.log2(input.recallCount + 1) / Math.log2(22)),
    // relevance: best single recall score (already normalized [0,1])
    relevance: Math.min(1, input.maxScore),
    // diversity: unique queries / 10 (saturating)
    diversity: Math.min(1, input.uniqueQueries / 10),
    // recency: exponential decay from last recall
    recency: Math.exp(-input.ageDays / Math.max(recencyHalfLifeDays, 1)),
    // consolidation: observed on multiple days + via dream signals
    consolidation: Math.min(
      1,
      (input.dailyCount / 8) * 0.7 + Math.min(input.signalCount / 5, 1) * 0.3,
    ),
    // conceptual: how tagged is this snippet (saturates at 8 tags)
    conceptual: Math.min(1, input.conceptTagCount / 8),
    // emotion: amygdala tag strength at encode time
    emotion: Math.min(1, Math.max(0, input.emotionIntensity)),
  };
}

/** Weighted sum of components. Pure. With DEFAULT_WEIGHTS (sum 1.0) → [0, 1]. */
export function scoreComponents(
  components: PromotionComponents,
  weights: PromotionWeights,
): number {
  return (
    weights.frequency * components.frequency +
    weights.relevance * components.relevance +
    weights.diversity * components.diversity +
    weights.recency * components.recency +
    weights.consolidation * components.consolidation +
    weights.conceptual * components.conceptual +
    weights.emotion * components.emotion
  );
}

export interface PromotionVerdict {
  components: PromotionComponents;
  score: number;
  /** Felt one-off — clears the bypass on emotion + importance. */
  flashbulb: boolean;
  /** Passes the hard frequency/age gates (flashbulb relaxes recall/query gates). */
  eligible: boolean;
}

/**
 * Score one entry and decide whether it clears the hard gates. Pure — callers
 * supply the raw signals + importance. The flashbulb bypass lets a felt,
 * consequential memory through even when it hasn't been recalled repeatedly;
 * it never bypasses the staleness (maxAge) bound.
 */
export function evaluatePromotion(
  input: ScoreInput & { importance: number },
  opts: {
    minRecallCount: number;
    minUniqueQueries: number;
    maxAgeDays: number;
    recencyHalfLifeDays: number;
    weights: PromotionWeights;
    flashbulbEmotionMin: number;
    flashbulbImportanceMin: number;
  },
): PromotionVerdict {
  const components = computeComponents(input, opts.recencyHalfLifeDays);
  const score = scoreComponents(components, opts.weights);
  const flashbulb =
    input.emotionIntensity >= opts.flashbulbEmotionMin &&
    input.importance >= opts.flashbulbImportanceMin;

  let eligible = input.ageDays <= opts.maxAgeDays; // staleness is never bypassed
  if (eligible && !flashbulb) {
    if (input.recallCount < opts.minRecallCount) eligible = false;
    else if (input.uniqueQueries < opts.minUniqueQueries) eligible = false;
  }

  return { components, score, flashbulb, eligible };
}

/**
 * Rank short-term recall entries for promotion to MEMORY.md. IO shell: loads
 * the recall + signal stores and each entry's emotion frontmatter, then defers
 * scoring/gating to the pure functions above. Selection keeps anything that
 * meets the score gate OR is a flashbulb memory.
 */
export function rankPromotionCandidates(
  options: PromotionOptions = {},
): PromotionCandidate[] {
  const {
    minRecallCount = 3,
    minUniqueQueries = 3,
    recencyHalfLifeDays = 14,
    maxAgeDays = 30,
    weights = DEFAULT_WEIGHTS,
    flashbulbEmotionMin = FLASHBULB_EMOTION_MIN,
    flashbulbImportanceMin = FLASHBULB_IMPORTANCE_MIN,
  } = options;

  const recall = loadRecallStore();
  const signals = loadPhaseSignalStore();

  // For dedup against already-in-MEMORY.md content
  const memoryText = existsSync(MEMORY_MD)
    ? readFileSync(MEMORY_MD, "utf-8").toLowerCase()
    : "";
  const memoryTokens = new Set(tokenize(memoryText));

  const now = Date.now();
  const candidates: PromotionCandidate[] = [];

  for (const entry of Object.values(recall.entries)) {
    if (entry.promotedAt) continue; // already landed

    const lastMs = Date.parse(entry.lastRecalledAt);
    const ageDays = Number.isFinite(lastMs)
      ? Math.max(0, (now - lastMs) / (24 * 3600 * 1000))
      : 0;

    const signal = signals.entries[entry.key];
    const signalCount = (signal?.lightHits ?? 0) + (signal?.remHits ?? 0);
    const emo = readEmotionMeta(entry.path);

    const verdict = evaluatePromotion(
      {
        recallCount: entry.recallCount,
        maxScore: entry.maxScore,
        uniqueQueries: entry.queryHashes.length,
        dailyCount: entry.dailyCount,
        signalCount,
        conceptTagCount: entry.conceptTags.length,
        ageDays,
        emotionIntensity: emo.emotionIntensity,
        importance: emo.importance,
      },
      {
        minRecallCount,
        minUniqueQueries,
        maxAgeDays,
        recencyHalfLifeDays,
        weights,
        flashbulbEmotionMin,
        flashbulbImportanceMin,
      },
    );

    if (!verdict.eligible) continue;

    const snippetTokens = new Set(tokenize(entry.snippet));
    // If ≥80% of snippet's content tokens already appear in MEMORY.md, assume
    // already captured — suppress as duplicate (cheap approximation of
    // openclaw's cosine-based dedup).
    if (snippetTokens.size > 0) {
      let overlap = 0;
      for (const t of snippetTokens) if (memoryTokens.has(t)) overlap++;
      if (overlap / snippetTokens.size >= 0.8) continue;
    }

    candidates.push({
      key: entry.key,
      path: entry.path,
      startLine: entry.startLine,
      endLine: entry.endLine,
      source: "memory",
      snippet: entry.snippet,
      recallCount: entry.recallCount,
      dailyCount: entry.dailyCount,
      groundedCount: entry.groundedCount,
      signalCount,
      avgScore: entry.recallCount > 0 ? entry.totalScore / entry.recallCount : 0,
      maxScore: entry.maxScore,
      uniqueQueries: entry.queryHashes.length,
      claimHash: entry.claimHash,
      promotedAt: entry.promotedAt,
      firstRecalledAt: entry.firstRecalledAt,
      lastRecalledAt: entry.lastRecalledAt,
      ageDays,
      score: verdict.score,
      recallDays: [...entry.recallDays],
      conceptTags: [...entry.conceptTags],
      components: verdict.components,
      emotion: emo.emotion,
      emotionIntensity: emo.emotionIntensity,
      importance: emo.importance,
      flashbulb: verdict.flashbulb,
    });
  }

  // Highest score first, but flashbulb memories always sort ahead of their score.
  candidates.sort((a, b) => {
    if (!!b.flashbulb !== !!a.flashbulb) return a.flashbulb ? -1 : 1;
    return b.score - a.score;
  });
  const limited = options.limit
    ? candidates.slice(0, options.limit)
    : candidates;
  const gate = options.minScore ?? 0.8; // openclaw default
  // Keep anything over the score gate OR flagged flashbulb (felt one-offs).
  return limited.filter((c) => c.score >= gate || c.flashbulb);
}

/** Format a short human-readable rundown of candidates. */
export function formatCandidates(candidates: PromotionCandidate[]): string {
  if (candidates.length === 0) return "No candidates meet the promotion gate.";
  return candidates
    .map((c, i) => {
      const flag = c.flashbulb ? " ⚡flashbulb" : "";
      const head = `${i + 1}. [score=${c.score.toFixed(2)}${flag}] ${c.path}:${c.startLine}-${c.endLine}`;
      const emo = c.emotion && c.emotion !== "neutral"
        ? ` emotion=${c.emotion}/${(c.emotionIntensity ?? 0).toFixed(2)}`
        : "";
      const meta = `   recall=${c.recallCount} days=${c.dailyCount} unique-q=${c.uniqueQueries} age=${c.ageDays.toFixed(1)}d${emo} tags=${c.conceptTags.slice(0, 4).join(",") || "-"}`;
      const body = `   > ${c.snippet.slice(0, 160).replace(/\s+/g, " ")}${c.snippet.length > 160 ? "…" : ""}`;
      return `${head}\n${meta}\n${body}`;
    })
    .join("\n");
}

/** Mark the given candidates as promoted — typically after writing MEMORY.md. */
export function commitPromotions(keys: string[]): void {
  markPromoted(keys);
}
