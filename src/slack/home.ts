import type { App } from "@slack/bolt";
import type { SessionStore } from "../session/store/interface.ts";
import type { ThreadSession } from "../session/types.ts";

export function registerHomeTab(app: App, store: SessionStore): void {
  app.event("app_home_opened", async ({ event }) => {
    await publishHomeTab(app, event.user, store);
  });

  // Click a thread in the home tab → open a modal listing its replies, one
  // per block, oldest→newest. The button carries {channel, threadId} so we
  // can fetch the real Slack thread via conversations.replies.
  app.action("view_thread", async ({ ack, body, client }) => {
    await ack();
    const action = (body as { actions?: Array<{ value?: string }> }).actions?.[0];
    const triggerId = (body as { trigger_id?: string }).trigger_id;
    if (!action?.value || !triggerId) return;

    let parsed: { channel: string; threadId: string };
    try {
      parsed = JSON.parse(action.value);
    } catch {
      return;
    }

    // Open a loading modal immediately so we spend the short-lived trigger_id
    // before the conversations.replies round-trip, then swap in real content.
    try {
      const opened = await client.views.open({
        trigger_id: triggerId,
        view: {
          type: "modal",
          title: { type: "plain_text", text: "Thread replies" },
          close: { type: "plain_text", text: "Close" },
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: ":hourglass_flowing_sand: Loading replies…" } },
          ],
        },
      });
      const viewId = opened.view?.id;
      if (!viewId) return;

      const blocks = await buildThreadModalBlocks(app, parsed.channel, parsed.threadId);
      await client.views.update({
        view_id: viewId,
        view: {
          type: "modal",
          title: { type: "plain_text", text: "Thread replies" },
          close: { type: "plain_text", text: "Close" },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          blocks: blocks as any,
        },
      });
    } catch (err) {
      console.error("[home] Failed to open thread modal:", err);
    }
  });
}

// Slack limits: 100 blocks per view, ~3000 chars per section. We render one
// section per message, so cap how many messages we show and how long each is.
const MODAL_MAX_MESSAGES = 60;
const MODAL_MAX_CHARS = 2800;

async function buildThreadModalBlocks(
  app: App,
  channel: string,
  threadTs: string,
): Promise<Array<Record<string, unknown>>> {
  const blocks: Array<Record<string, unknown>> = [];

  let messages: Array<Record<string, unknown>> = [];
  try {
    const result = await app.client.conversations.replies({
      channel,
      ts: threadTs,
      inclusive: true,
      limit: 100,
    });
    messages = (result.messages ?? []) as Array<Record<string, unknown>>;
  } catch (err) {
    return [
      {
        type: "section",
        text: { type: "mrkdwn", text: `:warning: Couldn't load this thread.\n\`${String(err)}\`` },
      },
    ];
  }

  if (messages.length === 0) {
    return [{ type: "section", text: { type: "mrkdwn", text: "_No messages in this thread._" } }];
  }

  const total = messages.length;
  const truncated = total > MODAL_MAX_MESSAGES;
  // Keep the most recent N (still oldest→newest within that window).
  const shown = truncated ? messages.slice(total - MODAL_MAX_MESSAGES) : messages;

  if (truncated) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `:scroll: Showing last ${MODAL_MAX_MESSAGES} of ${total} messages`,
        },
      ],
    });
    blocks.push({ type: "divider" });
  }

  for (const m of shown) {
    const isBot = !!m.bot_id;
    const who = isBot ? "Friday" : `<@${m.user ?? "unknown"}>`;
    const tsNum = Number(m.ts);
    const time = Number.isFinite(tsNum) ? fmtClock(tsNum * 1000) : "";
    const raw = String(m.text ?? "").trim();
    const len = raw.length;
    const body =
      len === 0
        ? "_(no text — file or attachment)_"
        : len > MODAL_MAX_CHARS
          ? raw.slice(0, MODAL_MAX_CHARS - 1) + "…"
          : raw;

    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `*${who}* · ${time} · ${len} chars` }],
    });
    blocks.push({ type: "section", text: { type: "mrkdwn", text: body } });
    blocks.push({ type: "divider" });
  }

  // Drop the trailing divider.
  if (blocks[blocks.length - 1]?.type === "divider") blocks.pop();

  return blocks;
}

function fmtClock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export async function publishHomeTab(
  app: App,
  userId: string,
  store: SessionStore,
): Promise<void> {
  const sessions = await store.getAll();
  const blocks = buildHomeBlocks(sessions);

  try {
    await app.client.views.publish({
      user_id: userId,
      view: {
        type: "home",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        blocks: blocks as any,
      },
    });
  } catch (err) {
    console.error("[home] Failed to publish home tab:", err);
  }
}

function buildHomeBlocks(
  sessions: Map<string, ThreadSession>,
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];

  // Header
  blocks.push({
    type: "header",
    text: { type: "plain_text", text: "Friday", emoji: true },
  });

  // Stats summary
  const allSessions = Array.from(sessions.values());
  const active = allSessions.filter((s) => s.status === "busy").length;
  const idle = allSessions.filter((s) => s.status === "idle").length;
  const draining = allSessions.filter((s) => s.status === "draining").length;
  const withErrors = allSessions.filter((s) => s.lastError !== null).length;

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*Active:* ${active}  |  *Idle:* ${idle}  |  *Draining:* ${draining}  |  *Errors:* ${withErrors}  |  *Total:* ${allSessions.length}`,
    },
  });

  blocks.push({ type: "divider" });

  // Active sessions
  const busySessions = allSessions.filter((s) => s.status !== "idle");
  if (busySessions.length > 0) {
    blocks.push({
      type: "header",
      text: { type: "plain_text", text: "Active Sessions" },
    });

    for (const session of busySessions) {
      blocks.push(sessionBlock(session));
    }
  }

  // Idle sessions (most recent first, limit 10)
  const idleSessions = allSessions
    .filter((s) => s.status === "idle")
    .sort((a, b) => b.lastActivity - a.lastActivity)
    .slice(0, 10);

  if (idleSessions.length > 0) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "header",
      text: { type: "plain_text", text: "Recent Sessions" },
    });

    for (const session of idleSessions) {
      blocks.push(sessionBlock(session));
    }
  }

  // Recent errors
  const errorSessions = allSessions
    .filter((s) => s.lastError !== null)
    .sort((a, b) => (b.lastError?.timestamp ?? 0) - (a.lastError?.timestamp ?? 0))
    .slice(0, 5);

  if (errorSessions.length > 0) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "header",
      text: { type: "plain_text", text: "Recent Errors" },
    });

    for (const session of errorSessions) {
      const ago = timeAgo(session.lastError!.timestamp);
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${session.threadId}*\n${session.lastError!.type}: ${session.lastError!.message}\n_${ago}_`,
        },
      });
    }
  }

  if (allSessions.length === 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "_No active sessions._",
      },
    });
  }

  return blocks;
}

function sessionBlock(session: ThreadSession): Record<string, unknown> {
  const status =
    session.status === "busy"
      ? ":large_blue_circle: Busy"
      : session.status === "draining"
        ? ":hourglass: Draining"
        : ":white_circle: Idle";

  const agent = session.agentType ?? "default";
  const repo = session.targetRepo ?? "none";
  const ago = timeAgo(session.lastActivity);
  const pending = session.pendingMessages.length;

  let text = `*${session.threadId}*\n${status}  |  Agent: ${agent}  |  Repo: ${repo}\nLast activity: ${ago}`;

  if (pending > 0) {
    text += `  |  Pending: ${pending}`;
  }
  if (session.worktreePath) {
    text += `\nWorktree: \`${session.worktreePath}\``;
  }

  return {
    type: "section",
    text: { type: "mrkdwn", text },
    accessory: {
      type: "button",
      text: { type: "plain_text", text: "View replies", emoji: true },
      action_id: "view_thread",
      value: JSON.stringify({ channel: session.channel, threadId: session.threadId }),
    },
  };
}

function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
