/**
 * Salience gate — the working→short-term boundary (T1).
 *
 * Working memory (the live --resume transcript) is ephemeral and emotion-free.
 * An exchange only earns a durable short-term file if it's actually salient:
 * felt (emotion), consequential (importance), inherently durable (a semantic
 * fact or procedure rather than episodic chatter), or explicitly pinned by the
 * user. Everything else evaporates with the thread — emotion is the pen that
 * writes to the hippocampus.
 *
 * Pure — no IO — so it's unit-testable and the capture path stays a thin shell.
 */

export interface SalienceInput {
  emotionIntensity: number; // [0, 1]
  importance: number; // [0, 1]
  tier: string; // episodic | semantic | procedural
  explicit: boolean; // user asked to remember
}

export interface SalienceThresholds {
  emotionIntensity: number;
  importance: number;
}

export const DEFAULT_SALIENCE: SalienceThresholds = {
  emotionIntensity: 0.5,
  importance: 0.6,
};

const REMEMBER_RE =
  /\b(remember (this|that|to|when)|don'?t forget|make a note|note that|keep in mind|for the record|pin this|take note)\b/i;

const STABLE_PREFERENCE_RE =
  /\b(my favorite|favourite)\s+(song|artist|band|album|movie|show|book|app|browser|editor|tool|language|framework|place|restaurant|food|drink|color|colour)\s+(is|['’]s|=)\b/i;

const INVERSE_FAVORITE_RE =
  /\b(is|['’]s)\s+my\s+(favorite|favourite)\s+(song|artist|band|album|movie|show|book|app|browser|editor|tool|language|framework|place|restaurant|food|drink|color|colour)\b/i;

const PREFERENCE_RE =
  /\b(i\s+(prefer|usually use|always use|default to|work best with|want you to use)|my\s+preferred)\b/i;

/** Did the user explicitly ask Friday to remember this? */
export function detectExplicitRemember(text: string): boolean {
  return REMEMBER_RE.test(text ?? "");
}

/** Did the user state a durable preference/identity fact worth keeping? */
export function detectStablePreference(text: string): boolean {
  const t = text ?? "";
  if (!t.trim()) return false;
  return (
    STABLE_PREFERENCE_RE.test(t) ||
    INVERSE_FAVORITE_RE.test(t) ||
    PREFERENCE_RE.test(t)
  );
}

/**
 * True when the exchange should graduate from working memory to a disk-backed
 * short-term file. Episodic, neutral, low-importance chatter returns false.
 */
export function isSalient(
  input: SalienceInput,
  thresholds: SalienceThresholds = DEFAULT_SALIENCE,
): boolean {
  if (input.explicit) return true;
  // Semantic facts and procedures are durable knowledge, not banter — keep them
  // even when flat. Episodic exchanges must earn their place by feeling/weight.
  const tier = (input.tier || "episodic").toLowerCase();
  if (tier === "semantic" || tier === "procedural") return true;
  if (input.emotionIntensity >= thresholds.emotionIntensity) return true;
  if (input.importance >= thresholds.importance) return true;
  return false;
}
