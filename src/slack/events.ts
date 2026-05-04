import type { App } from "@slack/bolt";
import type { SessionStore } from "../session/store/interface.ts";
import { parseCommand } from "./commands.ts";
import { createSession } from "../session/types.ts";
import { evaluateRouting, type RoutingHint } from "./routing.ts";
import { log } from "../logger.ts";

export interface SlackFileAttachment {
  url: string;
  name: string;
  mimetype: string;
}

export interface SlackMessageEvent {
  threadId: string;
  channel: string;
  user: string;
  text: string;
  ts: string;
  command: string | null;
  files?: SlackFileAttachment[];
  /** Non-null when Friday was auto-routed instead of @mentioned. */
  routingHint?: RoutingHint;
}

export type OnMessageCallback = (event: SlackMessageEvent) => void;

// Anmol's Slack user ID — FRIDAY responds when he's mentioned
const ANMOL_USER_ID = "U09SZ4DM8TH";

export function registerEventHandlers(
  app: App,
  onMessage: OnMessageCallback,
  store?: SessionStore,
  selfBotId?: string, // Slack Bot ID (B…), used to filter our own posts
  selfUserId?: string, // Slack User ID (U…), used to recognize @mentions of Friday
): void {
  app.event("message", async ({ event }) => {
    // Friday's own messages — drop to avoid self-loop
    if ("bot_id" in event && selfBotId && (event as { bot_id: string }).bot_id === selfBotId) return;

    const text = "text" in event ? event.text : undefined;
    if (!text) return;

    const user = "user" in event ? event.user : undefined;
    if (!user) return;

    const isThread = "thread_ts" in event && !!event.thread_ts;
    const isDM = event.channel_type === "im";
    const mentionsFriday = selfUserId
      ? text.includes(`<@${selfUserId}>`)
      : false;
    const mentionsAnmol = text.includes(`<@${ANMOL_USER_ID}>`);

    // Find any other @mentions in the text — if the message addresses someone
    // who isn't Friday or Anmol, Friday should defer (e.g. Pranav typing
    // "@Junior do X" in a thread Friday is also in — she shouldn't barge in).
    const allMentions = [...text.matchAll(/<@([A-Z0-9]+)>/g)].map((m) => m[1]);
    const mentionsSomeoneElse = allMentions.some(
      (id) => id && id !== selfUserId && id !== ANMOL_USER_ID,
    );

    // Other bots (e.g. Junior, Slackbot, GitHub webhooks) — only engage when
    // they explicitly @mention Friday or @mention Anmol. Otherwise their
    // chatter (status pings, thinking traces, sentinels like NO_SLACK_MESSAGE)
    // would spawn turns and create bot↔bot loops.
    const isOtherBot = "bot_id" in event && !!(event as { bot_id?: string }).bot_id;
    if (isOtherBot && !mentionsFriday && !mentionsAnmol) {
      return;
    }

    // Message explicitly addressed to someone else (not Friday, not Anmol) —
    // even if Friday has a session in this thread, she stays out of it.
    if (mentionsSomeoneElse && !mentionsFriday && !mentionsAnmol) {
      return;
    }

    // Pattern-based routing: decide whether Friday should handle this
    // even without an @mention (PR URLs in the review channel, bug reports,
    // explicit "catch me up" asks, etc).
    const routing = evaluateRouting({
      channel: event.channel,
      user,
      text,
      isThreadRoot: !isThread,
      mentionsFriday,
    });

    const gated = !isThread && !isDM && !mentionsAnmol && !routing.shouldRoute;
    if (gated) return;

    if (isThread && !mentionsAnmol && !routing.shouldRoute && store) {
      // Only respond in threads where the bot has already participated.
      // Local session store is the cheap path; fall back to asking Slack
      // whether Friday previously posted in this thread so she doesn't
      // lose participation across restarts.
      const threadTs = "thread_ts" in event ? event.thread_ts! : event.ts;
      let session = await store.get(threadTs);

      if (!session && selfBotId) {
        const participated = await didBotParticipate(
          app,
          event.channel,
          threadTs,
          selfBotId,
        );
        if (participated) {
          session = createSession(threadTs, event.channel);
          await store.set(threadTs, session);
          log.info(
            "hydrate",
            `thread=${threadTs} channel=${event.channel} — hydrated from prior participation`,
          );
        }
      }

      if (!session) return;
    }

    const threadId =
      "thread_ts" in event && event.thread_ts ? event.thread_ts : event.ts;

    const parsed = parseCommand(text);

    // Commands (`!reset`, `!status`, `!build`, etc.) are control-plane —
    // only Anmol can invoke them. From anyone else, treat as plain text.
    if (parsed.command && user !== ANMOL_USER_ID) {
      log.info(
        "command-blocked",
        `thread=${threadId} user=${user} cmd=${parsed.command} — only Anmol can invoke`,
      );
      parsed.command = null;
      parsed.text = text; // restore the literal `!cmd ...` so context is preserved
    }

    // Extract file attachments if present
    const files = extractFiles(event);

    if (routing.hint) {
      log.info(
        "routing",
        `thread=${threadId} channel=${event.channel} hint=${routing.hint} reason=${routing.reason}`,
      );
    }

    onMessage({
      threadId,
      channel: event.channel,
      user,
      text: parsed.text,
      ts: event.ts,
      command: parsed.command,
      files: files.length > 0 ? files : undefined,
      routingHint: routing.hint ?? undefined,
    });
  });

  app.event("app_mention", async ({ event }) => {
    if (!event.user) return;

    const threadId = event.thread_ts ?? event.ts;

    // Strip bot mention from text (Slack includes <@BOTID> in app_mention events)
    const cleanText = event.text.replace(/<@[A-Z0-9]+>\s*/g, "").trim();
    const parsed = parseCommand(cleanText);

    // Commands are Anmol-only.
    if (parsed.command && event.user !== ANMOL_USER_ID) {
      log.info(
        "command-blocked",
        `thread=${threadId} user=${event.user} cmd=${parsed.command} — only Anmol can invoke`,
      );
      parsed.command = null;
      parsed.text = cleanText;
    }

    const routing = evaluateRouting({
      channel: event.channel,
      user: event.user,
      text: cleanText,
      isThreadRoot: !event.thread_ts,
      mentionsFriday: true,
    });

    // Extract file attachments if present
    const files = extractFiles(event);

    if (routing.hint) {
      log.info(
        "routing",
        `thread=${threadId} channel=${event.channel} hint=${routing.hint} reason=${routing.reason}`,
      );
    }

    onMessage({
      threadId,
      channel: event.channel,
      user: event.user,
      text: parsed.text,
      ts: event.ts,
      command: parsed.command,
      files: files.length > 0 ? files : undefined,
      routingHint: routing.hint ?? undefined,
    });
  });
}

/**
 * Check if the bot previously posted in this thread. Used to decide whether
 * a fresh thread reply (no @mention) is addressed to Friday — if she already
 * participated, she should keep participating.
 * Cached per (channel, thread) to avoid spamming conversations.replies.
 */
const participationCache = new Map<string, { result: boolean; at: number }>();
const PARTICIPATION_TTL_MS = 5 * 60 * 1000;

async function didBotParticipate(
  app: App,
  channel: string,
  threadTs: string,
  botId: string,
): Promise<boolean> {
  const key = `${channel}:${threadTs}`;
  const cached = participationCache.get(key);
  if (cached && Date.now() - cached.at < PARTICIPATION_TTL_MS) {
    return cached.result;
  }
  try {
    const resp = await app.client.conversations.replies({
      channel,
      ts: threadTs,
      limit: 50,
    });
    const messages = (resp.messages ?? []) as Array<{ bot_id?: string }>;
    const found = messages.some((m) => m.bot_id === botId);
    participationCache.set(key, { result: found, at: Date.now() });
    return found;
  } catch (err) {
    log.warn("hydrate", `conversations.replies failed for ${channel}/${threadTs}: ${err}`);
    return false;
  }
}

/**
 * Extract file attachments from a Slack event.
 * Slack events with files have a `files` array with url_private_download, mimetype, and name.
 * We use `unknown` and cast via intermediate object since Bolt's event types don't include `files`.
 */
function extractFiles(event: unknown): SlackFileAttachment[] {
  const ev = event as { files?: unknown[] };
  if (!Array.isArray(ev.files)) return [];

  return (ev.files as Array<Record<string, unknown>>)
    .filter(
      (f) =>
        typeof f.url_private_download === "string" &&
        typeof f.mimetype === "string" &&
        typeof f.name === "string",
    )
    .map((f) => ({
      url: f.url_private_download as string,
      name: f.name as string,
      mimetype: f.mimetype as string,
    }));
}
