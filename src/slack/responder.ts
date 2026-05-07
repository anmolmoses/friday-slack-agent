import type { App } from "@slack/bolt";
import { splitResponse, toSlackMrkdwn } from "./formatting.ts";
import { pickThinkingVerb } from "./thinking-verbs.ts";
import { recordSlackPost, recordSlackPostFailed } from "../http/dashboard-state.ts";

interface StatusEntry {
  messageTs: string;
  lastUpdateTime: number;
  lastSentText: string;
  pendingText: string | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
  // Heartbeat: rotating verb animation while Claude is working
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  heartbeatActive: boolean;
  heartbeatStartedAt: number;
  heartbeatVerb: string;
  heartbeatVerbPickedAt: number;
}

const STATUS_DEBOUNCE_MS = 1000;
// Verb rotates on this cadence. No elapsed counter — the verb swap itself is
// the visible animation.
const VERB_ROTATE_MS = 4000;

function renderHeartbeat(verb: string): string {
  return `✽ _${verb}…_`;
}

// Friday should return one of these sentinels (or empty/whitespace) as her
// final assistant text when she has already replied via the slack_post_message
// MCP tool during the turn, OR when the message genuinely needs no reply
// (noise / already handled). Without this, the recap-style memory note that
// Friday writes after posting via MCP gets posted to Slack as a duplicate.
const SKIP_REPLY_SENTINELS = [
  "NO_SLACK_MESSAGE",
  "NO_SLACK_REPLY",
  "[NO_REPLY]",
];

export function shouldSkipFinalPost(text: string): boolean {
  if (!text) return true;
  const trimmed = text.trim();
  if (!trimmed) return true;
  // Match a sentinel that occupies the entire response (allow surrounding
  // punctuation/markdown like "**NO_SLACK_MESSAGE**" or "_NO_SLACK_MESSAGE_").
  const stripped = trimmed.replace(/^[*_`>\s]+|[*_`\s.!]+$/g, "");
  return SKIP_REPLY_SENTINELS.some(
    (s) => stripped.toUpperCase() === s.toUpperCase(),
  );
}

export class SlackResponder {
  private app: App;
  private statusMessages = new Map<string, StatusEntry>();

  constructor(app: App) {
    this.app = app;
  }

  async postResponse(
    channel: string,
    threadTs: string,
    text: string,
  ): Promise<void> {
    if (shouldSkipFinalPost(text)) {
      return;
    }
    const slackified = toSlackMrkdwn(text);
    const chunks = splitResponse(slackified);
    for (const chunk of chunks) {
      try {
        const r = await this.app.client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: chunk,
        });
        if (r.ts) recordSlackPost(threadTs, channel, r.ts, "create", chunk);
      } catch (err) {
        console.error("[responder] Failed to post message:", err);
        recordSlackPostFailed(threadTs, channel, "create", err instanceof Error ? err.message : String(err));
      }
    }
  }

  async updateStatus(
    channel: string,
    threadTs: string,
    text: string,
  ): Promise<void> {
    if (!text || !text.trim()) return;
    // Real content arrived — promote to an immediate post and skip the
    // heartbeat delay (otherwise the user sees the verb post first then this).
    this.cancelPendingHeartbeat(threadTs);
    const existing = this.statusMessages.get(threadTs);

    if (!existing) {
      // First call: post a new status message
      try {
        const result = await this.app.client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text,
        });
        if (result.ts) {
          this.statusMessages.set(threadTs, this.freshEntry(result.ts, text));
          recordSlackPost(threadTs, channel, result.ts, "create", text);
        }
      } catch (err) {
        console.error("[responder] Failed to post status:", err);
        recordSlackPostFailed(threadTs, channel, "create", err instanceof Error ? err.message : String(err));
      }
      return;
    }

    // Real content arrived — stop the verb-only heartbeat.
    if (existing.heartbeatActive) {
      this.stopHeartbeat(threadTs);
    }

    // Debounce: coalesce rapid updates so we always render the LATEST status
    // (openclaw feel), while staying under Slack's chat.update rate limit.
    if (text === existing.lastSentText) return; // no-op

    const now = Date.now();
    const sinceLast = now - existing.lastUpdateTime;
    if (sinceLast < STATUS_DEBOUNCE_MS) {
      existing.pendingText = text;
      if (!existing.flushTimer) {
        existing.flushTimer = setTimeout(
          () => this.flushPending(channel, threadTs),
          STATUS_DEBOUNCE_MS - sinceLast,
        );
      }
      return;
    }

    await this.sendUpdate(channel, threadTs, text);
  }

  private async flushPending(channel: string, threadTs: string): Promise<void> {
    const entry = this.statusMessages.get(threadTs);
    if (!entry) return;
    entry.flushTimer = null;
    if (entry.pendingText && entry.pendingText !== entry.lastSentText) {
      const text = entry.pendingText;
      entry.pendingText = null;
      await this.sendUpdate(channel, threadTs, text);
    }
  }

  // Build a fresh idle StatusEntry for a just-posted status message.
  private freshEntry(messageTs: string, text: string): StatusEntry {
    return {
      messageTs,
      lastUpdateTime: Date.now(),
      lastSentText: text,
      pendingText: null,
      flushTimer: null,
      heartbeatTimer: null,
      heartbeatActive: false,
      heartbeatStartedAt: 0,
      heartbeatVerb: "",
      heartbeatVerbPickedAt: 0,
    };
  }

  private async sendUpdate(channel: string, threadTs: string, text: string): Promise<void> {
    const entry = this.statusMessages.get(threadTs);
    if (!entry) return;
    try {
      await this.app.client.chat.update({
        channel,
        ts: entry.messageTs,
        text,
      });
      entry.lastUpdateTime = Date.now();
      entry.lastSentText = text;
      recordSlackPost(threadTs, channel, entry.messageTs, "edit", text);
    } catch (err) {
      // The cached status message is gone — it was deleted, or a prior turn
      // ended without deleteStatus() and left a stale entry pointing at a ts
      // Slack no longer accepts edits for. Editing a dead ts fails on EVERY
      // subsequent tool/text event, which is the `message_not_found` flood we
      // saw spam the dashboard 5000+ times (#bugs-backlog, 2026-06-04). Drop
      // the stale entry and re-post a fresh status message so updates keep
      // flowing instead of looping on a corpse.
      const slackErr =
        (err as { data?: { error?: string } } | undefined)?.data?.error;
      if (slackErr === "message_not_found" || slackErr === "cant_update_message") {
        this.statusMessages.delete(threadTs);
        try {
          const result = await this.app.client.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text,
          });
          if (result.ts) {
            this.statusMessages.set(threadTs, this.freshEntry(result.ts, text));
            recordSlackPost(threadTs, channel, result.ts, "create", text);
          }
        } catch (repostErr) {
          console.error("[responder] Failed to re-post status after message_not_found:", repostErr);
          recordSlackPostFailed(threadTs, channel, "create", repostErr instanceof Error ? repostErr.message : String(repostErr));
        }
        return;
      }
      console.error("[responder] Failed to update status:", err);
      recordSlackPostFailed(threadTs, channel, "edit", err instanceof Error ? err.message : String(err));
    }
  }

  async deleteStatus(channel: string, threadTs: string): Promise<void> {
    // Cancel any pending heartbeat that hasn't posted yet — turn finished
    // before the delay elapsed, so no visible status message is needed.
    this.cancelPendingHeartbeat(threadTs);
    const existing = this.statusMessages.get(threadTs);
    if (!existing) return;

    if (existing.flushTimer) {
      clearTimeout(existing.flushTimer);
      existing.flushTimer = null;
    }
    this.stopHeartbeat(threadTs);

    try {
      await this.app.client.chat.delete({
        channel,
        ts: existing.messageTs,
      });
    } catch (err) {
      console.error("[responder] Failed to delete status:", err);
    }

    this.statusMessages.delete(threadTs);
  }

  // Pending heartbeat starts that haven't yet posted to Slack. Lets us cancel
  // before any visible message lands when the turn finishes quickly (fast
  // tools, suppressed NO_REPLY responses, etc).
  private pendingHeartbeats = new Map<string, ReturnType<typeof setTimeout>>();
  private static HEARTBEAT_DELAY_MS = 2500;

  /**
   * Schedule a rotating-verb heartbeat. The status message is NOT posted
   * immediately — there's a delay so quick turns finish without any flicker
   * (you saw "thinking → deleted → thinking → deleted" when bots ping-ponged
   * suppressed responses; this avoids that). Real content (thinking, tool use,
   * assistant text) replaces the heartbeat when it arrives.
   */
  startHeartbeat(channel: string, threadTs: string): void {
    if (this.pendingHeartbeats.has(threadTs)) return;
    const existing = this.statusMessages.get(threadTs);
    if (existing && existing.heartbeatActive) return;

    const timer = setTimeout(() => {
      this.pendingHeartbeats.delete(threadTs);
      void this.actuallyStartHeartbeat(channel, threadTs);
    }, SlackResponder.HEARTBEAT_DELAY_MS);
    this.pendingHeartbeats.set(threadTs, timer);
  }

  private async actuallyStartHeartbeat(channel: string, threadTs: string): Promise<void> {
    const existing = this.statusMessages.get(threadTs);
    if (existing && existing.heartbeatActive) return;

    const startedAt = Date.now();
    const verb = pickThinkingVerb(startedAt);
    const text = renderHeartbeat(verb);

    if (!existing) {
      try {
        const result = await this.app.client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text,
        });
        if (!result.ts) return;
        const entry: StatusEntry = {
          messageTs: result.ts,
          lastUpdateTime: Date.now(),
          lastSentText: text,
          pendingText: null,
          flushTimer: null,
          heartbeatTimer: null,
          heartbeatActive: true,
          heartbeatStartedAt: startedAt,
          heartbeatVerb: verb,
          heartbeatVerbPickedAt: startedAt,
        };
        this.statusMessages.set(threadTs, entry);
        recordSlackPost(threadTs, channel, result.ts, "create", text);
        this.scheduleHeartbeatTick(channel, threadTs);
      } catch (err) {
        console.error("[responder] Failed to post heartbeat:", err);
        recordSlackPostFailed(threadTs, channel, "create", err instanceof Error ? err.message : String(err));
      }
    } else {
      existing.heartbeatActive = true;
      existing.heartbeatStartedAt = startedAt;
      existing.heartbeatVerb = verb;
      existing.heartbeatVerbPickedAt = startedAt;
      await this.sendUpdate(channel, threadTs, text);
      this.scheduleHeartbeatTick(channel, threadTs);
    }
  }

  /** Cancel a not-yet-posted heartbeat. */
  private cancelPendingHeartbeat(threadTs: string): void {
    const t = this.pendingHeartbeats.get(threadTs);
    if (t) {
      clearTimeout(t);
      this.pendingHeartbeats.delete(threadTs);
    }
  }

  private scheduleHeartbeatTick(channel: string, threadTs: string): void {
    const entry = this.statusMessages.get(threadTs);
    if (!entry || entry.heartbeatTimer) return;
    entry.heartbeatTimer = setInterval(() => {
      const cur = this.statusMessages.get(threadTs);
      if (!cur || !cur.heartbeatActive) {
        this.stopHeartbeat(threadTs);
        return;
      }
      const now = Date.now();
      cur.heartbeatVerb = pickThinkingVerb(now);
      cur.heartbeatVerbPickedAt = now;
      const text = renderHeartbeat(cur.heartbeatVerb);
      if (text === cur.lastSentText) return;
      void this.sendUpdate(channel, threadTs, text);
    }, VERB_ROTATE_MS);
  }

  private stopHeartbeat(threadTs: string): void {
    const entry = this.statusMessages.get(threadTs);
    if (!entry) return;
    if (entry.heartbeatTimer) {
      clearInterval(entry.heartbeatTimer);
      entry.heartbeatTimer = null;
    }
    entry.heartbeatActive = false;
  }

  async addReaction(
    channel: string,
    messageTs: string,
    emoji: string,
  ): Promise<void> {
    try {
      await this.app.client.reactions.add({
        channel,
        timestamp: messageTs,
        name: emoji,
      });
    } catch (err) {
      console.error("[responder] Failed to add reaction:", err);
    }
  }
}
