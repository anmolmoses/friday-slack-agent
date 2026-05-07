import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { decayEffectiveAge, shouldArchive, pruneShortTerm } from "./decay.ts";

describe("decayEffectiveAge", () => {
  it("is identity for emotionless memories", () => {
    expect(decayEffectiveAge(30, 0, 4)).toBe(30);
  });

  it("stretches life with emotional intensity", () => {
    expect(decayEffectiveAge(30, 1, 4)).toBeCloseTo(6, 5); // /5
    expect(decayEffectiveAge(30, 0.5, 4)).toBeCloseTo(10, 5); // /3
  });

  it("clamps out-of-range intensity", () => {
    expect(decayEffectiveAge(30, 5, 4)).toBeCloseTo(6, 5);
    expect(decayEffectiveAge(30, -1, 4)).toBe(30);
  });
});

describe("shouldArchive", () => {
  const opts = { halfLifeDays: 14, k: 4 };

  it("archives an old, neutral, unrecalled memory", () => {
    expect(shouldArchive({ ageDays: 30, emotionIntensity: 0, recentlyRecalled: false, promoted: false }, opts)).toBe(true);
  });

  it("keeps a fresh memory", () => {
    expect(shouldArchive({ ageDays: 5, emotionIntensity: 0, recentlyRecalled: false, promoted: false }, opts)).toBe(false);
  });

  it("keeps an old but emotionally intense memory (flashbulb persistence)", () => {
    // effectiveAge = 30 / 5 = 6 < 14
    expect(shouldArchive({ ageDays: 30, emotionIntensity: 1, recentlyRecalled: false, promoted: false }, opts)).toBe(false);
  });

  it("always keeps recalled-recently or promoted memories regardless of age", () => {
    expect(shouldArchive({ ageDays: 999, emotionIntensity: 0, recentlyRecalled: true, promoted: false }, opts)).toBe(false);
    expect(shouldArchive({ ageDays: 999, emotionIntensity: 0, recentlyRecalled: false, promoted: true }, opts)).toBe(false);
  });
});

describe("pruneShortTerm", () => {
  let dir: string;
  let root: string;
  let archive: string;

  const NOW = Date.parse("2026-06-04T00:00:00.000Z");
  const daysAgo = (n: number) => new Date(NOW - n * 24 * 3600 * 1000).toISOString();

  function writeMemo(name: string, opts: { date: string; intensity?: number }): void {
    const body = [
      "---",
      `date: ${opts.date}`,
      "tier: episodic",
      "importance: 0.4",
      "metadata:",
      "  emotion: neutral",
      `  emotion_intensity: ${opts.intensity ?? 0}`,
      "---",
      "",
      "**Them:** something",
    ].join("\n");
    writeFileSync(path.join(root, name), body);
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "decay-"));
    root = path.join(dir, "conversations");
    archive = path.join(dir, ".archive");
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("archives aged neutral files and keeps fresh / emotional ones", () => {
    writeMemo("old-neutral.md", { date: daysAgo(40), intensity: 0 });
    writeMemo("fresh.md", { date: daysAgo(2), intensity: 0 });
    writeMemo("old-emotional.md", { date: daysAgo(40), intensity: 1 }); // effAge 8 < 14

    const res = pruneShortTerm({
      root, archiveRoot: archive, now: NOW,
      recentlyRecalled: new Set(), promoted: new Set(),
    });

    expect(res.scanned).toBe(3);
    expect(res.archived).toBe(1);
    expect(res.kept).toBe(2);
    expect(existsSync(path.join(root, "old-neutral.md"))).toBe(false);
    expect(existsSync(path.join(archive, "old-neutral.md"))).toBe(true);
    expect(existsSync(path.join(root, "fresh.md"))).toBe(true);
    expect(existsSync(path.join(root, "old-emotional.md"))).toBe(true);
  });

  it("dryRun reports without moving anything", () => {
    writeMemo("old.md", { date: daysAgo(40), intensity: 0 });
    const res = pruneShortTerm({
      root, archiveRoot: archive, now: NOW, dryRun: true,
      recentlyRecalled: new Set(), promoted: new Set(),
    });
    expect(res.archived).toBe(1);
    expect(existsSync(path.join(root, "old.md"))).toBe(true);
    expect(existsSync(archive)).toBe(false);
  });

  it("keeps a file whose path is in the recalled set", () => {
    writeMemo("old.md", { date: daysAgo(40), intensity: 0 });
    const rel = path.relative(path.resolve(import.meta.dir, "../.."), path.join(root, "old.md"));
    const res = pruneShortTerm({
      root, archiveRoot: archive, now: NOW,
      recentlyRecalled: new Set([rel]), promoted: new Set(),
    });
    expect(res.archived).toBe(0);
    expect(existsSync(path.join(root, "old.md"))).toBe(true);
  });

  it("is a no-op on an empty / missing tree", () => {
    const res = pruneShortTerm({
      root: path.join(dir, "nope"), archiveRoot: archive, now: NOW,
      recentlyRecalled: new Set(), promoted: new Set(),
    });
    expect(res).toEqual({ scanned: 0, archived: 0, kept: 0, archivedPaths: [] });
  });
});
