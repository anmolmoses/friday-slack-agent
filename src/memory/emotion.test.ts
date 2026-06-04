import { describe, it, expect } from "bun:test";
import { parseEmotionFrontmatter, NEUTRAL_EMOTION } from "./emotion.ts";

describe("parseEmotionFrontmatter", () => {
  it("reads emotion, intensity, and importance from a captured exchange", () => {
    const file = [
      "---",
      "date: 2026-06-03T10:00:00.000Z",
      "tier: episodic",
      "importance: 0.8",
      "metadata:",
      "  type: episodic",
      "  emotion: joy",
      "  emotion_intensity: 0.72",
      "  topic: \"shipping\"",
      "---",
      "",
      "**Them:** we shipped it!",
    ].join("\n");
    const meta = parseEmotionFrontmatter(file);
    expect(meta.emotion).toBe("joy");
    expect(meta.emotionIntensity).toBeCloseTo(0.72, 5);
    expect(meta.importance).toBeCloseTo(0.8, 5);
  });

  it("returns neutral defaults when there is no frontmatter block", () => {
    expect(parseEmotionFrontmatter("just a plain daily note\nno frontmatter here")).toEqual(NEUTRAL_EMOTION);
  });

  it("returns neutral defaults for an empty string", () => {
    expect(parseEmotionFrontmatter("")).toEqual(NEUTRAL_EMOTION);
  });

  it("tolerates a frontmatter block missing emotion fields", () => {
    const file = ["---", "date: 2026-06-03", "tier: semantic", "---", "body"].join("\n");
    const meta = parseEmotionFrontmatter(file);
    expect(meta).toEqual(NEUTRAL_EMOTION);
  });

  it("clamps out-of-range and non-numeric intensities to [0,1]", () => {
    expect(parseEmotionFrontmatter("---\nemotion_intensity: 9\n---").emotionIntensity).toBe(1);
    expect(parseEmotionFrontmatter("---\nimportance: -3\n---").importance).toBe(0);
  });

  it("strips quotes around the emotion label", () => {
    expect(parseEmotionFrontmatter('---\nemotion: "frustration"\n---').emotion).toBe("frustration");
  });

  it("ignores frontmatter-looking lines after the closing fence", () => {
    const file = ["---", "emotion: joy", "---", "emotion: sadness", "emotion_intensity: 1"].join("\n");
    const meta = parseEmotionFrontmatter(file);
    expect(meta.emotion).toBe("joy");
    expect(meta.emotionIntensity).toBe(0); // the body line is not parsed
  });
});
