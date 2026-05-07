import type { App } from "@slack/bolt";
import { log } from "../logger.ts";
import { istDate } from "../dumps/store.ts";
import {
  FRIDAY_TEST_CHANNEL,
  type PendingStandup,
} from "./types.ts";
import { getPending, getMostRecentPrior, setPending } from "./state.ts";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

interface KickoffOptions {
  /** IST hour for kickoff (default 11). */
  hourIst: number;
  /** IST minute for kickoff (default 25). */
  minute: number;
  /** Channel to post the kickoff in. Defaults to #friday-test. */
  channel: string;
}

const DEFAULTS: KickoffOptions = {
  hourIst: 11,
  minute: 25,
  channel: FRIDAY_TEST_CHANNEL,
};

/**
 * Returns the ms-delay until the next IST hour:minute. If the next firing
 * lands on Saturday or Sunday, skip ahead to Monday.
 */
function nextWeekdayFireDelayMs(hourIst: number, minute: number): number {
  const now = new Date();
  const istNow = new Date(now.getTime() + IST_OFFSET_MS);
  const target = new Date(istNow);
  target.setUTCHours(hourIst, minute, 0, 0);
  if (target <= istNow) target.setUTCDate(target.getUTCDate() + 1);

  // Skip Sat (6) and Sun (0). UTC day-of-week of an IST-shifted instant
  // matches the IST calendar day, since we manipulated UTC fields.
  while (target.getUTCDay() === 6 || target.getUTCDay() === 0) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return target.getTime() - istNow.getTime();
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function ordinal(n: number): string {
  const s = n % 100;
  if (s >= 11 && s <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/** "7th May, 2026" from a YYYY-MM-DD IST date string. */
function prettyDate(istYmd: string): string {
  const [y, m, d] = istYmd.split("-").map(Number);
  return `${ordinal(d)} ${MONTHS[m - 1]}, ${y}`;
}

/**
 * Open a fresh thread in #friday-test asking the user for his yesterday/today
 * focus. Stores the thread ts so subsequent replies in that thread are
 * recognized as standup input.
 */
export async function kickoffStandup(
  app: App,
  channel: string = FRIDAY_TEST_CHANNEL,
): Promise<PendingStandup | null> {
  const today = istDate();

  const existing = getPending();
  if (existing && existing.date === today && existing.status !== "skipped") {
    log.info(
      "standup/scheduler",
      `kickoff skipped — pending standup already in flight (status=${existing.status})`,
    );
    return existing;
  }

  const prior = getMostRecentPrior(today);
  const carryNote = prior
    ? `\n_Yesterday (${prior.date}) for reference — I'll carry over and tick what's done:_\n${prior.finalText}`
    : "";

  const text =
    `*Focus for the day (${prettyDate(today)})* :thread:\n` +
    `What did you work on yesterday, and what will you work on today? ` +
    `Just dump it however — I'll format it and show you a draft before posting to the standup thread.` +
    carryNote;

  const resp = await app.client.chat.postMessage({
    channel,
    text,
  });

  if (!resp.ok || !resp.ts) {
    log.error("standup/scheduler", `kickoff post failed: ${resp.error ?? "unknown"}`);
    return null;
  }

  const pending: PendingStandup = {
    date: today,
    fridayTestThreadTs: resp.ts,
    status: "awaiting-input",
  };
  setPending(pending);
  log.info(
    "standup/scheduler",
    `kickoff posted in ${channel}, thread=${resp.ts}, date=${today}`,
  );
  return pending;
}

export function startStandupScheduler(
  app: App,
  partial: Partial<KickoffOptions> = {},
): () => void {
  const opts: KickoffOptions = { ...DEFAULTS, ...partial };
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const schedule = (): void => {
    const delay = nextWeekdayFireDelayMs(opts.hourIst, opts.minute);
    log.info(
      "standup/scheduler",
      `next standup kickoff in ${Math.round(delay / 60000)}m -> ${opts.channel}`,
    );
    timeout = setTimeout(async () => {
      try {
        await kickoffStandup(app, opts.channel);
      } catch (err) {
        log.error("standup/scheduler", `kickoff failed: ${err}`);
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
