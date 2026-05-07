import type { App } from "@slack/bolt";
import { dueReminders, istDate, openDumpsSince } from "./store.ts";
import { log } from "../logger.ts";

interface DigestOptions {
  /** Channel ID where the morning digest is posted. */
  channel: string;
  /** Hour of day in IST (0-23). */
  hourIst: number;
  /** Minute of the hour. */
  minute: number;
}

const DEFAULTS: DigestOptions = {
  channel: process.env.DUMP_DIGEST_CHANNEL ?? "C_SANDBOX",
  hourIst: 9,
  minute: 0,
};

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function nextFireDelayMs(hourIst: number, minute: number): number {
  const now = new Date();
  const istNow = new Date(now.getTime() + IST_OFFSET_MS);
  const istTarget = new Date(istNow);
  istTarget.setUTCHours(hourIst, minute, 0, 0);
  if (istTarget <= istNow) {
    istTarget.setUTCDate(istTarget.getUTCDate() + 1);
  }
  return istTarget.getTime() - istNow.getTime();
}

export function buildDigest(): string | null {
  const today = istDate();
  const open = openDumpsSince(7);
  const reminders = dueReminders(today);

  if (open.length === 0 && reminders.length === 0) return null;

  const lines: string[] = [`🌅 *Morning digest — ${today}*`];

  if (reminders.length > 0) {
    lines.push("", "*Reminders due:*");
    for (const { entry, reminder } of reminders) {
      lines.push(`• \`${entry.id}\` (${reminder.date}) — ${entry.text}`);
    }
  }

  if (open.length > 0) {
    lines.push("", `*Still open (${open.length}):*`);
    for (const e of open) {
      const date = e.id.slice(0, 8);
      const pretty = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
      lines.push(`• \`${e.id}\` _(${pretty})_ — ${e.text}`);
    }
  }

  lines.push("", "_Mark something done with `!done <id>`._");
  return lines.join("\n");
}

export function startDumpDigest(
  app: App,
  partial: Partial<DigestOptions> = {},
): () => void {
  const opts: DigestOptions = { ...DEFAULTS, ...partial };
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const schedule = (): void => {
    const delay = nextFireDelayMs(opts.hourIst, opts.minute);
    log.info(
      "dumps/scheduler",
      `next digest in ${Math.round(delay / 60000)}m -> ${opts.channel}`,
    );
    timeout = setTimeout(async () => {
      try {
        const text = buildDigest();
        if (text) {
          await app.client.chat.postMessage({ channel: opts.channel, text });
          log.info("dumps/scheduler", "digest posted");
        } else {
          log.info("dumps/scheduler", "nothing to report — skipped");
        }
      } catch (err) {
        log.error("dumps/scheduler", `digest failed: ${err}`);
      } finally {
        schedule();
      }
    }, delay);
  };

  schedule();
  return () => {
    if (timeout) clearTimeout(timeout);
  };
}
