/**
 * Auto-capture — the "remember what was said" half of Friday's memory, with
 * structured + emotional tagging.
 *
 * After each turn, the exchange is written as its OWN markdown file under
 * memory/conversations/<date>/ with frontmatter tags, so engram indexes it as a
 * first-class, typed memory (not an untagged blob). Capture is instant with
 * basic tags; a debounced (5s) batch then asks the LLM to ENRICH the new files
 * — tier (episodic/semantic/procedural → the short/long-term split), importance,
 * emotion + intensity, topic, people — rewrites their frontmatter, and runs an
 * incremental reindex so they're recallable within seconds.
 *
 * Everything fails soft: if tagging fails, the basic-tagged memory still
 * persists and indexes. OFF BY DEFAULT — ENGRAM_CAPTURE=1.
 */

import path from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { log } from "../logger.ts";
import { reindexIncremental, tagExchanges } from "./engram-bridge.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const CONV_ROOT = path.join(REPO_ROOT, "memory", "conversations");
const MIN_CAPTURE_CHARS = 12;

export function engramCaptureEnabled(): boolean {
  return process.env.ENGRAM_CAPTURE === "1";
}

interface Pending {
  file: string;
  body: string;
  base: { date: string; author: string | null; channel: string; thread: string };
}
const pending: Pending[] = [];
let enrichTimer: ReturnType<typeof setTimeout> | null = null;

function dayDir(): string {
  const d = new Date();
  return path.join(CONV_ROOT, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
}

function clip(s: string, n: number): string {
  const t = (s ?? "").replace(/\r/g, "").trim();
  return t.length <= n ? t : t.slice(0, n - 1) + "…";
}

function yamlStr(s: string): string {
  return JSON.stringify(s ?? ""); // double-quoted, escapes — valid for the frontmatter parser
}

/** Build a memory file: frontmatter (tags) + the exchange body. */
function renderFile(body: string, fm: {
  date: string; tier: string; importance: number; emotion: string; emotionIntensity: number;
  topic: string; people: string; author: string | null; channel: string; thread: string; enriched: boolean; summary?: string;
}): string {
  return [
    "---",
    `date: ${fm.date}`,
    `tier: ${fm.tier}`,
    `importance: ${fm.importance}`,
    "metadata:",
    `  type: ${fm.tier}`,
    `  emotion: ${fm.emotion}`,
    `  emotion_intensity: ${fm.emotionIntensity}`,
    `  topic: ${yamlStr(fm.topic)}`,
    `  people: ${yamlStr(fm.people)}`,
    `  author: ${yamlStr(fm.author ?? "")}`,
    `  channel: ${yamlStr(fm.channel)}`,
    `  thread: ${yamlStr(fm.thread)}`,
    `  enriched: ${fm.enriched}`,
    ...(fm.summary ? [`  summary: ${yamlStr(fm.summary)}`] : []),
    "---",
    "",
    body,
    "",
  ].join("\n");
}

/**
 * Persist one exchange as a tagged memory file (basic tags now), and schedule a
 * batched LLM enrichment + incremental reindex. No-op when disabled or trivial.
 */
export function captureExchange(args: {
  channel: string; channelName?: string | null; threadId: string;
  user: string | null; userText: string; reply: string;
}): void {
  if (!engramCaptureEnabled()) return;
  const userText = (args.userText ?? "").trim();
  if (userText.length < MIN_CAPTURE_CHARS) return;

  try {
    const dir = dayDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const now = new Date();
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `${stamp}-${args.threadId.replace(/\./g, "_")}.md`);
    const body = `**Them:** ${clip(userText, 1500)}\n\n**Friday:** ${clip(args.reply ?? "", 1500)}`;

    // Basic tags now — episodic, neutral, mid importance. Enrichment refines these.
    writeFileSync(file, renderFile(body, {
      date: now.toISOString(), tier: "episodic", importance: 0.5, emotion: "neutral",
      emotionIntensity: 0, topic: "", people: args.user ?? "", author: args.user,
      channel: args.channelName ? `#${args.channelName}` : args.channel, thread: args.threadId, enriched: false,
    }), "utf-8");

    pending.push({ file, body, base: { date: now.toISOString(), author: args.user, channel: args.channelName ? `#${args.channelName}` : args.channel, thread: args.threadId } });
    scheduleEnrich();
  } catch (err) {
    log.warn("engram", `captureExchange failed: ${err}`);
  }
}

function scheduleEnrich(): void {
  if (enrichTimer) clearTimeout(enrichTimer);
  enrichTimer = setTimeout(() => { enrichTimer = null; void enrichAndReindex(); }, 5_000);
}

/** Tag the queued exchanges (LLM), rewrite their frontmatter, then reindex. */
async function enrichAndReindex(): Promise<void> {
  const batch = pending.splice(0, pending.length);
  if (batch.length === 0) return;

  try {
    const tags = await tagExchanges(batch.map((b) => b.body));
    if (tags) {
      for (let i = 0; i < batch.length; i++) {
        const b = batch[i]!, t = tags[i]!;
        // Merge LLM-extracted people with the author handle.
        const people = [...new Set([...(t.people ?? []), b.base.author].filter(Boolean) as string[])].join(", ");
        try {
          writeFileSync(b.file, renderFile(b.body, {
            date: b.base.date, tier: t.tier || "episodic", importance: t.importance ?? 0.5,
            emotion: t.emotion || "neutral", emotionIntensity: t.emotionIntensity ?? 0,
            topic: t.topic || "", people, author: b.base.author,
            channel: b.base.channel, thread: b.base.thread, enriched: true, summary: t.summary,
          }), "utf-8");
        } catch { /* keep basic file */ }
      }
      log.info("engram", `enriched ${batch.length} captured exchange(s)`);
    }
  } catch (err) {
    log.warn("engram", `enrichment failed (keeping basic tags): ${err}`);
  }

  await reindexIncremental();
}
