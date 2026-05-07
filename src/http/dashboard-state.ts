/**
 * In-memory state store for Friday's live dashboard.
 *
 * Subscribers (the SSE handler) get notified on every recordEvent /
 * recordResponse / recordError / recordSchedulerTick call. The state is
 * append-only-ish: per-thread we keep the last N events in a ring buffer,
 * latest assistant text snippet, current tool, token counts, and turn
 * counter. System-level we track boot time, socket activity, and the most
 * recent scheduler heartbeats.
 *
 * Why not just tail logs (like bin/friday-watch)? Because the log only has
 * `len=391` for responses — not the actual text. Token usage isn't logged
 * at all. In-flight tool calls are visible only as tool_use start; the
 * result text isn't exposed. This module captures the full picture as
 * stream-json events flow, so the dashboard can show what was actually said.
 */

import type { StreamEvent } from "../claude/types.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export type DashboardEventKind =
  | "init"           // system.init: session id assigned
  | "spawn"          // claude -p subprocess spawned (argv, cwd, prompt captured)
  | "tool_use"       // assistant: tool call started
  | "tool_result"    // user: tool result returned
  | "thinking"       // assistant: thinking block
  | "text"           // assistant: text chunk
  | "response"       // turn complete: final text posted to slack
  | "post"           // chat.postMessage succeeded (initial status message)
  | "post_edit"      // chat.update succeeded (status message edited mid-stream)
  | "post_failed"    // chat.postMessage / update threw
  | "silent_fail"    // turn complete: no text, no error (the bad case)
  | "error"          // turn errored
  | "routing"        // pattern routing decision
  | "vibes_lint"     // vibes-lint truncation
  | "spiral"         // spiral-score change
  | "ragebait"       // ragebait jab recorded
  | "ask_owner"      // dispatched Claude asked the user via DM
  | "buffered"       // message queued during busy turn
  | "muted"          // !mute / !unmute
  | "info";          // catchall

export interface SpawnInfo {
  ts: number;
  pid: number;
  argv: string[];           // ["claude", "-p", ...]
  cwd: string;
  prompt: string;           // full prompt text passed to claude (-p / stdin)
  envKeys: string[];        // names only — never values, since some are tokens
  agentType?: string | null;
  resumedSessionId?: string | null;
  systemPromptFile?: string | null;     // e.g. /tmp/friday-prompts/<tid>.md
  systemPromptContent?: string | null;  // SOUL+AGENTS+IDENTITY+memory bundle
}

export interface SlackPostInfo {
  ts: number;
  action: "create" | "edit" | "failed";
  channel: string;
  messageTs?: string;       // slack message ts (for permalink)
  textLen: number;
  preview: string;
  error?: string;
}

export interface DashboardEvent {
  ts: number;                  // ms epoch
  kind: DashboardEventKind;
  threadId?: string;
  channel?: string;
  text: string;                // human-readable summary
  data?: Record<string, unknown>;
}

export interface ThreadState {
  threadId: string;
  channel: string;
  channelName?: string;
  status: "idle" | "busy" | "draining";
  agentType?: string | null;
  pid?: number | null;
  pendingCount: number;
  muted: boolean;
  sessionId?: string | null;
  // Worktree isolation for this thread (from the session). diskBytes/dirty are
  // merged in by the client from the system-level worktree summary.
  worktreePath?: string | null;
  worktreeProvisioned?: boolean;
  // Live spawn info
  currentTool?: { name: string; description: string; startedAt: number };
  lastAssistantText?: string;
  lastAssistantTextAt?: number;
  lastUserText?: string;
  lastUserAt?: number;
  thinkingPreview?: string;    // last "thinking" block snippet
  // Token / turn metrics (filled when result event lands)
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
  numTurns?: number;
  totalCost?: number;          // running sum
  totalTurns?: number;
  // Recent events (ring buffer)
  events: DashboardEvent[];
  createdAt: number;
  lastActivityAt: number;
  // Memory writes Friday made on this thread (Edit/Write to memory/)
  memoryWrites: { ts: number; path: string; preview?: string }[];
  // Slack posts she made via friday-slack MCP (vs onResponse path)
  mcpSlackPosts: { ts: number; tool: string; channel?: string; preview?: string }[];
  // Claude subprocess spawns for this thread (full argv + prompt)
  spawns: SpawnInfo[];
  // Slack posts via responder.ts (initial post + each edit)
  slackPosts: SlackPostInfo[];
}

/** One live `slack-*` worktree, as surfaced to the dashboard. */
export interface WorktreeSummaryItem {
  repoName: string;
  threadId: string;
  branch: string | null;
  dirty: boolean;
  diskBytes: number;
  lastActivity: number;
}

/** System-wide worktree disk picture, refreshed on the reaper cadence. */
export interface WorktreeSummary {
  list: WorktreeSummaryItem[];
  totalBytes: number;
  capBytes: number;
  updatedAt: number;
}

export interface SystemState {
  bootTime: number;
  socketLastActivityAt: number;
  socketState?: string;
  schedulers: Record<string, { name: string; lastHeartbeat: number; nextFireMs?: number; channel?: string }>;
  recentEvents: DashboardEvent[];   // cross-thread feed
  recentWarns: { ts: number; tag: string; text: string }[];
  worktrees?: WorktreeSummary;      // disk-pressure picture (reaper cadence)
}

// ─── Store ───────────────────────────────────────────────────────────────────

const THREAD_RING_SIZE = 50;
const SYSTEM_RING_SIZE = 100;
const RECENT_WARNS_SIZE = 20;
const TEXT_PREVIEW_LIMIT = 600;

const threads = new Map<string, ThreadState>();
const system: SystemState = {
  bootTime: Date.now(),
  socketLastActivityAt: Date.now(),
  schedulers: {},
  recentEvents: [],
  recentWarns: [],
};

type Subscriber = (event: DashboardEvent | { kind: "snapshot" }) => void;
const subscribers = new Set<Subscriber>();

function broadcast(event: DashboardEvent) {
  for (const sub of subscribers) {
    try { sub(event); } catch { /* drop */ }
  }
}

/** Push a fresh full snapshot to all subscribers without a feed event. */
function broadcastSnapshot() {
  for (const sub of subscribers) {
    try { sub({ kind: "snapshot" }); } catch { /* drop */ }
  }
}

function pushThreadEvent(threadId: string, ev: DashboardEvent) {
  const t = threads.get(threadId);
  if (!t) return;
  t.events.push(ev);
  if (t.events.length > THREAD_RING_SIZE) t.events.shift();
  t.lastActivityAt = ev.ts;
}

function pushSystemEvent(ev: DashboardEvent) {
  system.recentEvents.push(ev);
  if (system.recentEvents.length > SYSTEM_RING_SIZE) system.recentEvents.shift();
}

function preview(text: string, limit = TEXT_PREVIEW_LIMIT): string {
  if (!text) return "";
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : trimmed.slice(0, limit - 1) + "…";
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function ensureThread(threadId: string, channel: string, channelName?: string): ThreadState {
  let t = threads.get(threadId);
  if (!t) {
    t = {
      threadId,
      channel,
      channelName,
      status: "idle",
      pendingCount: 0,
      muted: false,
      events: [],
      memoryWrites: [],
      mcpSlackPosts: [],
      spawns: [],
      slackPosts: [],
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      totalCost: 0,
      totalTurns: 0,
    };
    threads.set(threadId, t);
  } else if (channelName && !t.channelName) {
    t.channelName = channelName;
  }
  return t;
}

export function setThreadMeta(
  threadId: string,
  meta: Partial<Pick<ThreadState, "status" | "agentType" | "pid" | "pendingCount" | "muted" | "sessionId" | "channelName" | "worktreePath" | "worktreeProvisioned">>,
): void {
  const t = threads.get(threadId);
  if (!t) return;
  Object.assign(t, meta);
  t.lastActivityAt = Date.now();
  // If transitioning to idle, clear current tool
  if (meta.status === "idle" || meta.status === "draining") {
    t.currentTool = undefined;
    t.thinkingPreview = undefined;
  }
}

/** Stream-json event from spawner.ts onEvent. */
export function recordStreamEvent(threadId: string, event: StreamEvent): void {
  const t = threads.get(threadId);
  if (!t) return;
  const now = Date.now();

  if (event.type === "system" && event.subtype === "init") {
    t.sessionId = event.session_id;
    const ev: DashboardEvent = {
      ts: now, kind: "init", threadId,
      text: `session ${event.session_id?.slice(0, 8)}…`,
      data: { tools: event.tools?.length ?? 0 },
    };
    pushThreadEvent(threadId, ev);
    pushSystemEvent(ev);
    broadcast(ev);
    return;
  }

  if (event.type === "assistant") {
    for (const block of event.message.content) {
      if (block.type === "thinking" && block.thinking) {
        t.thinkingPreview = preview(block.thinking, 240);
      } else if (block.type === "text" && block.text) {
        t.lastAssistantText = preview(block.text, 2000);
        t.lastAssistantTextAt = now;
        const ev: DashboardEvent = {
          ts: now, kind: "text", threadId,
          text: preview(block.text, 200),
        };
        pushThreadEvent(threadId, ev);
        broadcast(ev);
      } else if (block.type === "tool_use" && block.name) {
        const desc = describeToolUse(block.name, block.input);
        t.currentTool = { name: block.name, description: desc, startedAt: now };
        const ev: DashboardEvent = {
          ts: now, kind: "tool_use", threadId,
          text: desc,
          data: { tool: block.name },
        };
        pushThreadEvent(threadId, ev);
        broadcast(ev);

        // Track memory writes specifically — Edit/Write/MultiEdit to memory/
        if (block.name === "Edit" || block.name === "Write" || block.name === "MultiEdit") {
          const fp = String(block.input?.file_path ?? "");
          if (fp.includes("/memory/")) {
            const newContent = String(block.input?.new_string ?? block.input?.content ?? "");
            t.memoryWrites.push({ ts: now, path: fp, preview: preview(newContent, 400) });
            if (t.memoryWrites.length > 20) t.memoryWrites.shift();
          }
        }
        // Track friday-slack MCP posts
        if (block.name.startsWith("mcp__friday-slack__")) {
          const tool = block.name.replace("mcp__friday-slack__", "");
          const text = String(block.input?.text ?? block.input?.message ?? "");
          t.mcpSlackPosts.push({
            ts: now, tool, channel: String(block.input?.channel ?? ""),
            preview: preview(text, 400),
          });
          if (t.mcpSlackPosts.length > 20) t.mcpSlackPosts.shift();
        }
      }
    }
    return;
  }

  if (event.type === "user") {
    // Tool result coming back — clears current tool
    t.currentTool = undefined;
    return;
  }

  if (event.type === "result") {
    // Stream-json result events carry usage data (not in our type def — cast).
    const r = event as unknown as Record<string, unknown>;
    const usage = r.usage as Record<string, unknown> | undefined;
    if (usage) {
      t.inputTokens = Number(usage.input_tokens ?? t.inputTokens ?? 0);
      t.outputTokens = Number(usage.output_tokens ?? t.outputTokens ?? 0);
      t.cacheCreationTokens = Number(usage.cache_creation_input_tokens ?? 0);
      t.cacheReadTokens = Number(usage.cache_read_input_tokens ?? 0);
    }
    if (typeof r.total_cost_usd === "number") {
      t.costUsd = r.total_cost_usd;
      t.totalCost = (t.totalCost ?? 0) + r.total_cost_usd;
    }
    if (typeof r.num_turns === "number") {
      t.numTurns = r.num_turns;
      t.totalTurns = (t.totalTurns ?? 0) + r.num_turns;
    }
    return;
  }
}

const SPAWN_RING_SIZE = 20;
const POST_RING_SIZE = 60;

/** Friday spawned a new claude subprocess for this thread. */
export function recordSpawn(threadId: string, info: Omit<SpawnInfo, "ts">): void {
  const t = threads.get(threadId);
  if (!t) return;
  const stamped: SpawnInfo = { ts: Date.now(), ...info };
  t.spawns.push(stamped);
  if (t.spawns.length > SPAWN_RING_SIZE) t.spawns.shift();
  const ev: DashboardEvent = {
    ts: stamped.ts, kind: "spawn", threadId,
    text: `pid ${info.pid} · ${info.argv.length - 1} args${info.resumedSessionId ? ` · resume ${info.resumedSessionId.slice(0,8)}` : ""}`,
    data: { pid: info.pid, argv: info.argv.length, prompt: info.prompt.length },
  };
  pushThreadEvent(threadId, ev);
  pushSystemEvent(ev);
  broadcast(ev);
}

/** chat.postMessage / chat.update succeeded. action='create'|'edit'. */
export function recordSlackPost(
  threadId: string,
  channel: string,
  messageTs: string,
  action: "create" | "edit",
  text: string,
): void {
  const t = threads.get(threadId);
  if (!t) return;
  const post: SlackPostInfo = {
    ts: Date.now(), action, channel, messageTs, textLen: text.length,
    preview: preview(text, 200),
  };
  t.slackPosts.push(post);
  if (t.slackPosts.length > POST_RING_SIZE) t.slackPosts.shift();
  const ev: DashboardEvent = {
    ts: post.ts, kind: action === "create" ? "post" : "post_edit", threadId, channel,
    text: `${action === "create" ? "posted" : "edited"} · ${text.length} chars · ${preview(text, 80)}`,
    data: { messageTs, action, channel, textLen: text.length },
  };
  pushThreadEvent(threadId, ev);
  pushSystemEvent(ev);
  broadcast(ev);
}

/** chat.postMessage / chat.update threw. */
export function recordSlackPostFailed(
  threadId: string,
  channel: string,
  action: "create" | "edit",
  errMsg: string,
): void {
  const t = threads.get(threadId);
  if (t) {
    t.slackPosts.push({
      ts: Date.now(), action: "failed", channel, textLen: 0,
      preview: preview(errMsg, 200), error: errMsg,
    });
    if (t.slackPosts.length > POST_RING_SIZE) t.slackPosts.shift();
  }
  const ev: DashboardEvent = {
    ts: Date.now(), kind: "post_failed", threadId, channel,
    text: `${action} failed: ${preview(errMsg, 200)}`,
    data: { action },
  };
  pushThreadEvent(threadId, ev);
  pushSystemEvent(ev);
  broadcast(ev);
  system.recentWarns.push({ ts: ev.ts, tag: "slack-post", text: `${action}: ${errMsg}` });
  if (system.recentWarns.length > RECENT_WARNS_SIZE) system.recentWarns.shift();
}

/** Final assistant text was posted to slack (responder.postResponse). */
export function recordResponse(threadId: string, text: string): void {
  const t = threads.get(threadId);
  if (!t) return;
  const now = Date.now();
  t.lastAssistantText = preview(text, 2000);
  t.lastAssistantTextAt = now;
  const ev: DashboardEvent = {
    ts: now, kind: "response", threadId,
    text: preview(text, 200),
    data: { len: text.length },
  };
  pushThreadEvent(threadId, ev);
  pushSystemEvent(ev);
  broadcast(ev);
}

export function recordError(threadId: string, message: string, kind: "error" | "silent_fail" = "error"): void {
  const ev: DashboardEvent = {
    ts: Date.now(), kind, threadId,
    text: preview(message, 280),
  };
  pushThreadEvent(threadId, ev);
  pushSystemEvent(ev);
  broadcast(ev);
  if (kind === "silent_fail") {
    system.recentWarns.push({ ts: Date.now(), tag: "silent-fail", text: message });
    if (system.recentWarns.length > RECENT_WARNS_SIZE) system.recentWarns.shift();
  }
}

export function recordIncomingMessage(
  threadId: string,
  channel: string,
  user: string,
  text: string,
  channelName?: string,
): void {
  const t = ensureThread(threadId, channel, channelName);
  t.lastUserText = preview(text, 600);
  t.lastUserAt = Date.now();
  const ev: DashboardEvent = {
    ts: Date.now(), kind: "info", threadId, channel,
    text: `${user}: ${preview(text, 160)}`,
  };
  pushThreadEvent(threadId, ev);
  pushSystemEvent(ev);
  broadcast(ev);
}

export function recordRouting(threadId: string, channel: string, hint: string | null, reason: string): void {
  const ev: DashboardEvent = {
    ts: Date.now(), kind: "routing", threadId, channel,
    text: `hint=${hint ?? "none"} reason=${reason}`,
  };
  pushThreadEvent(threadId, ev);
  pushSystemEvent(ev);
  broadcast(ev);
}

export function recordSchedulerTick(name: string, channel: string, nextFireMs?: number): void {
  system.schedulers[name] = { name, lastHeartbeat: Date.now(), nextFireMs, channel };
}

export function recordSocketActivity(state?: string): void {
  system.socketLastActivityAt = Date.now();
  if (state) system.socketState = state;
}

/**
 * Refresh the system-wide worktree disk picture (called on the reaper cadence
 * + boot). Pushes a snapshot so idle dashboards update even with no thread
 * activity. diskBytes/dirty here are the source of truth the client merges
 * into per-thread cards by threadId.
 */
export function recordWorktrees(summary: WorktreeSummary): void {
  system.worktrees = summary;
  broadcastSnapshot();
}

// ─── Snapshot + subscribe ───────────────────────────────────────────────────

export function getSnapshot(): { system: SystemState; threads: ThreadState[] } {
  return {
    system: { ...system, recentEvents: [...system.recentEvents], recentWarns: [...system.recentWarns] },
    threads: [...threads.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt),
  };
}

export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function describeToolUse(name: string, input: Record<string, unknown> | undefined): string {
  const i = input ?? {};
  switch (name) {
    case "Read": return `📖 ${shortPath(String(i.file_path ?? ""))}${i.offset ? ` (lines ${i.offset}+)` : ""}`;
    case "Edit":
    case "MultiEdit":
    case "Write": return `✏️ ${shortPath(String(i.file_path ?? ""))}`;
    case "Glob": return `🔎 ${String(i.pattern ?? "")}`;
    case "Grep": return `🔎 ${String(i.pattern ?? "")} in ${shortPath(String(i.path ?? ""))}`;
    case "Bash": return `⚙️ ${preview(String(i.description ?? i.command ?? ""), 80)}`;
    case "Task": return `🤖 ${String(i.subagent_type ?? "agent")}: ${preview(String(i.description ?? ""), 60)}`;
    case "WebFetch": return `🌐 ${shortPath(String(i.url ?? ""), 60)}`;
    case "WebSearch": return `🔍 ${preview(String(i.query ?? ""), 60)}`;
    case "TodoWrite": return `🗒 todo update`;
    default:
      if (name.startsWith("mcp__")) {
        const [, server, tool] = name.split("__");
        return `🔌 ${server} · ${tool}`;
      }
      return `🔧 ${name}`;
  }
}

function shortPath(p: string, limit = 60): string {
  if (!p) return "";
  if (p.length <= limit) return p;
  // Keep the last `limit-1` chars, prefix with …
  return "…" + p.slice(p.length - (limit - 1));
}
