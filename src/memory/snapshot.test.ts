import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  htmlToText,
  extractTitle,
  slugify,
  saveToArchive,
  existingArchive,
  captureSnapshot,
  type FetchLike,
} from "./snapshot.ts";

/** Minimal fetch double. Routes by URL substring to a queued response. */
function makeFetch(routes: Array<{ match: string; res: Partial<Awaited<ReturnType<FetchLike>>> }>): FetchLike {
  return async (input) => {
    const hit = routes.find((r) => input.includes(r.match));
    const headers = new Map<string, string>(Object.entries((hit?.res as any)?._headers ?? {}));
    return {
      ok: hit?.res.ok ?? true,
      status: hit?.res.status ?? 200,
      headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null },
      text: async () => (hit?.res as any)?._text ?? "",
    };
  };
}
function resp(opts: { ok?: boolean; status?: number; text?: string; headers?: Record<string, string> }) {
  return { ok: opts.ok, status: opts.status, _text: opts.text, _headers: opts.headers } as any;
}

describe("htmlToText", () => {
  it("strips tags, drops scripts/styles, and decodes entities", () => {
    const html =
      "<html><head><title>T</title><style>.x{}</style></head>" +
      "<body><script>evil()</script><h1>Privacy&nbsp;Policy</h1>" +
      "<p>We respect &amp; protect your data.</p><p>Effective 2026.</p></body></html>";
    const text = htmlToText(html);
    expect(text).toContain("Privacy Policy");
    expect(text).toContain("We respect & protect your data.");
    expect(text).toContain("Effective 2026.");
    expect(text).not.toContain("evil()");
    expect(text).not.toContain(".x{}");
    expect(text).not.toMatch(/<[^>]+>/);
  });

  it("turns block boundaries into newlines and collapses blank runs", () => {
    const text = htmlToText("<p>one</p><p>two</p><br><br><br><div>three</div>");
    expect(text.split("\n").filter(Boolean)).toEqual(["one", "two", "three"]);
  });

  it("decodes numeric and hex entities", () => {
    expect(htmlToText("a &#38; b &#x26; c")).toBe("a & b & c");
  });
});

describe("extractTitle", () => {
  it("prefers <title>, falls back to <h1>, else null", () => {
    expect(extractTitle("<title> Hello  World </title>")).toBe("Hello World");
    expect(extractTitle("<h1>Heading</h1>")).toBe("Heading");
    expect(extractTitle("<p>no title</p>")).toBeNull();
  });
});

describe("slugify", () => {
  it("lowercases, strips scheme, and bounds length", () => {
    expect(slugify("Privacy Policy!")).toBe("privacy-policy");
    expect(slugify("https://example.com/Terms")).toBe("example-com-terms");
    expect(slugify("")).toBe("snapshot");
    expect(slugify("x".repeat(200)).length).toBeLessThanOrEqual(60);
  });
});

describe("saveToArchive", () => {
  it("returns the archived URL from content-location", async () => {
    const f = makeFetch([
      { match: "web.archive.org/save", res: resp({ headers: { "content-location": "/web/20260507/https://e.com" } }) },
    ]);
    expect(await saveToArchive("https://e.com", f)).toBe("https://web.archive.org/web/20260507/https://e.com");
  });

  it("falls back to the memento link header", async () => {
    const f = makeFetch([
      { match: "save", res: resp({ headers: { link: '<https://web.archive.org/web/X/https://e.com>; rel="memento"' } }) },
    ]);
    expect(await saveToArchive("https://e.com", f)).toBe("https://web.archive.org/web/X/https://e.com");
  });

  it("returns null (fails soft) when archive.org errors or times out", async () => {
    const f: FetchLike = async () => { throw new Error("network down"); };
    expect(await saveToArchive("https://e.com", f)).toBeNull();
  });
});

describe("existingArchive", () => {
  it("reads closest snapshot from the availability API", async () => {
    const f = makeFetch([
      { match: "available", res: resp({ ok: true, text: JSON.stringify({ archived_snapshots: { closest: { url: "https://web.archive.org/web/Y/https://e.com" } } }) }) },
    ]);
    expect(await existingArchive("https://e.com", f)).toBe("https://web.archive.org/web/Y/https://e.com");
  });

  it("returns null when no snapshot exists", async () => {
    const f = makeFetch([{ match: "available", res: resp({ ok: true, text: JSON.stringify({ archived_snapshots: {} }) }) }]);
    expect(await existingArchive("https://e.com", f)).toBeNull();
  });
});

describe("captureSnapshot", () => {
  let card: string;
  let body: string;
  const now = new Date("2026-05-07T12:00:00.000Z");

  beforeEach(() => {
    const base = mkdtempSync(path.join(tmpdir(), "snap-"));
    card = path.join(base, "snapshots");
    body = path.join(base, ".snapshots");
  });
  afterEach(() => {
    rmSync(path.dirname(card), { recursive: true, force: true });
  });

  function onlyFile(dir: string): string {
    const day = readdirSync(dir)[0]!;
    const f = readdirSync(path.join(dir, day))[0]!;
    return path.join(dir, day, f);
  }

  it("writes a tiny indexed card and the full body in the dotdir, with archive URL", async () => {
    // Order matters: the save URL also contains "policy", so match it first.
    const f = makeFetch([
      { match: "web.archive.org/save", res: resp({ headers: { "content-location": "/web/20260507/https://e.com/policy" } }) },
      { match: "policy", res: resp({ text: "<title>Policy</title><body><h1>Policy</h1><p>" + "word ".repeat(5000) + "</p></body>" }) },
    ]);

    const r = await captureSnapshot({
      url: "https://e.com/policy", note: "for the dispute", now,
      fetchImpl: f, cardRoot: card, bodyRoot: body,
    });

    expect(r.archivedUrl).toBe("https://web.archive.org/web/20260507/https://e.com/policy");
    expect(r.title).toBe("Policy");

    const cardText = readFileSync(onlyFile(card), "utf-8");
    const bodyText = readFileSync(onlyFile(body), "utf-8");

    // Card is small and carries provenance; body holds the bulk text.
    expect(cardText).toContain("type: snapshot");
    expect(cardText).toContain("https://web.archive.org/web/20260507/https://e.com/policy");
    expect(cardText).toContain("for the dispute");
    expect(cardText.length).toBeLessThan(bodyText.length);
    expect(bodyText).toContain("word word");
    expect(bodyText).toContain("type: snapshot-body");

    // Day-partitioned by the injected clock.
    expect(existsSync(path.join(card, "2026-05-07"))).toBe(true);
  });

  it("snapshots literal text without a fetch, archiving the given --source", async () => {
    const f = makeFetch([{ match: "save", res: resp({ headers: { "content-location": "/web/Z/https://slack" } }) }]);
    const r = await captureSnapshot({
      text: "a message that might get edited later", source: "https://slack/x", title: "Slack note",
      now, fetchImpl: f, cardRoot: card, bodyRoot: body,
    });
    expect(r.source).toBe("https://slack/x");
    expect(r.archivedUrl).toBe("https://web.archive.org/web/Z/https://slack");
    expect(readFileSync(onlyFile(body), "utf-8")).toContain("a message that might get edited later");
  });

  it("still saves locally when archiving is disabled", async () => {
    const f = makeFetch([{ match: "x", res: resp({ text: "<p>hi there friend</p>" }) }]);
    const r = await captureSnapshot({
      url: "https://x.test", archive: false, now, fetchImpl: f, cardRoot: card, bodyRoot: body,
    });
    expect(r.archivedUrl).toBeNull();
    expect(readFileSync(onlyFile(body), "utf-8")).toContain("hi there friend");
  });

  it("throws on a failed fetch (caller reports it)", async () => {
    const f = makeFetch([{ match: "gone", res: resp({ ok: false, status: 404 }) }]);
    await expect(
      captureSnapshot({ url: "https://gone.test", now, fetchImpl: f, cardRoot: card, bodyRoot: body }),
    ).rejects.toThrow(/fetch failed/);
  });
});
