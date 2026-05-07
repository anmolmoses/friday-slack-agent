/**
 * Wayback-style snapshots — the "preserve an external source as it was on a
 * date" half of Friday's memory.
 *
 * Friday's auto-capture remembers what was *said*. It does NOT remember the
 * external artifacts she reads mid-conversation: a policy page, a PR
 * description, a doc, a Slack message that later gets edited or deleted. When
 * those sources drift or vanish, the memory keeps the discussion but not the
 * evidence. A snapshot fills that: a frozen, timestamped, provenance-stamped
 * copy of the source.
 *
 * Two files per snapshot:
 *   - CARD  (memory/snapshots/<date>/<ts>-<slug>.md) — tiny: frontmatter +
 *     summary + source URL + archive URL + a pointer to the full body. BOTH
 *     indexers pick this up, so it's recallable; it's small, so embedding it is
 *     cheap and it doesn't pollute associative recall with raw HTML.
 *   - BODY  (memory/.snapshots/<date>/<ts>-<slug>.md) — the full extracted text.
 *     Lives in a dotdir that both the BM25 corpus walk and the engram ingest
 *     walk skip, so it's never embedded. Friday reads it on demand by path.
 *
 * For web pages we also ping archive.org's "Save Page Now" so there's a public,
 * verifiable, dated archive URL anyone can check — stronger provenance than a
 * private local copy. That call is best-effort and fails soft: if archive.org
 * is slow or down we still save locally and fall back to recording any
 * pre-existing archive.
 *
 * Everything here fails soft. fetch is injectable so tests never touch the
 * network. Reindexing the new card is the caller's job (see cli.ts).
 */

import path from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { SNAPSHOTS_DIR, SNAPSHOTS_FULL_DIR, FRIDAY_ROOT } from "./paths.ts";

export type FetchLike = (
  input: string,
  init?: { method?: string; redirect?: "follow" | "manual"; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface SnapshotArgs {
  /** Page to fetch + archive. Omit when snapshotting literal text via `text`. */
  url?: string;
  /** Literal text to snapshot (e.g. a Slack message body). Skips the fetch. */
  text?: string;
  /** Source URL for `text` — archived for provenance even though we didn't fetch it. */
  source?: string;
  /** Human title; falls back to the page <title>, then the URL/host. */
  title?: string;
  /** Why this was preserved — shows on the card. */
  note?: string;
  /** Ask archive.org to Save Page Now. Default true when a URL is available. */
  archive?: boolean;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Clock injection for deterministic tests. */
  now?: Date;
  archiveTimeoutMs?: number;
  fetchTimeoutMs?: number;
  /** Override output roots (tests). Default to the real memory/ snapshot dirs. */
  cardRoot?: string;
  bodyRoot?: string;
}

export interface SnapshotResult {
  title: string;
  source: string | null;
  archivedUrl: string | null;
  /** Repo-relative path to the indexed card. */
  cardPath: string;
  /** Repo-relative path to the full body. */
  bodyPath: string;
  bytes: number;
}

const MAX_BODY_CHARS = 200_000;
const SUMMARY_CHARS = 600;

/** Strip a page to readable plain text. Dependency-free, deliberately simple. */
export function htmlToText(html: string): string {
  let s = html;
  // Drop content that never reads as text.
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style|noscript|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  // Turn block-level boundaries into newlines so structure survives.
  s = s.replace(/<\/(p|div|section|article|li|tr|h[1-6]|ul|ol|table|header|footer|blockquote)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  // Drop every remaining tag.
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  // Collapse whitespace: trim each line, drop runs of blank lines.
  s = s
    .split("\n")
    .map((l) => l.replace(/[ \t\f\v]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s;
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘",
    ldquo: "“", rdquo: "”", copy: "©", reg: "®", trade: "™",
  };
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const cp = code[1]?.toLowerCase() === "x"
        ? Number.parseInt(code.slice(2), 16)
        : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return named[code.toLowerCase()] ?? m;
  });
}

export function extractTitle(html: string): string | null {
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (t?.[1]) return decodeEntities(t[1]).replace(/\s+/g, " ").trim() || null;
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1?.[1]) return htmlToText(h1[1]).replace(/\s+/g, " ").trim() || null;
  return null;
}

export function slugify(s: string): string {
  return (s || "snapshot")
    .toLowerCase()
    .replace(/https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "snapshot";
}

function clip(s: string, n: number): string {
  const t = (s ?? "").trim();
  return t.length <= n ? t : t.slice(0, n - 1) + "…";
}

function yamlStr(s: string): string {
  return JSON.stringify(s ?? "");
}

async function withTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: { method?: string; redirect?: "follow" | "manual" },
  timeoutMs: number,
): Promise<Awaited<ReturnType<FetchLike>> | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask archive.org to save `url` now, returning the public archived URL. Reads
 * the `content-location` (or memento `link`) header of the Save Page Now
 * response. Returns null on any failure — the caller carries on regardless.
 */
export async function saveToArchive(url: string, fetchImpl: FetchLike, timeoutMs = 25_000): Promise<string | null> {
  const res = await withTimeout(fetchImpl, `https://web.archive.org/save/${url}`, { method: "GET", redirect: "follow" }, timeoutMs);
  if (!res) return null;
  const cl = res.headers.get("content-location");
  if (cl) return cl.startsWith("http") ? cl : `https://web.archive.org${cl}`;
  const link = res.headers.get("link");
  const m = link?.match(/<([^>]+)>;\s*rel="memento"/i);
  if (m?.[1]) return m[1];
  return null;
}

/** Nearest pre-existing archive of `url`, via the availability API. Null if none. */
export async function existingArchive(url: string, fetchImpl: FetchLike, timeoutMs = 10_000): Promise<string | null> {
  const res = await withTimeout(
    fetchImpl,
    `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`,
    { method: "GET", redirect: "follow" },
    timeoutMs,
  );
  if (!res || !res.ok) return null;
  try {
    const json = JSON.parse(await res.text()) as { archived_snapshots?: { closest?: { url?: string } } };
    return json.archived_snapshots?.closest?.url ?? null;
  } catch {
    return null;
  }
}

function rel(abs: string): string {
  return path.relative(FRIDAY_ROOT, abs).split(path.sep).join("/");
}

function dayStamp(now: Date): { day: string; ts: string } {
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return { day, ts: now.toISOString().replace(/[:.]/g, "-") };
}

function renderCard(fm: {
  date: string; title: string; source: string | null; archivedUrl: string | null;
  note: string; bodyRel: string; summary: string; bytes: number;
}): string {
  const bullets = [
    fm.source ? `- **Source:** ${fm.source}` : "- **Source:** (literal text)",
    fm.archivedUrl ? `- **Archived:** ${fm.archivedUrl}` : "- **Archived:** (none — local copy only)",
    `- **Captured:** ${fm.date}`,
    ...(fm.note ? [`- **Why:** ${fm.note}`] : []),
    `- **Full text:** ${fm.bodyRel}`,
  ];
  return [
    "---",
    `date: ${fm.date}`,
    "tier: semantic", // a snapshot is a stable, long-lived fact, not an episode
    "importance: 0.6",
    "metadata:",
    "  type: snapshot",
    "  emotion: neutral",
    "  emotion_intensity: 0",
    `  topic: ${yamlStr(fm.title)}`,
    `  source: ${yamlStr(fm.source ?? "")}`,
    `  archived_url: ${yamlStr(fm.archivedUrl ?? "")}`,
    `  captured_at: ${fm.date}`,
    `  body: ${yamlStr(fm.bodyRel)}`,
    `  bytes: ${fm.bytes}`,
    "---",
    "",
    `# Snapshot: ${fm.title}`,
    "",
    ...bullets,
    "",
    "## Summary",
    "",
    fm.summary || "(no extractable text)",
    "",
  ].join("\n");
}

function renderBody(fm: { date: string; title: string; source: string | null; archivedUrl: string | null }, text: string): string {
  return [
    "---",
    `date: ${fm.date}`,
    "metadata:",
    "  type: snapshot-body",
    `  title: ${yamlStr(fm.title)}`,
    `  source: ${yamlStr(fm.source ?? "")}`,
    `  archived_url: ${yamlStr(fm.archivedUrl ?? "")}`,
    "---",
    "",
    text,
    "",
  ].join("\n");
}

/**
 * Capture a snapshot. Fetches the URL (or uses literal `text`), extracts
 * readable text, best-effort archives the source on archive.org, and writes the
 * card + full body. Returns the written paths and the archive URL.
 */
export async function captureSnapshot(args: SnapshotArgs): Promise<SnapshotResult> {
  const fetchImpl = args.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const now = args.now ?? new Date();
  const sourceUrl = args.url ?? args.source ?? null;

  let text = (args.text ?? "").trim();
  let pageTitle: string | null = null;

  if (args.url) {
    const res = await withTimeout(fetchImpl, args.url, { method: "GET", redirect: "follow" }, args.fetchTimeoutMs ?? 30_000);
    if (!res || !res.ok) {
      throw new Error(`fetch failed for ${args.url}${res ? ` (HTTP ${res.status})` : " (network error/timeout)"}`);
    }
    const html = await res.text();
    pageTitle = extractTitle(html);
    text = htmlToText(html);
  }
  text = clip(text, MAX_BODY_CHARS);
  if (!text && !args.title) throw new Error("nothing to snapshot: no text extracted and no --title given");

  const title = (args.title || pageTitle || sourceUrl || "snapshot").replace(/\s+/g, " ").trim();

  // Best-effort public archive: Save Page Now, else nearest existing snapshot.
  let archivedUrl: string | null = null;
  const wantArchive = args.archive ?? Boolean(sourceUrl);
  if (wantArchive && sourceUrl) {
    archivedUrl =
      (await saveToArchive(sourceUrl, fetchImpl, args.archiveTimeoutMs ?? 25_000)) ??
      (await existingArchive(sourceUrl, fetchImpl));
  }

  const { day, ts } = dayStamp(now);
  const slug = slugify(title || sourceUrl || "snapshot");
  const cardDir = path.join(args.cardRoot ?? SNAPSHOTS_DIR, day);
  const bodyDir = path.join(args.bodyRoot ?? SNAPSHOTS_FULL_DIR, day);
  if (!existsSync(cardDir)) mkdirSync(cardDir, { recursive: true });
  if (!existsSync(bodyDir)) mkdirSync(bodyDir, { recursive: true });

  const cardAbs = path.join(cardDir, `${ts}-${slug}.md`);
  const bodyAbs = path.join(bodyDir, `${ts}-${slug}.md`);
  const date = now.toISOString();
  const bodyRel = rel(bodyAbs);

  // Summary = first lines of the extracted text, clipped — enough to make the
  // card searchable and to remind Friday what's inside without opening it.
  const summary = clip(text.split("\n").filter(Boolean).slice(0, 6).join(" "), SUMMARY_CHARS);

  writeFileSync(bodyAbs, renderBody({ date, title, source: sourceUrl, archivedUrl }, text || "(no extractable text)"), "utf-8");
  writeFileSync(
    cardAbs,
    renderCard({ date, title, source: sourceUrl, archivedUrl, note: args.note ?? "", bodyRel, summary, bytes: text.length }),
    "utf-8",
  );

  return { title, source: sourceUrl, archivedUrl, cardPath: rel(cardAbs), bodyPath: bodyRel, bytes: text.length };
}
