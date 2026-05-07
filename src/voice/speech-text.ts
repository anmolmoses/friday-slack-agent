const DANGLING_FINAL_WORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "displaying",
  "featuring",
  "for",
  "including",
  "in",
  "of",
  "on",
  "showing",
  "that",
  "the",
  "to",
  "while",
  "with",
]);

export function completeShortSentence(text: string, maxWords = 12): string {
  const cleaned = text
    .replace(/\[[^\]]+\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "I cannot read the screen clearly.";
  const cap = Math.max(3, Math.min(24, Math.floor(maxWords)));
  const firstSentence = cleaned.match(/^(.+?[.!?])(?:\s|$)/)?.[1] ?? cleaned;
  const words = firstSentence
    .replace(/[.!?]+$/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, cap);
  while (
    words.length > 1 &&
    DANGLING_FINAL_WORDS.has(words[words.length - 1]!.toLowerCase())
  ) {
    words.pop();
  }
  const sentence = words.join(" ").replace(/[,;:]+$/g, "").trim();
  return sentence ? `${sentence}.` : "I cannot read the screen clearly.";
}

export function danglingEnding(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (!/[.!?]$/.test(trimmed)) return "missing sentence punctuation";
  const lastWord = trimmed
    .replace(/[.!?]+$/g, "")
    .split(/\s+/)
    .at(-1)
    ?.toLowerCase();
  if (lastWord && DANGLING_FINAL_WORDS.has(lastWord)) {
    return `dangling final word "${lastWord}"`;
  }
  return undefined;
}

const USEFUL_SHORT_TRANSCRIPT =
  /\b(friday|anmol|hey|hi|hello|yes|yeah|no|stop|cancel|thanks|thank you|please|help|what|who|where|when|why|how|can|could|tell|show|check|look|open|run|search|send|click|type|fix|debug|review|build|test)\b/i;

export function isLikelyNoiseTranscript(
  text: string,
  opts: { likelyNeedsTool?: (text: string) => boolean } = {},
): boolean {
  const t = text.trim();
  if (!t) return true;
  if (opts.likelyNeedsTool?.(t)) return false;
  const usefulCue = USEFUL_SHORT_TRANSCRIPT.test(t);
  const nonAscii = /[^\x00-\x7F]/.test(t);
  if (nonAscii && !usefulCue) return true;
  if (usefulCue) return false;

  const words = t.split(/\s+/).filter(Boolean);
  const compact = t.replace(/[^\p{L}\p{N}]+/gu, "");
  if (/^(?:um+|uh+|hm+|hmm+|mm+|ah+|er+)$/i.test(compact)) return true;
  if (words.length <= 2 && t.length <= 36) return true;
  if (/[?]/.test(t)) return false;
  if (words.length > 4 || t.length > 36) return false;
  return false;
}
