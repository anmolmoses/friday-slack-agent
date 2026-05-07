import type { App } from "@slack/bolt";
import { SlackApiCache } from "../cache/slack-api-cache.ts";
import { ThreadContextCache } from "../cache/thread-context-cache.ts";

interface ThreadMessage {
  user: string;
  text: string;
  ts: string;
  isBot: boolean;
  fileNames: string[];
}

// Shared cache instances
const slackApiCache = new SlackApiCache();
const threadCache = new ThreadContextCache();

// Prune expired entries every 5 minutes
setInterval(() => {
  slackApiCache.prune();
  threadCache.prune();
}, 5 * 60 * 1000);

async function resolveChannelName(app: App, channelId: string): Promise<string> {
  const cached = slackApiCache.getChannelInfo(channelId);
  if (cached) return cached.name;

  try {
    const info = await app.client.conversations.info({ channel: channelId });
    const name = info.channel?.name ?? channelId;
    slackApiCache.setChannelInfo(channelId, { id: channelId, name });
    return name;
  } catch {
    return channelId;
  }
}

/** Invalidate thread cache when a new message arrives. */
export function invalidateThreadCache(threadId: string): void {
  threadCache.invalidate(threadId);
}

/**
 * Build the identity + thread context preamble for Claude.
 * Always includes Friday's persona, channel/thread coordinates, and thread history.
 */
export async function buildPromptPreamble(
  app: App,
  channel: string,
  threadTs: string,
  latestTs: string,
  botUserId?: string,
): Promise<string> {
  const [channelName, threadContext] = await Promise.all([
    resolveChannelName(app, channel),
    fetchThreadHistory(app, channel, threadTs, latestTs, botUserId),
  ]);

  // Persona is now injected via --append-system-prompt-file in args.ts (system-level).
  // Here we only provide the slim Slack context so Claude knows where it is.
  const parts: string[] = [
    `<identity>`,
    `Your Slack user ID is ${botUserId ?? "unknown"}. Messages from this user ID in the thread are yours.`,
    `</identity>`,
    ``,
    `<slack-context>`,
    `Channel: #${channelName} (${channel})`,
    `Thread: ${threadTs}`,
    `You are responding in this thread. You already have the full thread history below.`,
    `Do NOT use Slack search or read tools to find this thread — you already have all the context you need.`,
    `</slack-context>`,
  ];

  if (threadContext) {
    parts.push("", threadContext);
  }

  return parts.join("\n");
}

async function fetchThreadHistory(
  app: App,
  channel: string,
  threadTs: string,
  latestTs: string,
  botUserId?: string,
): Promise<string | null> {
  try {
    const result = await app.client.conversations.replies({
      channel,
      ts: threadTs,
      inclusive: true,
      limit: 100,
    });

    if (!result.messages || result.messages.length <= 1) {
      return null;
    }

    const messages: ThreadMessage[] = result.messages
      .filter((m) => m.ts !== latestTs)
      .map((m) => {
        // Extract file names from message attachments
        const files = (m as Record<string, unknown>).files;
        const fileNames: string[] = Array.isArray(files)
          ? (files as Array<Record<string, unknown>>)
              .filter((f) => typeof f.name === "string")
              .map((f) => f.name as string)
          : [];

        return {
          user: m.user ?? "unknown",
          text: (m.text ?? "").replace(/<@[A-Z0-9]+>\s*/g, "").trim(),
          ts: m.ts!,
          isBot: !!(botUserId && m.user === botUserId),
          fileNames,
        };
      });

    if (messages.length === 0) return null;

    // Cache the parsed messages for this thread
    threadCache.set(threadTs, messages.map((m) => ({
      user: m.user,
      text: m.text,
      ts: m.ts,
      isBot: m.isBot,
    })));

    const lines = messages.map((m) => {
      const role = m.isBot ? "Friday (you)" : `User(${m.user})`;
      let line = `${role}: ${m.text}`;
      if (m.fileNames.length > 0) {
        const fileNotes = m.fileNames.map((f) => `[shared image: ${f}]`).join(" ");
        line += ` ${fileNotes}`;
      }
      return line;
    });

    return [
      "<thread-context>",
      "The following is the Slack thread history leading up to the current message.",
      "Use this to understand the conversation so far. Respond ONLY to the current message below.",
      "",
      ...lines,
      "</thread-context>",
    ].join("\n");
  } catch (err) {
    console.error("[thread-context] Failed to fetch thread:", err);
    return null;
  }
}
