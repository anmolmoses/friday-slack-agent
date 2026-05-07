import type { MemorySearchResult } from "./types.ts";
import { tokenize, extractConceptTags } from "./concepts.ts";
import { loadCorpus } from "./corpus.ts";
import { recordRecalls } from "./recall.ts";

const BM25_K1 = 1.5;
const BM25_B = 0.75;

export interface SearchOptions {
  limit?: number;
  minScore?: number;
  recordRecall?: boolean;
}

/**
 * BM25 ranked search over memory corpus. Returns top snippets with a
 * normalized score in [0, 1]. Records recalls by default so repeated
 * searches feed the dreaming pipeline.
 */
export function searchMemory(
  query: string,
  options: SearchOptions = {},
): MemorySearchResult[] {
  const { limit = 10, minScore = 0.05, recordRecall = true } = options;
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const corpus = loadCorpus();
  if (corpus.length === 0) return [];

  // Doc frequencies for IDF
  const docFreq = new Map<string, number>();
  let totalLen = 0;
  for (const snip of corpus) {
    totalLen += snip.tokens.length;
    const uniq = new Set(snip.tokens);
    for (const tok of uniq) docFreq.set(tok, (docFreq.get(tok) ?? 0) + 1);
  }
  const avgLen = totalLen / Math.max(corpus.length, 1);
  const N = corpus.length;

  const idfOf = (tok: string): number => {
    const df = docFreq.get(tok) ?? 0;
    // Okapi BM25 idf
    return Math.log(1 + (N - df + 0.5) / (df + 0.5));
  };

  const queryTF = new Map<string, number>();
  for (const tok of queryTokens) queryTF.set(tok, (queryTF.get(tok) ?? 0) + 1);

  // Score each snippet
  const scored: Array<{ score: number; raw: number; snip: typeof corpus[number] }> = [];
  let maxRaw = 0;
  for (const snip of corpus) {
    if (snip.tokens.length === 0) continue;
    const lenNorm = 1 - BM25_B + BM25_B * (snip.tokens.length / Math.max(avgLen, 1));
    const tf = new Map<string, number>();
    for (const tok of snip.tokens) tf.set(tok, (tf.get(tok) ?? 0) + 1);

    let raw = 0;
    for (const [qt] of queryTF) {
      const f = tf.get(qt) ?? 0;
      if (f === 0) continue;
      const idf = idfOf(qt);
      raw += idf * ((f * (BM25_K1 + 1)) / (f + BM25_K1 * lenNorm));
    }

    if (raw > 0) {
      scored.push({ score: 0, raw, snip });
      if (raw > maxRaw) maxRaw = raw;
    }
  }

  if (maxRaw === 0) return [];

  // Normalize and filter
  const ranked = scored
    .map(({ raw, snip }) => ({ raw, snip, score: raw / maxRaw }))
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const results: MemorySearchResult[] = ranked.map(({ snip, score, raw }) => {
    const tags = extractConceptTags(snip.text, 5);
    return {
      source: "memory",
      path: snip.path,
      startLine: snip.startLine,
      endLine: snip.endLine,
      snippet: snip.text,
      score,
      ftsRelevance: raw,
      retrievalRelevance: score,
      conceptTags: tags,
    };
  });

  if (recordRecall) {
    recordRecalls(
      results.map((r) => ({
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        snippet: r.snippet,
        score: r.score,
        query,
        conceptTags: r.conceptTags,
      })),
    );
  }

  return results;
}
