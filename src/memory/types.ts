/**
 * Memory subsystem types. Schema names/fields intentionally mirror openclaw
 * so we can interop with files written by the upstream memory-core plugin.
 */

export type MemorySource = "memory";

export interface ShortTermRecallEntry {
  key: string; // "memory:<relPath>:<startLine>:<endLine>"
  path: string;
  startLine: number;
  endLine: number;
  source: MemorySource;
  snippet: string;
  recallCount: number;
  dailyCount: number;
  groundedCount: number;
  totalScore: number;
  maxScore: number;
  firstRecalledAt: string;
  lastRecalledAt: string;
  queryHashes: string[]; // bounded to 32
  recallDays: string[]; // bounded to 16 (YYYY-MM-DD)
  conceptTags: string[]; // bounded to 8
  claimHash?: string;
  promotedAt?: string;
}

export interface ShortTermRecallStore {
  version: 1;
  updatedAt: string;
  entries: Record<string, ShortTermRecallEntry>;
}

export interface ShortTermPhaseSignalEntry {
  key: string;
  lightHits: number;
  remHits: number;
  lastLightAt?: string;
  lastRemAt?: string;
}

export interface ShortTermPhaseSignalStore {
  version: 1;
  updatedAt: string;
  entries: Record<string, ShortTermPhaseSignalEntry>;
}

export interface MemorySearchResult {
  source: MemorySource;
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number; // normalized [0, 1]
  retrievalRelevance?: number;
  ftsRelevance?: number;
  vectorRelevance?: number; // always undefined in this build
  conceptTags?: string[];
}

export interface PromotionWeights {
  frequency: number;
  relevance: number;
  diversity: number;
  recency: number;
  consolidation: number;
  conceptual: number;
  /** Emotional salience at encode time — the amygdala tag (see emotion.ts). */
  emotion: number;
}

export interface PromotionComponents extends PromotionWeights {}

export interface PromotionCandidate {
  key: string;
  path: string;
  startLine: number;
  endLine: number;
  source: MemorySource;
  snippet: string;
  recallCount: number;
  dailyCount: number;
  groundedCount: number;
  signalCount: number;
  avgScore: number;
  maxScore: number;
  uniqueQueries: number;
  claimHash?: string;
  promotedAt?: string;
  firstRecalledAt: string;
  lastRecalledAt: string;
  ageDays: number;
  score: number;
  recallDays: string[];
  conceptTags: string[];
  components: PromotionComponents;
  /** Dominant emotion label from the source file's frontmatter. */
  emotion?: string;
  /** [0, 1] emotion intensity used for scoring + the flashbulb gate. */
  emotionIntensity?: number;
  /** [0, 1] importance from frontmatter — second half of the flashbulb gate. */
  importance?: number;
  /** True when promoted via the flashbulb bypass (felt one-off, not repeated). */
  flashbulb?: boolean;
}

export interface DreamResult {
  ran: Array<"light" | "rem" | "deep" | "decay">;
  lightHits: number;
  remHits: number;
  deepPromoted: number;
  /** Short-term files archived by the decay phase (T2). */
  decayArchived: number;
  candidates: PromotionCandidate[];
  summary: string;
  themes: string[];
}

// Sum is exactly 1.0 — promotion scores stay in [0, 1] against the 0.8 gate.
// Emotion carved out of the frequency/relevance/diversity/recency budget so a
// felt memory consolidates faster than a merely repeated one.
export const DEFAULT_WEIGHTS: PromotionWeights = {
  frequency: 0.20,
  relevance: 0.26,
  diversity: 0.12,
  recency: 0.13,
  consolidation: 0.10,
  conceptual: 0.07,
  emotion: 0.12,
};

/** Flashbulb bypass: a single felt, consequential memory consolidates even
 *  without repeated recall — both thresholds must be met. */
export const FLASHBULB_EMOTION_MIN = 0.66;
export const FLASHBULB_IMPORTANCE_MIN = 0.66;
