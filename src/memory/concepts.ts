/**
 * Concept-tag extraction. Lightweight, no LLM.
 * Tokenize → drop stopwords + trivial tokens → count frequency → take top-K.
 */

const STOPWORDS = new Set([
  "a","an","and","are","as","at","be","been","but","by","can","could","did",
  "do","does","for","from","had","has","have","he","her","here","him","his",
  "how","i","if","in","into","is","it","its","just","me","my","no","not","now",
  "of","on","one","only","or","our","out","over","she","so","some","such",
  "that","the","their","them","then","there","these","they","this","to","too",
  "up","us","was","we","were","what","when","where","which","who","whom","why",
  "will","with","would","you","your","yours","youve","im","thats","whats","its",
  "dont","didnt","doesnt","isnt","arent","wasnt","werent","youre","youll","well",
  "got","get","gets","getting","also","than","very","really","still","more",
  "most","much","many","any","every","all","some","none","like","about","after",
  "before","during","while","each","new","old","other","same","ok","okay","yeah",
  "yes","no","lol","haha","pls","plz","thx","ty","btw","fwiw","tldr","etc",
  "etc.","re","let","lets",
]);

const WORD_RE = /[a-z][a-z0-9\-]{2,}/g;

export function extractConceptTags(text: string, max = 8): string[] {
  if (!text) return [];
  const counts = new Map<string, number>();
  const normalized = text.toLowerCase();
  const matches = normalized.match(WORD_RE) ?? [];
  for (const raw of matches) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    const tok = stem(raw);
    if (!tok || STOPWORDS.has(tok)) continue;
    counts.set(tok, (counts.get(tok) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .slice(0, max)
    .map(([tok]) => tok);
}

/** Very light suffix-stripping. Not Porter; just enough to merge "meeting" + "meetings". */
export function stem(word: string): string {
  let w = word;
  for (const suffix of ["ings", "ing", "edly", "ed", "ly", "es", "s"]) {
    if (w.length > suffix.length + 2 && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  return w;
}

export function tokenize(text: string): string[] {
  if (!text) return [];
  const tokens: string[] = [];
  const matches = text.toLowerCase().match(WORD_RE) ?? [];
  for (const raw of matches) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    const s = stem(raw);
    if (!s || STOPWORDS.has(s)) continue;
    tokens.push(s);
  }
  return tokens;
}

/** Stable short hash — not crypto, just dedup buckets for query hashes. */
export function hashQuery(q: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < q.length; i++) {
    h ^= q.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
