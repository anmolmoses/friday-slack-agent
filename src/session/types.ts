export interface PendingMessage {
  user: string;
  text: string;
  ts: string;
  command?: string;
}

export type SessionStatus = "idle" | "busy" | "draining";

/** A jab — a non-Anmol message in a vibes channel that looks like ragebait. */
export interface RagebaitJab {
  user: string;
  ts: number; // ms epoch — when we observed it
  text: string; // truncated to 200 chars
}

export interface ThreadSession {
  threadId: string;
  channel: string;
  sessionId: string | null;
  worktreePath: string | null;
  targetRepo: string | null;
  baseRef: string | null;
  agentType: string | null;
  systemPrompt: string | null;
  mcpConfigPath: string | null;
  status: SessionStatus;
  pendingMessages: PendingMessage[];
  verbosity: "quiet" | "normal" | "verbose";
  pid: number | null;
  lastActivity: number;
  lastError: { type: string; message: string; timestamp: number } | null;
  createdAt: number;
  /**
   * Self-deprecation streak across recent OWN messages in this thread.
   * Increments when Friday's outgoing reply contains a spiral marker
   * ("pathetic", "i'm done", "friday out", etc.); decrements (floor 0)
   * each turn she keeps it together. ≥2 triggers a hard one-line cap on
   * the next turn.
   */
  spiralScore: number;
  /** Recent ragebait-shaped jabs from non-Anmol users in vibes channels. */
  recentJabs: RagebaitJab[];
  /**
   * When true, Friday is disconnected from this thread — incoming messages
   * are ignored entirely (no spawn, no eyes-reaction, no buffering). Set
   * via `!mute`, cleared via `!unmute`. Anyone in the thread can toggle.
   * @mentions, app_mentions, and pattern routing all yield to this flag.
   */
  muted: boolean;
}

export function createSession(
  threadId: string,
  channel: string
): ThreadSession {
  return {
    threadId,
    channel,
    sessionId: null,
    worktreePath: null,
    targetRepo: null,
    baseRef: null,
    agentType: null,
    systemPrompt: null,
    mcpConfigPath: null,
    status: "idle",
    pendingMessages: [],
    verbosity: "normal",
    pid: null,
    lastActivity: Date.now(),
    lastError: null,
    createdAt: Date.now(),
    spiralScore: 0,
    recentJabs: [],
    muted: false,
  };
}
