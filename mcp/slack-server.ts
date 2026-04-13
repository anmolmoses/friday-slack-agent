#!/usr/bin/env bun
/**
 * MCP (Model Context Protocol) server for Slack.
 *
 * Spawned by Claude Code via --mcp-config. Communicates over stdin/stdout
 * using JSON-RPC 2.0. Exposes Slack Web API operations as MCP tools.
 *
 * Environment: SLACK_BOT_TOKEN must be set by the spawning process.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Slack API helpers
// ---------------------------------------------------------------------------

const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;

if (!SLACK_TOKEN) {
  console.error("SLACK_BOT_TOKEN environment variable is not set");
  process.exit(1);
}

async function slackApi(
  method: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Slack HTTP ${res.status}: ${res.statusText}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  if (!data.ok) {
    throw new Error(`Slack API error: ${data.error ?? "unknown"}`);
  }
  return data;
}

async function slackApiForm(
  method: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams(params);
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_TOKEN}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`Slack HTTP ${res.status}: ${res.statusText}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  if (!data.ok) {
    throw new Error(`Slack API error: ${data.error ?? "unknown"}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS: ToolDefinition[] = [
  {
    name: "slack_post_message",
    description:
      "Post a message to a Slack channel. Optionally reply in a thread by providing thread_ts.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel ID to post to" },
        text: { type: "string", description: "Message text (supports Slack mrkdwn)" },
        thread_ts: {
          type: "string",
          description: "Thread timestamp to reply in (omit for a new top-level message)",
        },
      },
      required: ["channel", "text"],
    },
  },
  {
    name: "slack_add_reaction",
    description: "Add an emoji reaction to a message.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel ID containing the message" },
        timestamp: { type: "string", description: "Timestamp of the message to react to" },
        name: {
          type: "string",
          description: "Emoji name without colons (e.g. 'thumbsup', not ':thumbsup:')",
        },
      },
      required: ["channel", "timestamp", "name"],
    },
  },
  {
    name: "slack_upload_file",
    description:
      "Upload a file to a Slack channel. Uses the three-step upload flow: get URL, upload content, complete.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel ID to share the file in" },
        file_path: { type: "string", description: "Absolute path to the file on disk" },
        comment: {
          type: "string",
          description: "Optional comment to attach to the file",
        },
        thread_ts: {
          type: "string",
          description: "Thread timestamp to share the file in (omit for channel root)",
        },
      },
      required: ["channel", "file_path"],
    },
  },
  {
    name: "slack_get_thread",
    description: "Read all messages in a Slack thread.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel ID containing the thread" },
        thread_ts: {
          type: "string",
          description: "Timestamp of the thread's parent message",
        },
      },
      required: ["channel", "thread_ts"],
    },
  },
  {
    name: "slack_get_user_info",
    description: "Look up a Slack user's profile details by their user ID.",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "Slack user ID (e.g. U01ABC123)" },
      },
      required: ["user_id"],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function handleSlackPostMessage(params: Record<string, unknown>): Promise<ToolResult> {
  const channel = params.channel as string;
  const text = params.text as string;
  const thread_ts = params.thread_ts as string | undefined;

  const body: Record<string, unknown> = { channel, text };
  if (thread_ts) body.thread_ts = thread_ts;

  const data = await slackApi("chat.postMessage", body);
  return {
    content: [
      {
        type: "text",
        text: `Message posted to ${channel}` + (data.ts ? ` (ts: ${data.ts})` : ""),
      },
    ],
  };
}

async function handleSlackAddReaction(params: Record<string, unknown>): Promise<ToolResult> {
  const channel = params.channel as string;
  const timestamp = params.timestamp as string;
  const name = params.name as string;

  await slackApi("reactions.add", { channel, timestamp, name });
  return {
    content: [{ type: "text", text: `Reaction :${name}: added` }],
  };
}

async function handleSlackUploadFile(params: Record<string, unknown>): Promise<ToolResult> {
  const channel = params.channel as string;
  const filePath = params.file_path as string;
  const comment = params.comment as string | undefined;
  const thread_ts = params.thread_ts as string | undefined;

  // Read the file
  const file = Bun.file(filePath);
  const exists = await file.exists();
  if (!exists) {
    return {
      content: [{ type: "text", text: `Error: file not found: ${filePath}` }],
      isError: true,
    };
  }

  const fileSize = file.size;
  const filename = filePath.split("/").pop() ?? "upload";

  // Step 1: Get upload URL
  const uploadUrlData = await slackApiForm("files.getUploadURLExternal", {
    filename,
    length: String(fileSize),
  });

  const uploadUrl = uploadUrlData.upload_url as string;
  const fileId = uploadUrlData.file_id as string;

  // Step 2: Upload file content to the provided URL
  const fileBytes = await file.arrayBuffer();
  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    body: fileBytes,
  });
  if (!uploadRes.ok) {
    throw new Error(`File upload HTTP ${uploadRes.status}: ${uploadRes.statusText}`);
  }

  // Step 3: Complete upload and share to channel
  const completeBody: Record<string, unknown> = {
    files: [{ id: fileId, title: filename }],
    channel_id: channel,
  };
  if (thread_ts) completeBody.thread_ts = thread_ts;
  if (comment) completeBody.initial_comment = comment;

  await slackApi("files.completeUploadExternal", completeBody);

  return {
    content: [{ type: "text", text: `Uploaded ${filename} to ${channel}` }],
  };
}

async function handleSlackGetThread(params: Record<string, unknown>): Promise<ToolResult> {
  const channel = params.channel as string;
  const thread_ts = params.thread_ts as string;

  const data = await slackApi("conversations.replies", { channel, ts: thread_ts });
  const messages = data.messages as Array<Record<string, unknown>> | undefined;

  if (!messages || messages.length === 0) {
    return {
      content: [{ type: "text", text: "No messages found in thread" }],
    };
  }

  const formatted = messages.map((msg) => {
    const user = (msg.user as string) ?? "unknown";
    const text = (msg.text as string) ?? "";
    const ts = (msg.ts as string) ?? "";
    return `[${ts}] <${user}> ${text}`;
  });

  return {
    content: [{ type: "text", text: formatted.join("\n") }],
  };
}

async function handleSlackGetUserInfo(params: Record<string, unknown>): Promise<ToolResult> {
  const user_id = params.user_id as string;

  const data = await slackApi("users.info", { user: user_id });
  const user = data.user as Record<string, unknown> | undefined;

  if (!user) {
    return {
      content: [{ type: "text", text: `No user found for ID ${user_id}` }],
      isError: true,
    };
  }

  const profile = user.profile as Record<string, unknown> | undefined;
  const info = {
    id: user.id,
    name: user.name,
    real_name: user.real_name,
    display_name: profile?.display_name,
    email: profile?.email,
    is_bot: user.is_bot,
    tz: user.tz,
  };

  return {
    content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
  };
}

const TOOL_HANDLERS: Record<
  string,
  (params: Record<string, unknown>) => Promise<ToolResult>
> = {
  slack_post_message: handleSlackPostMessage,
  slack_add_reaction: handleSlackAddReaction,
  slack_upload_file: handleSlackUploadFile,
  slack_get_thread: handleSlackGetThread,
  slack_get_user_info: handleSlackGetUserInfo,
};

// ---------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------

function makeResponse(id: number | string | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function makeError(
  id: number | string | null,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const { method, id, params } = req;

  // Notifications (no id) that don't need a response
  if (method === "notifications/initialized") {
    return null;
  }

  const requestId = id ?? null;

  switch (method) {
    case "initialize":
      return makeResponse(requestId, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "friday-slack", version: "1.0.0" },
      });

    case "ping":
      return makeResponse(requestId, {});

    case "tools/list":
      return makeResponse(requestId, { tools: TOOLS });

    case "tools/call": {
      const toolName = (params?.name as string) ?? "";
      const toolArgs = (params?.arguments as Record<string, unknown>) ?? {};

      const handler = TOOL_HANDLERS[toolName];
      if (!handler) {
        return makeResponse(requestId, {
          content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
          isError: true,
        });
      }

      try {
        const result = await handler(toolArgs);
        return makeResponse(requestId, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Tool ${toolName} failed: ${message}`);
        return makeResponse(requestId, {
          content: [{ type: "text", text: `Error: ${message}` }],
          isError: true,
        });
      }
    }

    default:
      return makeError(requestId, -32601, `Method not found: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// stdio transport
// ---------------------------------------------------------------------------

function writeLine(obj: JsonRpcResponse): void {
  const line = JSON.stringify(obj);
  process.stdout.write(line + "\n");
}

async function main(): Promise<void> {
  console.error("friday-slack MCP server started");

  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });

    // Process complete lines
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);

      if (line.length === 0) continue;

      let request: JsonRpcRequest;
      try {
        request = JSON.parse(line) as JsonRpcRequest;
      } catch {
        const errResp = makeError(null, -32700, "Parse error: invalid JSON");
        writeLine(errResp);
        continue;
      }

      const response = await handleRequest(request);
      if (response !== null) {
        writeLine(response);
      }
    }
  }
}

main().catch((err) => {
  console.error("MCP server fatal error:", err);
  process.exit(1);
});
