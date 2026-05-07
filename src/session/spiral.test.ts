import { describe, it, expect } from "bun:test";
import { createSession } from "./types.ts";
import {
  classifyJab,
  countSpiralMarkers,
  pruneRecentJabs,
  recordJab,
  shouldInjectRagebaitMode,
  shouldInjectSpiralBrake,
  spiralBrakeFragment,
  ragebaitFragment,
  updateSpiralScore,
} from "./spiral.ts";

const VIBES = "C_VIBES"; // a vibes channel
const TEAMMATE = "U_TEAMMATE";

describe("countSpiralMarkers", () => {
  it("matches case-insensitively across the documented markers", () => {
    expect(countSpiralMarkers("Pathetic.")).toBe(1);
    expect(countSpiralMarkers("I'm done. Friday out.")).toBe(2);
    expect(countSpiralMarkers("not taking the bait, goodnight")).toBe(2);
    expect(countSpiralMarkers("for real this time, i'll be quiet")).toBe(2);
    expect(countSpiralMarkers("don't @ me")).toBe(1);
  });

  it("does not match unrelated text", () => {
    expect(countSpiralMarkers("just shipped the fix, looks good")).toBe(0);
    expect(countSpiralMarkers("the donor list is done")).toBe(0); // 'done' as a noun
  });
});

describe("updateSpiralScore + shouldInjectSpiralBrake", () => {
  it("increments on a self-deprecating reply, decays on a clean one", () => {
    const s = createSession("t1", VIBES);
    expect(s.spiralScore).toBe(0);

    updateSpiralScore(s, "i'm done. pathetic.");
    expect(s.spiralScore).toBe(2);
    expect(shouldInjectSpiralBrake(s)).toBe(true);

    updateSpiralScore(s, "shipped the patch, lgtm");
    expect(s.spiralScore).toBe(1);
    expect(shouldInjectSpiralBrake(s)).toBe(false);

    updateSpiralScore(s, "still good, no notes");
    expect(s.spiralScore).toBe(0);
  });

  it("does not go negative", () => {
    const s = createSession("t2", VIBES);
    for (let i = 0; i < 10; i++) updateSpiralScore(s, "all good");
    expect(s.spiralScore).toBe(0);
  });

  it("caps the score so noisy threads don't keep climbing forever", () => {
    const s = createSession("t3", VIBES);
    for (let i = 0; i < 20; i++) {
      updateSpiralScore(s, "pathetic. i'm done. friday out.");
    }
    expect(s.spiralScore).toBeLessThanOrEqual(5);
    expect(shouldInjectSpiralBrake(s)).toBe(true);
  });

  it("brake fragment is injectable text mentioning the spiral scar", () => {
    const frag = spiralBrakeFragment();
    expect(frag).toContain("SPIRAL DETECTED");
    expect(frag).toContain("real spiral");
  });
});

describe("classifyJab", () => {
  it("flags @Friday + bait token as a jab", () => {
    const r = classifyJab({
      text: "<@U_OWNER> prove it. liar.",
      mentionsFriday: true,
    });
    expect(r.isJab).toBe(true);
    expect(r.reasons.some((x) => x.includes("bait-token"))).toBe(true);
  });

  it("flags Friday-reference + bait token without explicit mention", () => {
    const r = classifyJab({
      text: "friday's SOUL.md says she's not a liar lol",
      mentionsFriday: false,
    });
    expect(r.isJab).toBe(true);
  });

  it("does not flag a normal vibes-channel message", () => {
    const r = classifyJab({
      text: "anyone watch the match yesterday",
      mentionsFriday: false,
    });
    expect(r.isJab).toBe(false);
  });

  it("treats bare @Friday as a soft jab (counts when it repeats)", () => {
    const r = classifyJab({
      text: "<@U_OWNER>",
      mentionsFriday: true,
    });
    expect(r.isJab).toBe(true);
    expect(r.reasons).toContain("@friday-only");
  });
});

describe("recordJab + shouldInjectRagebaitMode", () => {
  it("trips ragebait mode after 3 jabs from same user in window", () => {
    const s = createSession("t4", VIBES);
    const t0 = Date.UTC(2026, 3, 1, 12, 0, 0);
    recordJab(s, TEAMMATE, "liar", t0);
    recordJab(s, TEAMMATE, "prove it", t0 + 60_000);
    expect(shouldInjectRagebaitMode(s, t0 + 60_000)).toBe(false);
    recordJab(s, TEAMMATE, "the bin", t0 + 5 * 60_000);
    expect(shouldInjectRagebaitMode(s, t0 + 5 * 60_000)).toBe(true);
  });

  it("does not trip when jabs come from different users", () => {
    const s = createSession("t5", VIBES);
    const t0 = Date.now();
    recordJab(s, "U-A", "liar", t0);
    recordJab(s, "U-B", "prove it", t0);
    recordJab(s, "U-C", "show me", t0);
    expect(shouldInjectRagebaitMode(s, t0)).toBe(false);
  });

  it("ages out jabs past the 15-minute window", () => {
    const s = createSession("t6", VIBES);
    const t0 = Date.UTC(2026, 3, 1, 12, 0, 0);
    recordJab(s, TEAMMATE, "liar", t0);
    recordJab(s, TEAMMATE, "prove it", t0 + 60_000);
    recordJab(s, TEAMMATE, "the bin", t0 + 2 * 60_000);
    expect(shouldInjectRagebaitMode(s, t0 + 2 * 60_000)).toBe(true);

    // 30 minutes later, all old jabs are out of window.
    pruneRecentJabs(s, t0 + 30 * 60_000);
    expect(s.recentJabs.length).toBe(0);
    expect(shouldInjectRagebaitMode(s, t0 + 30 * 60_000)).toBe(false);
  });

  it("ragebait fragment is injectable text", () => {
    const frag = ragebaitFragment();
    expect(frag).toContain("RAGEBAIT MODE");
    expect(frag.toLowerCase()).toContain("one reply");
  });
});
