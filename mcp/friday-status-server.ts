#!/usr/bin/env bun

/**
 * Friday Status MCP Server
 *
 * Lightweight MCP server exposing Friday's runtime status over stdin/stdout JSON-RPC.
 * No dependencies -- reads status from /tmp/friday-status.json and memory/daily/*.md.
 *
 * Tools:
 *   friday_status         - Bot status (sessions, uptime, version)
 *   friday_thread_info    - Info about a specific thread
 *   friday_recent_activity - Recent daily note entries
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

// --- Types ---

interface SessionInfo {
  status: "idle" | "busy";
  agentType: string;
  channel: string;
  pendingCount: number;
  lastActivity: number;
}

interface StatusFile {
  startedAt: string;
  sessions: Record<string, SessionInfo>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface ToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

// --- Constants ---

const STATUS_FILE = "/tmp/friday-status.json";
const MEMORY_DIR = process.env.FRIDAY_MEMORY_DIR || "./memory";
const SLACK_THREAD_TS = process.env.SLACK_THREAD_TS || "";
const SLACK_CHANNEL = process.env.SLACK_CHANNEL || "";
const BOT_VERSION = "0.1.0";

const SERVER_INFO = {
  protocolVersion: "2024-11-05",
  capabilities: { tools: {} },
  serverInfo: { name: "friday-status", version: "1.0.0" },
};

const TOOL_DEFINITIONS = [
  {
    name: "friday_status",
    description: "Get current Friday bot status: active sessions, uptime, version",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [] as string[],
    },
  },
  {
    name: "friday_thread_info",
    description:
      "Get info about a Slack thread: session status, agent type, pending messages",
    inputSchema: {
      type: "object" as const,
      properties: {
        thread_id: {
          type: "string",
          description:
            "Thread timestamp ID. Defaults to SLACK_THREAD_TS env var if omitted.",
        },
      },
      required: [] as string[],
    },
  },
  {
    name: "friday_recent_activity",
    description:
      "Get recent cross-thread activity from daily notes within a time range",
    inputSchema: {
      type: "object" as const,
      properties: {
        hours: {
          type: "number",
          description: "How many hours back to look. Default: 24",
        },
      },
      required: [] as string[],
    },
  },
];

// --- Status file reader ---

async function readStatusFile(): Promise<StatusFile> {
  try {
    const raw = await readFile(STATUS_FILE, "utf-8");
    return JSON.parse(raw) as StatusFile;
  } catch {
    return { startedAt: "", sessions: {} };
  }
}

// --- Tool implementations ---

async function fridayStatus(): Promise<string> {
  const status = await readStatusFile();

  const sessions = Object.entries(status.sessions);
  const activeSessions = sessions.filter(([, s]) => s.status === "busy").length;
  const totalSessions = sessions.length;

  let uptime = "unknown";
  if (status.startedAt) {
    const startMs = new Date(status.startedAt).getTime();
    const nowMs = Date.now();
    const diffSec = Math.max(0, Math.floor((nowMs - startMs) / 1000));
    if (diffSec < 60) {
      uptime = `${diffSec}s`;
    } else if (diffSec < 3600) {
      uptime = `${Math.floor(diffSec / 60)}m ${diffSec % 60}s`;
    } else {
      const h = Math.floor(diffSec / 3600);
      const m = Math.floor((diffSec % 3600) / 60);
      uptime = `${h}h ${m}m`;
    }
  }

  return JSON.stringify(
    {
      version: BOT_VERSION,
      uptime,
      totalSessions,
      activeSessions,
      idleSessions: totalSessions - activeSessions,
    },
    null,
    2,
  );
}

async function fridayThreadInfo(
  threadId?: string,
): Promise<string> {
  const tid = threadId || SLACK_THREAD_TS;
  if (!tid) {
    return JSON.stringify({
      error: "No thread_id provided and SLACK_THREAD_TS is not set",
    });
  }

  const status = await readStatusFile();
  const session = status.sessions[tid];

  if (!session) {
    return JSON.stringify({
      threadId: tid,
      channel: SLACK_CHANNEL || "unknown",
      found: false,
      message: "No active session for this thread",
    });
  }

  return JSON.stringify(
    {
      threadId: tid,
      channel: session.channel,
      status: session.status,
      agentType: session.agentType,
      pendingCount: session.pendingCount,
      lastActivity: new Date(session.lastActivity).toISOString(),
    },
    null,
    2,
  );
}

async function fridayRecentActivity(hours: number = 24): Promise<string> {
  const dailyDir = join(MEMORY_DIR, "daily");
  const cutoff = Date.now() - hours * 60 * 60 * 1000;

  // Collect dates that fall within the window.
  // Daily files are expected to be named YYYY-MM-DD.md.
  let files: string[];
  try {
    const entries = await readdir(dailyDir);
    files = entries
      .filter((f) => f.endsWith(".md"))
      .sort()
      .reverse();
  } catch {
    return JSON.stringify({ entries: [], message: "No daily notes found" });
  }

  if (files.length === 0) {
    return JSON.stringify({ entries: [], message: "No daily notes found" });
  }

  // Filter to files whose date is within range.
  // Filename format: YYYY-MM-DD.md
  const cutoffDate = new Date(cutoff).toISOString().slice(0, 10);
  const relevantFiles = files.filter((f) => {
    const dateStr = f.replace(".md", "");
    return dateStr >= cutoffDate;
  });

  if (relevantFiles.length === 0) {
    return JSON.stringify({
      entries: [],
      message: `No daily notes within the last ${hours} hours`,
    });
  }

  const entries: Array<{ date: string; content: string }> = [];
  for (const file of relevantFiles) {
    try {
      const content = await readFile(join(dailyDir, file), "utf-8");
      entries.push({ date: file.replace(".md", ""), content: content.trim() });
    } catch {
      // Skip unreadable files.
    }
  }

  return JSON.stringify({ hours, entries }, null, 2);
}

// --- Tool dispatch ---

async function handleToolCall(params: ToolCallParams): Promise<string> {
  const args = params.arguments || {};

  switch (params.name) {
    case "friday_status":
      return await fridayStatus();

    case "friday_thread_info":
      return await fridayThreadInfo(args.thread_id as string | undefined);

    case "friday_recent_activity":
      return await fridayRecentActivity(
        typeof args.hours === "number" ? args.hours : 24,
      );

    default:
      return JSON.stringify({ error: `Unknown tool: ${params.name}` });
  }
}

// --- JSON-RPC handler ---

function makeResponse(id: number | string, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function makeError(
  id: number | string | null,
  code: number,
  message: string,
): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
}

async function handleRequest(request: JsonRpcRequest): Promise<string | null> {
  const { method, id, params } = request;

  // Notifications (no id) that require no response.
  if (method === "notifications/initialized") {
    return null;
  }

  // All other methods require an id.
  if (id === undefined || id === null) {
    return null;
  }

  switch (method) {
    case "initialize":
      return makeResponse(id, SERVER_INFO);

    case "ping":
      return makeResponse(id, {});

    case "tools/list":
      return makeResponse(id, { tools: TOOL_DEFINITIONS });

    case "tools/call": {
      const toolParams = params as unknown as ToolCallParams;
      if (!toolParams?.name) {
        return makeError(id, -32602, "Missing tool name in params");
      }
      try {
        const result = await handleToolCall(toolParams);
        return makeResponse(id, {
          content: [{ type: "text", text: result }],
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return makeResponse(id, {
          content: [{ type: "text", text: JSON.stringify({ error: message }) }],
          isError: true,
        });
      }
    }

    default:
      return makeError(id, -32601, `Method not found: ${method}`);
  }
}

// --- Main loop: read JSON-RPC from stdin, write responses to stdout ---

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      const errMsg = makeError(null, -32700, "Parse error");
      process.stdout.write(errMsg + "\n");
      continue;
    }

    const response = await handleRequest(request);
    if (response !== null) {
      process.stdout.write(response + "\n");
    }
  }
}

main();
