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
}

export interface DreamResult {
  ran: Array<"light" | "rem" | "deep">;
  lightHits: number;
  remHits: number;
  deepPromoted: number;
  candidates: PromotionCandidate[];
  summary: string;
  themes: string[];
}

export const DEFAULT_WEIGHTS: PromotionWeights = {
  frequency: 0.24,
  relevance: 0.30,
  diversity: 0.15,
  recency: 0.15,
  consolidation: 0.10,
  conceptual: 0.06,
};
