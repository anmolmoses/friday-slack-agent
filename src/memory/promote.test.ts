import { describe, it, expect } from "bun:test";
import {
  computeComponents,
  scoreComponents,
  evaluatePromotion,
  type ScoreInput,
} from "./promote.ts";
import { DEFAULT_WEIGHTS } from "./types.ts";

const HALF_LIFE = 14;

/** A repeated, recalled, emotionless entry — the classic promotion path. */
function repeated(over: Partial<ScoreInput & { importance: number }> = {}) {
  return {
    recallCount: 6,
    maxScore: 0.9,
    uniqueQueries: 5,
    dailyCount: 4,
    signalCount: 2,
    conceptTagCount: 4,
    ageDays: 1,
    emotionIntensity: 0,
    importance: 0,
    ...over,
  };
}

const GATE_OPTS = {
  minRecallCount: 3,
  minUniqueQueries: 3,
  maxAgeDays: 30,
  recencyHalfLifeDays: HALF_LIFE,
  weights: DEFAULT_WEIGHTS,
  flashbulbEmotionMin: 0.66,
  flashbulbImportanceMin: 0.66,
};

describe("DEFAULT_WEIGHTS", () => {
  it("sums to exactly 1.0 so scores stay in [0,1]", () => {
    const sum = Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 10);
  });

  it("includes an emotion weight", () => {
    expect(DEFAULT_WEIGHTS.emotion).toBeGreaterThan(0);
  });
});

describe("computeComponents", () => {
  it("normalizes every component to [0,1]", () => {
    const c = computeComponents(repeated({ recallCount: 100, uniqueQueries: 50, conceptTagCount: 20, emotionIntensity: 5 }), HALF_LIFE);
    for (const v of Object.values(c)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("decays recency exponentially by the half-life", () => {
    expect(computeComponents(repeated({ ageDays: 0 }), HALF_LIFE).recency).toBeCloseTo(1, 5);
    expect(computeComponents(repeated({ ageDays: HALF_LIFE }), HALF_LIFE).recency).toBeCloseTo(Math.exp(-1), 5);
  });

  it("saturates frequency near recallCount=21", () => {
    expect(computeComponents(repeated({ recallCount: 21 }), HALF_LIFE).frequency).toBeCloseTo(1, 5);
    expect(computeComponents(repeated({ recallCount: 0 }), HALF_LIFE).frequency).toBeCloseTo(0, 5);
  });

  it("passes emotion intensity through as the emotion component", () => {
    expect(computeComponents(repeated({ emotionIntensity: 0.4 }), HALF_LIFE).emotion).toBeCloseTo(0.4, 5);
    expect(computeComponents(repeated({ emotionIntensity: -1 }), HALF_LIFE).emotion).toBe(0);
  });
});

describe("scoreComponents", () => {
  it("returns 1.0 when every component is maxed and weights sum to 1", () => {
    const allOne = computeComponents(repeated({ recallCount: 1000, uniqueQueries: 1000, conceptTagCount: 1000, ageDays: 0, maxScore: 1, dailyCount: 1000, signalCount: 1000, emotionIntensity: 1 }), HALF_LIFE);
    expect(scoreComponents(allOne, DEFAULT_WEIGHTS)).toBeCloseTo(1, 5);
  });
});

describe("evaluatePromotion — emotion factor", () => {
  it("raises the score monotonically with emotion, all else equal", () => {
    const cold = evaluatePromotion(repeated({ emotionIntensity: 0 }), GATE_OPTS);
    const warm = evaluatePromotion(repeated({ emotionIntensity: 0.5 }), GATE_OPTS);
    const hot = evaluatePromotion(repeated({ emotionIntensity: 1 }), GATE_OPTS);
    expect(warm.score).toBeGreaterThan(cold.score);
    expect(hot.score).toBeGreaterThan(warm.score);
    // emotion weight (0.12) sets the gap between intensity 0 and 1
    expect(hot.score - cold.score).toBeCloseTo(DEFAULT_WEIGHTS.emotion, 5);
  });
});

describe("evaluatePromotion — gating", () => {
  it("rejects an emotionless entry recalled too few times", () => {
    const v = evaluatePromotion(repeated({ recallCount: 1, uniqueQueries: 1 }), GATE_OPTS);
    expect(v.flashbulb).toBe(false);
    expect(v.eligible).toBe(false);
  });

  it("rejects an entry recalled often but across too few distinct queries", () => {
    const v = evaluatePromotion(repeated({ recallCount: 10, uniqueQueries: 1 }), GATE_OPTS);
    expect(v.eligible).toBe(false);
  });

  it("accepts a repeated, query-diverse entry via the normal path", () => {
    const v = evaluatePromotion(repeated({ recallCount: 6, uniqueQueries: 4 }), GATE_OPTS);
    expect(v.flashbulb).toBe(false);
    expect(v.eligible).toBe(true);
  });
});

describe("evaluatePromotion — flashbulb bypass", () => {
  it("promotes a felt, consequential one-off despite low recall", () => {
    const v = evaluatePromotion(repeated({ recallCount: 1, uniqueQueries: 1, emotionIntensity: 0.8, importance: 0.8 }), GATE_OPTS);
    expect(v.flashbulb).toBe(true);
    expect(v.eligible).toBe(true);
  });

  it("does not fire when only emotion is high but importance is low", () => {
    const v = evaluatePromotion(repeated({ recallCount: 1, uniqueQueries: 1, emotionIntensity: 0.9, importance: 0.2 }), GATE_OPTS);
    expect(v.flashbulb).toBe(false);
    expect(v.eligible).toBe(false);
  });

  it("never bypasses the staleness bound, even for a flashbulb memory", () => {
    const v = evaluatePromotion(repeated({ recallCount: 1, uniqueQueries: 1, emotionIntensity: 0.9, importance: 0.9, ageDays: 99 }), GATE_OPTS);
    expect(v.flashbulb).toBe(true);
    expect(v.eligible).toBe(false);
  });
});
