/**
 * Auto-capture — the "remember what was said" half of Friday's memory.
 *
 * Recall (engram-bridge.ts) only surfaces what's been WRITTEN to memory/. By
 * default that's whatever Friday chooses to jot in her daily notes — so a lot
 * of what you tell her is never persisted and can never be recalled later.
 *
 * This closes that gap: after each turn, the user's message + Friday's reply are
 * appended to memory/conversations/<date>.md — a durable, append-only transcript
 * that engram indexes like any other memory. A debounced *incremental* reindex
 * (only the new lines get embedded) makes the exchange recallable within seconds,
 * cheaply, even with a paid embedder.
 *
 * OFF BY DEFAULT. Enable with ENGRAM_CAPTURE=1.
 */

import path from "node:path";
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { log } from "../logger.ts";
import { reindexIncremental } from "./engram-bridge.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const CONV_DIR = path.join(REPO_ROOT, "memory", "conversations");

// Skip trivial one-liners ("ok", "lol", reactions) — they're noise, not memory.
const MIN_CAPTURE_CHARS = 12;

export function engramCaptureEnabled(): boolean {
  return process.env.ENGRAM_CAPTURE === "1";
}

let reindexTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced incremental reindex so a burst of messages triggers one reindex. */
function scheduleReindex(): void {
  if (reindexTimer) clearTimeout(reindexTimer);
  reindexTimer = setTimeout(() => {
    reindexTimer = null;
    reindexIncremental().then((ok) => {
      if (ok) log.info("engram", "captured exchange(s) indexed (incremental)");
    });
  }, 15_000);
}

function todayFile(): string {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return path.join(CONV_DIR, `${day}.md`);
}

function clip(s: string, n: number): string {
  const t = s.replace(/\r/g, "").trim();
  return t.length <= n ? t : t.slice(0, n - 1) + "…";
}

/**
 * Persist one exchange to today's conversation log and schedule a reindex.
 * No-op when disabled or when the user message is too trivial to be worth
 * remembering. Fails soft — a capture failure must never affect the turn.
 */
export function captureExchange(args: {
  channel: string;
  channelName?: string | null;
  threadId: string;
  user: string | null;
  userText: string;
  reply: string;
}): void {
  if (!engramCaptureEnabled()) return;
  const userText = (args.userText ?? "").trim();
  if (userText.length < MIN_CAPTURE_CHARS) return;

  try {
    if (!existsSync(CONV_DIR)) mkdirSync(CONV_DIR, { recursive: true });
    const time = new Date().toTimeString().slice(0, 5);
    const who = args.user ? `<@${args.user}>` : "user";
    const where = args.channelName ? `#${args.channelName}` : args.channel;
    const entry =
      `\n### ${time} · ${who} in ${where} (thread ${args.threadId})\n` +
      `**Them:** ${clip(userText, 1500)}\n\n` +
      `**Friday:** ${clip(args.reply ?? "", 1500)}\n`;
    appendFileSync(todayFile(), entry, "utf-8");
    scheduleReindex();
  } catch (err) {
    log.warn("engram", `captureExchange failed: ${err}`);
  }
}
