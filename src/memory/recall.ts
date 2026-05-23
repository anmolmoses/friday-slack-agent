import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import {
  RECALL_FILE,
  PHASE_SIGNAL_FILE,
  snippetKey,
} from "./paths.ts";
import type {
  ShortTermRecallEntry,
  ShortTermRecallStore,
  ShortTermPhaseSignalStore,
  ShortTermPhaseSignalEntry,
} from "./types.ts";
import { hashQuery } from "./concepts.ts";

const MAX_QUERY_HASHES = 32;
const MAX_RECALL_DAYS = 16;
const MAX_CONCEPT_TAGS = 8;
const SNIPPET_PREVIEW = 400;

function loadStore<T>(file: string, defaults: T): T {
  if (!existsSync(file)) return defaults;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as T;
  } catch {
    return defaults;
  }
}

function saveAtomic(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}

export function loadRecallStore(): ShortTermRecallStore {
  return loadStore<ShortTermRecallStore>(RECALL_FILE, {
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: {},
  });
}

export function saveRecallStore(store: ShortTermRecallStore): void {
  store.updatedAt = new Date().toISOString();
  saveAtomic(RECALL_FILE, store);
}

export function loadPhaseSignalStore(): ShortTermPhaseSignalStore {
  return loadStore<ShortTermPhaseSignalStore>(PHASE_SIGNAL_FILE, {
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: {},
  });
}

export function savePhaseSignalStore(store: ShortTermPhaseSignalStore): void {
  store.updatedAt = new Date().toISOString();
  saveAtomic(PHASE_SIGNAL_FILE, store);
}

export interface RecallInput {
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number;
  query: string;
  conceptTags?: string[];
}

/**
 * Record one or more retrieval hits. Merges into existing entries, updating
 * recallCount, scores, queryHashes, and conceptTags. Writes once per call.
 */
export function recordRecalls(hits: RecallInput[]): void {
  if (hits.length === 0) return;
  const store = loadRecallStore();
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();

  for (const hit of hits) {
    const key = snippetKey(hit.path, hit.startLine, hit.endLine);
    const existing = store.entries[key];
    const qh = hashQuery(hit.query);

    if (!existing) {
      const entry: ShortTermRecallEntry = {
        key,
        path: hit.path,
        startLine: hit.startLine,
        endLine: hit.endLine,
        source: "memory",
        snippet: hit.snippet.slice(0, SNIPPET_PREVIEW),
        recallCount: 1,
        dailyCount: 1,
        groundedCount: 0,
        totalScore: hit.score,
        maxScore: hit.score,
        firstRecalledAt: now,
        lastRecalledAt: now,
        queryHashes: [qh],
        recallDays: [today],
        conceptTags: (hit.conceptTags ?? []).slice(0, MAX_CONCEPT_TAGS),
      };
      store.entries[key] = entry;
    } else {
      existing.recallCount += 1;
      existing.totalScore += hit.score;
      if (hit.score > existing.maxScore) existing.maxScore = hit.score;
      existing.lastRecalledAt = now;

      if (!existing.queryHashes.includes(qh)) {
        existing.queryHashes.push(qh);
        if (existing.queryHashes.length > MAX_QUERY_HASHES) {
          existing.queryHashes.shift();
        }
      }

      if (!existing.recallDays.includes(today)) {
        existing.recallDays.push(today);
        existing.dailyCount = existing.recallDays.length;
        if (existing.recallDays.length > MAX_RECALL_DAYS) {
          existing.recallDays.shift();
          existing.dailyCount = existing.recallDays.length;
        }
      }

      if (hit.conceptTags && hit.conceptTags.length > 0) {
        const merged = new Set(existing.conceptTags);
        for (const t of hit.conceptTags) merged.add(t);
        existing.conceptTags = [...merged].slice(0, MAX_CONCEPT_TAGS);
      }

      // Keep the freshest snippet preview if the underlying file changed
      existing.snippet = hit.snippet.slice(0, SNIPPET_PREVIEW);
    }
  }

  saveRecallStore(store);
}

/** Bump light/rem signal counts for a batch of snippet keys. */
export function recordPhaseSignals(
  keys: string[],
  phase: "light" | "rem",
): void {
  if (keys.length === 0) return;
  const store = loadPhaseSignalStore();
  const now = new Date().toISOString();
  for (const key of keys) {
    const existing: ShortTermPhaseSignalEntry = store.entries[key] ?? {
      key,
      lightHits: 0,
      remHits: 0,
    };
    if (phase === "light") {
      existing.lightHits += 1;
      existing.lastLightAt = now;
    } else {
      existing.remHits += 1;
      existing.lastRemAt = now;
    }
    store.entries[key] = existing;
  }
  savePhaseSignalStore(store);
}

export function markPromoted(keys: string[]): void {
  if (keys.length === 0) return;
  const store = loadRecallStore();
  const now = new Date().toISOString();
  for (const key of keys) {
    const entry = store.entries[key];
    if (entry) entry.promotedAt = now;
  }
  saveRecallStore(store);
}
