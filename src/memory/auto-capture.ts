/**
 * Auto-capture — the "remember what was said" half of Friday's memory, with
 * structured + emotional tagging.
 *
 * After each turn the exchange is held in a per-process WORKING buffer (in
 * memory, no disk, emotion-free) — the live --resume transcript is the real
 * working memory; this buffer just stages the exchange for the salience gate.
 * A debounced (5s) batch then asks the LLM to TAG the buffered exchanges —
 * tier (episodic/semantic/procedural → the short/long-term split), importance,
 * emotion + intensity, topic, people — and only those that clear the salience
 * gate (T1, see salience.ts) are written to memory/conversations/<date>/ as
 * first-class short-term files + incrementally reindexed. The rest evaporate.
 *
 * Fails soft two ways: if tagging fails, the whole batch persists with basic
 * tags (we'd rather over-capture than lose memory on an LLM hiccup); and the
 * gate can be disabled with ENGRAM_CAPTURE_GATE=0 (persist everything, the
 * pre-T1 behavior). OFF BY DEFAULT — ENGRAM_CAPTURE=1.
 */

import path from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { log } from "../logger.ts";
import { reindexIncremental, tagExchanges } from "./engram-bridge.ts";
import {
  isSalient,
  detectExplicitRemember,
  detectStablePreference,
} from "./salience.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const CONV_ROOT = path.join(REPO_ROOT, "memory", "conversations");
const MIN_CAPTURE_CHARS = 12;

export function engramCaptureEnabled(): boolean {
  return process.env.ENGRAM_CAPTURE === "1";
}

/** The salience gate is on unless explicitly disabled (rollback to pre-T1). */
function captureGateEnabled(): boolean {
  return process.env.ENGRAM_CAPTURE_GATE !== "0";
}

interface Pending {
  file: string; // target path, written only if the exchange clears the gate
  body: string;
  explicit: boolean; // user asked to remember → always salient
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
 * Stage one exchange in the working buffer and schedule the batched tag +
 * salience gate. Nothing touches disk here — only salient exchanges are
 * persisted later (see enrichAndReindex). No-op when disabled or trivial.
 */
export function captureExchange(args: {
  channel: string; channelName?: string | null; threadId: string;
  user: string | null; userText: string; reply: string;
}): void {
  if (!engramCaptureEnabled()) return;
  const userText = (args.userText ?? "").trim();
  if (userText.length < MIN_CAPTURE_CHARS) return;

  try {
    const now = new Date();
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    // Target path is computed at capture time (so filenames keep capture order)
    // but the file is only written if the exchange clears the gate.
    const file = path.join(dayDir(), `${stamp}-${args.threadId.replace(/\./g, "_")}.md`);
    const replyText = args.reply ?? "";
    const body = `**Them:** ${clip(userText, 1500)}\n\n**Friday:** ${clip(replyText, 1500)}`;

    pending.push({
      file,
      body,
      explicit:
        detectExplicitRemember(userText) ||
        detectStablePreference(`${userText}\n${replyText}`),
      base: {
        date: now.toISOString(), author: args.user,
        channel: args.channelName ? `#${args.channelName}` : args.channel, thread: args.threadId,
      },
    });
    scheduleEnrich();
  } catch (err) {
    log.warn("engram", `captureExchange failed: ${err}`);
  }
}

/** Write one buffered exchange to disk with the given tags. */
function persist(b: Pending, tag: {
  tier: string; importance: number; emotion: string; emotionIntensity: number;
  topic: string; people: string; enriched: boolean; summary?: string;
}): void {
  const dir = path.dirname(b.file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(b.file, renderFile(b.body, {
    date: b.base.date, tier: tag.tier, importance: tag.importance, emotion: tag.emotion,
    emotionIntensity: tag.emotionIntensity, topic: tag.topic, people: tag.people,
    author: b.base.author, channel: b.base.channel, thread: b.base.thread,
    enriched: tag.enriched, summary: tag.summary,
  }), "utf-8");
}

function scheduleEnrich(): void {
  if (enrichTimer) clearTimeout(enrichTimer);
  enrichTimer = setTimeout(() => { enrichTimer = null; void enrichAndReindex(); }, 5_000);
}

/**
 * Tag the buffered exchanges (LLM), gate them on salience, persist the
 * survivors, then reindex. On tagging failure, fail soft: persist the whole
 * batch with basic tags rather than lose memory.
 */
async function enrichAndReindex(): Promise<void> {
  const batch = pending.splice(0, pending.length);
  if (batch.length === 0) return;

  let persisted = 0;
  try {
    const tags = await tagExchanges(batch.map((b) => b.body));

    if (!tags) {
      // Tagging unavailable — degrade to pre-T1: persist everything, basic tags.
      for (const b of batch) {
        try {
          persist(b, {
            tier: "episodic", importance: 0.5, emotion: "neutral", emotionIntensity: 0,
            topic: "", people: b.base.author ?? "", enriched: false,
          });
          persisted++;
        } catch { /* skip this one */ }
      }
      log.warn("engram", `tagging unavailable — persisted ${persisted} exchange(s) with basic tags`);
    } else {
      const gated = captureGateEnabled();
      let dropped = 0;
      for (let i = 0; i < batch.length; i++) {
        const b = batch[i]!, t = tags[i]!;
        const salient = !gated || isSalient({
          emotionIntensity: t.emotionIntensity ?? 0,
          importance: t.importance ?? 0,
          tier: t.tier || "episodic",
          explicit: b.explicit,
        });
        if (!salient) { dropped++; continue; } // evaporates with working memory
        // Merge LLM-extracted people with the author handle.
        const people = [...new Set([...(t.people ?? []), b.base.author].filter(Boolean) as string[])].join(", ");
        try {
          persist(b, {
            tier: t.tier || "episodic", importance: t.importance ?? 0.5,
            emotion: t.emotion || "neutral", emotionIntensity: t.emotionIntensity ?? 0,
            topic: t.topic || "", people, enriched: true, summary: t.summary,
          });
          persisted++;
        } catch { /* skip this one */ }
      }
      log.info("engram", `salience gate: kept ${persisted}, dropped ${dropped} of ${batch.length} exchange(s)`);
    }
  } catch (err) {
    log.warn("engram", `enrichment failed: ${err}`);
  }

  if (persisted > 0) await reindexIncremental();
}
