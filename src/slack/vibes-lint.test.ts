import { describe, it, expect } from "bun:test";
import { lintVibesResponse } from "./vibes-lint.ts";

describe("lintVibesResponse", () => {
  it("passes a 1-line reply through unchanged", () => {
    const r = lintVibesResponse("lol fair");
    expect(r.text).toBe("lol fair");
    expect(r.truncated).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  it("passes a 3-line reply through unchanged", () => {
    const input = "line one\nline two\nline three";
    const r = lintVibesResponse(input);
    expect(r.text).toBe(input);
    expect(r.truncated).toBe(false);
  });

  it("truncates a 5-line reply down to first 3 non-empty lines", () => {
    const input = [
      "line one",
      "line two",
      "line three",
      "line four — this should disappear",
      "line five — gone too",
    ].join("\n");
    const r = lintVibesResponse(input);
    expect(r.truncated).toBe(true);
    expect(r.reasons.some((s) => s.startsWith("line-cap"))).toBe(true);
    expect(r.text.split("\n")).toEqual(["line one", "line two", "line three"]);
    expect(r.text).not.toContain("line four");
    expect(r.text).not.toContain("line five");
  });

  it("flattens a fake [6:45 PM] timestamp follow-up", () => {
    const input = [
      "lol fair",
      "",
      "[6:45 PM]",
      "actually one more thing — let me explain",
    ].join("\n");
    const r = lintVibesResponse(input);
    expect(r.truncated).toBe(true);
    expect(r.reasons).toContain("fake-timestamp");
    expect(r.text).toBe("lol fair");
    expect(r.text).not.toContain("6:45");
    expect(r.text).not.toContain("actually one more thing");
  });

  it("flattens a (continued) marker", () => {
    const input = "first thought\n(continued)\nand here is the second one";
    const r = lintVibesResponse(input);
    expect(r.truncated).toBe(true);
    expect(r.reasons).toContain("continuation-marker");
    expect(r.text).toBe("first thought");
  });

  it("flattens triple-newline multi-message intent", () => {
    const input = "first\n\n\nsecond paragraph that's really another post";
    const r = lintVibesResponse(input);
    expect(r.truncated).toBe(true);
    expect(r.reasons).toContain("triple-newline");
    expect(r.text).toBe("first");
  });

  it("ignores normal blank line between two short lines (still ≤3 lines)", () => {
    const input = "ok\n\nfine";
    const r = lintVibesResponse(input);
    expect(r.truncated).toBe(false);
  });

  it("returns input verbatim when empty", () => {
    expect(lintVibesResponse("")).toEqual({ text: "", truncated: false, reasons: [] });
  });
});
