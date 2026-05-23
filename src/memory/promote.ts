import { readFileSync, existsSync } from "node:fs";
import { MEMORY_MD } from "./paths.ts";
import { loadRecallStore, loadPhaseSignalStore, markPromoted } from "./recall.ts";
import type {
  PromotionCandidate,
  PromotionComponents,
  PromotionWeights,
} from "./types.ts";
import { DEFAULT_WEIGHTS } from "./types.ts";
import { tokenize } from "./concepts.ts";

export interface PromotionOptions {
  limit?: number;
  minScore?: number;
  minRecallCount?: number;
  minUniqueQueries?: number;
  recencyHalfLifeDays?: number;
  maxAgeDays?: number;
  weights?: PromotionWeights;
}

/**
 * Rank short-term recall entries for promotion to MEMORY.md.
 * Mirrors openclaw's six-factor scoring model (weights match upstream).
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

    if (ageDays > maxAgeDays) continue;
    if (entry.recallCount < minRecallCount) continue;
    if (entry.queryHashes.length < minUniqueQueries) continue;

    const signal = signals.entries[entry.key];
    const signalCount = (signal?.lightHits ?? 0) + (signal?.remHits ?? 0);

    // Component scores, all in [0, 1]
    const components: PromotionComponents = {
      // frequency: log-scaled recallCount (saturates around 20)
      frequency: Math.min(1, Math.log2(entry.recallCount + 1) / Math.log2(22)),
      // relevance: best single recall score (already normalized [0,1])
      relevance: Math.min(1, entry.maxScore),
      // diversity: unique queries / 10 (saturating)
      diversity: Math.min(1, entry.queryHashes.length / 10),
      // recency: exponential decay from last recall
      recency: Math.exp(-ageDays / Math.max(recencyHalfLifeDays, 1)),
      // consolidation: observed on multiple days + via signals
      consolidation: Math.min(
        1,
        (entry.dailyCount / 8) * 0.7 + Math.min(signalCount / 5, 1) * 0.3,
      ),
      // conceptual: how tagged is this snippet (saturates at 8 tags)
      conceptual: Math.min(1, entry.conceptTags.length / 8),
    };

    const score =
      weights.frequency * components.frequency +
      weights.relevance * components.relevance +
      weights.diversity * components.diversity +
      weights.recency * components.recency +
      weights.consolidation * components.consolidation +
      weights.conceptual * components.conceptual;

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
      score,
      recallDays: [...entry.recallDays],
      conceptTags: [...entry.conceptTags],
      components,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const limited = options.limit
    ? candidates.slice(0, options.limit)
    : candidates;
  if (options.minScore != null) {
    return limited.filter((c) => c.score >= options.minScore!);
  }
  return limited.filter((c) => c.score >= 0.8); // openclaw default
}

/** Format a short human-readable rundown of candidates. */
export function formatCandidates(candidates: PromotionCandidate[]): string {
  if (candidates.length === 0) return "No candidates meet the promotion gate.";
  return candidates
    .map((c, i) => {
      const head = `${i + 1}. [score=${c.score.toFixed(2)}] ${c.path}:${c.startLine}-${c.endLine}`;
      const meta = `   recall=${c.recallCount} days=${c.dailyCount} unique-q=${c.uniqueQueries} age=${c.ageDays.toFixed(1)}d tags=${c.conceptTags.slice(0, 4).join(",") || "-"}`;
      const body = `   > ${c.snippet.slice(0, 160).replace(/\s+/g, " ")}${c.snippet.length > 160 ? "…" : ""}`;
      return `${head}\n${meta}\n${body}`;
    })
    .join("\n");
}

/** Mark the given candidates as promoted — typically after writing MEMORY.md. */
export function commitPromotions(keys: string[]): void {
  markPromoted(keys);
}

