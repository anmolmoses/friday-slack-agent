import { describe, it, expect } from "bun:test";
import {
  isSalient,
  detectExplicitRemember,
  detectStablePreference,
  DEFAULT_SALIENCE,
} from "./salience.ts";

const base = { emotionIntensity: 0, importance: 0, tier: "episodic", explicit: false };

describe("detectExplicitRemember", () => {
  it("catches common 'remember this' phrasings", () => {
    for (const t of [
      "remember this for later",
      "Please remember that I prefer bun",
      "don't forget the deploy step",
      "make a note: the API key rotates monthly",
      "keep in mind we ship Monday",
      "for the record, a teammate owns releases",
    ]) {
      expect(detectExplicitRemember(t)).toBe(true);
    }
  });

  it("does not fire on ordinary chatter", () => {
    expect(detectExplicitRemember("how's the build going?")).toBe(false);
    expect(detectExplicitRemember("")).toBe(false);
  });
});

describe("detectStablePreference", () => {
  it("catches durable favorites and preferences", () => {
    expect(detectStablePreference("My favorite song is Numb by Linkin Park.")).toBe(true);
    expect(detectStablePreference("Numb by Linkin Park is my favorite song.")).toBe(true);
    expect(detectStablePreference("I prefer Bun for JavaScript scripts.")).toBe(true);
    expect(detectStablePreference("My preferred browser is Chrome.")).toBe(true);
  });

  it("does not fire on vague ordinary chatter", () => {
    expect(detectStablePreference("I like this.")).toBe(false);
    expect(detectStablePreference("That song is good.")).toBe(false);
    expect(detectStablePreference("")).toBe(false);
  });
});

describe("isSalient", () => {
  it("drops neutral, low-importance episodic chatter", () => {
    expect(isSalient(base)).toBe(false);
    expect(isSalient({ ...base, emotionIntensity: 0.49, importance: 0.59 })).toBe(false);
  });

  it("keeps anything explicitly pinned, even if flat", () => {
    expect(isSalient({ ...base, explicit: true })).toBe(true);
  });

  it("keeps semantic facts and procedures regardless of feeling", () => {
    expect(isSalient({ ...base, tier: "semantic" })).toBe(true);
    expect(isSalient({ ...base, tier: "procedural" })).toBe(true);
    expect(isSalient({ ...base, tier: "Semantic" })).toBe(true); // case-insensitive
  });

  it("keeps episodic exchanges once they cross emotion or importance", () => {
    expect(isSalient({ ...base, emotionIntensity: 0.5 })).toBe(true);
    expect(isSalient({ ...base, importance: 0.6 })).toBe(true);
  });

  it("honors custom thresholds", () => {
    const strict = { emotionIntensity: 0.9, importance: 0.9 };
    expect(isSalient({ ...base, emotionIntensity: 0.6 }, strict)).toBe(false);
    expect(isSalient({ ...base, emotionIntensity: 0.6 }, DEFAULT_SALIENCE)).toBe(true);
  });
});
