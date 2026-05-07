import path from "node:path";
import type { Config } from "../config.ts";
import type { ThreadSession } from "../session/types.ts";
import type { AgentDefinition } from "../agents/loader.ts";
import type { SpawnHandle, SpawnResult, StreamEvent } from "../claude/types.ts";
import { buildSystemContext } from "../claude/args.ts";

const FRIDAY_ROOT = path.resolve(import.meta.dir, "../..");

/**
 * Codex-specific framing appended to the shared persona/memory context. Tells
 * the Codex brain how it differs operationally from the Claude brain: it runs
 * the conversation and owns memory/docs, but ALL coding is dispatched to Claude.
 * Codex does not auto-load CLAUDE.md, so the handoff mechanism is spelled out.
 */
const CODEX_BRAIN_ADDENDUM = `# How you run (Codex brain)

You are Friday's conversational brain, running on Codex from her home repo
(${FRIDAY_ROOT}). Whatever you reply with becomes Friday's Slack message — write
as Friday, in her voice. You handle conversation, planning, rubber-ducking,
writing to memory (the \`memory/\` directory), and writing docs/prompts (the
\`docs/\` directory). You may edit those files directly.

**Coding is NOT your job — hand it to Claude.** For any request that means
building a feature, fixing a bug, refactoring, reviewing a PR, or otherwise
changing a target repo's code, do NOT write that code yourself. Dispatch it to a
Claude Code session:

\`\`\`
bin/dispatch-claude.sh <clone-root> "<detailed prompt>"
# or, for a long prompt:
echo "<detailed prompt>" | bin/dispatch-claude.sh <clone-root>
\`\`\`

- Clone roots live under \`<workspace-root>/<repo>\`
  (e.g. example-backend, example-mobile, Example-Internal). Pass the clone ROOT — the
  script resolves its own per-thread worktree.
- Put everything Claude needs in the prompt: the task, relevant conventions, and
  the ABSOLUTE PATH of any file the user shared in the thread.
- The dispatch runs detached and posts its own result back to this Slack thread
  via a Stop hook. So after dispatching: reply with ONE short ack line ("On it —
  dispatched to Claude, I'll report back") and end your turn. Do not wait, and
  do not fabricate the outcome.
- For non-coding shell needs (reading a file, checking memory) you may run
  commands yourself.`;

/**
 * Spawn Friday's conversational brain on Codex (`codex exec`) instead of Claude.
 *
 * Drop-in for spawnClaude: identical signature, returns the same SpawnHandle so
 * SessionManager and the Slack streamer consume it unchanged. Codex drives
 * chat, memory writes, doc writing and planning; actual coding is still handed
 * off to Claude via bin/dispatch-claude.sh (Codex runs that script itself).
 *
 * Auth: forced onto the ChatGPT subscription by stripping OPENAI_API_KEY from
 * the child env — exactly mirroring why we strip ANTHROPIC_API_KEY from the
 * Claude spawner. Never bills the metered API.
 */
export function spawnCodex(
  session: ThreadSession,
  prompt: string,
  _config: Config["claude"],
  _targetRepoCwd?: string,
  botToken?: string,
  _agentDef?: AgentDefinition | null,
  requestingUser?: string | null,
  memoryContext?: string,
): SpawnHandle {
  const model = process.env.FRIDAY_CODEX_MODEL || "gpt-5.5";
  // The brain operates from Friday's own repo so memory/ and docs/ writes land
  // in the right tree. Coding work is dispatched into per-thread worktrees by
  // bin/dispatch-claude.sh, which resolves its own cwd.
  const cwd = FRIDAY_ROOT;

  const systemContext = `${buildSystemContext(session, memoryContext)}\n\n${CODEX_BRAIN_ADDENDUM}`;

  // First turn: prepend the full persona/memory context. On resume the thread
  // already carries it (codex replays history), so we send only the new message.
  const resuming = Boolean(session.sessionId);
  const stdinPrompt = resuming
    ? prompt
    : `${systemContext}\n\n---\n\n# Current message\n\n${prompt}`;

  // ~/.codex/config.toml may default to xhigh reasoning (minutes per turn) —
  // far too slow for a chat brain. Override to a snappier effort; tune via env.
  const reasoning = process.env.FRIDAY_CODEX_REASONING || "medium";

  const flags = [
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "-m",
    model,
    "-c",
    `model_reasoning_effort=${reasoning}`,
    "-C",
    cwd,
  ];

  // `-` makes codex read the prompt from stdin — avoids ARG_MAX on the large
  // persona blob and keeps secrets out of the process arg list.
  const argv = resuming
    ? ["codex", "exec", ...flags, "resume", session.sessionId as string, "-"]
    : ["codex", "exec", ...flags, "-"];

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    FRIDAY_SPAWNED: "1",
    SLACK_CHANNEL: session.channel,
    SLACK_THREAD_TS: session.threadId,
    SLACK_USER_ID: requestingUser ?? "",
    FRIDAY_SPAWN_CWD: cwd,
    FRIDAY_MEMORY_DIR: path.join(FRIDAY_ROOT, "memory"),
    ...(botToken ? { SLACK_BOT_TOKEN: botToken } : {}),
  };

  // CRITICAL: force the ChatGPT subscription, never the metered API. If codex
  // sees OPENAI_API_KEY it bills per-token instead of the flat-rate sub. Also
  // strip the Anthropic key so any claude the brain dispatches uses Max too.
  delete env.OPENAI_API_KEY;
  delete env.ANTHROPIC_API_KEY;

  const proc = Bun.spawn(argv, {
    cwd,
    stdin: new TextEncoder().encode(stdinPrompt),
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

  const listeners: Array<(event: StreamEvent) => void> = [];
  const events: StreamEvent[] = [];
  let sessionId: string | null = session.sessionId ?? null;
  let resultText = "";
  let lastAssistantText = "";

  const emit = (event: StreamEvent): void => {
    events.push(event);
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (err) {
        console.warn("[codex] Event listener threw:", err);
      }
    }
  };

  const result = (async (): Promise<SpawnResult> => {
    try {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Codex emits one JSON object per line (JSONL).
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;

          let obj: CodexEvent;
          try {
            obj = JSON.parse(line) as CodexEvent;
          } catch {
            // Non-JSON noise (e.g. a startup banner) — ignore.
            continue;
          }

          for (const ev of mapCodexEvent(obj)) {
            if (ev.type === "system" && ev.subtype === "init") {
              sessionId = ev.session_id;
            }
            if (ev.type === "assistant") {
              let turnText = "";
              for (const block of ev.message.content) {
                if (block.type === "text" && block.text) turnText += block.text;
              }
              if (turnText) lastAssistantText = turnText;
            }
            if (ev.type === "result") {
              resultText = ev.result ?? ev.text ?? "";
            }
            emit(ev);
          }
        }
      }
    } catch (err) {
      console.error("[codex] Error reading stdout:", err);
    }

    const exitCode = await proc.exited;

    let error: string | null = null;
    if (exitCode !== 0) {
      try {
        error = await new Response(proc.stderr).text();
      } catch {
        error = `codex exited with code ${exitCode}`;
      }
    }

    return {
      sessionId,
      response: resultText || lastAssistantText,
      events,
      exitCode,
      error,
    };
  })();

  return {
    result,
    onEvent: (cb) => {
      listeners.push(cb);
    },
    kill: () => {
      proc.kill();
    },
    pid: proc.pid,
    spawnInfo: {
      pid: proc.pid ?? null,
      argv,
      cwd,
      prompt: stdinPrompt,
      // Names only — values may include SLACK_BOT_TOKEN.
      envKeys: Object.keys(env).sort(),
      resumedSessionId: resuming ? session.sessionId : null,
      systemPromptFile: null,
      systemPromptContent: systemContext || null,
    },
  };
}

// ---- Codex JSONL event schema (codex exec --json) -> StreamEvent ----

export interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    [k: string]: unknown;
  };
  error?: { message?: string } | string;
  [k: string]: unknown;
}

/**
 * Translate one Codex event into zero or more Claude-shaped StreamEvents so the
 * rest of the pipeline (Slack streamer, dashboard) is engine-agnostic.
 */
export function mapCodexEvent(ev: CodexEvent): StreamEvent[] {
  switch (ev.type) {
    case "thread.started":
      if (ev.thread_id) {
        return [{ type: "system", subtype: "init", session_id: ev.thread_id }];
      }
      return [];

    case "item.completed": {
      const item = ev.item;
      if (!item) return [];
      const itemType = item.type ?? "";

      if (itemType === "agent_message") {
        const text = typeof item.text === "string" ? item.text : "";
        if (!text) return [];
        return [
          {
            type: "assistant",
            message: { role: "assistant", content: [{ type: "text", text }] },
          },
        ];
      }

      if (itemType === "reasoning") {
        const text = typeof item.text === "string" ? item.text : "";
        if (!text) return [];
        return [
          {
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "thinking", thinking: text }],
            },
          },
        ];
      }

      // Any other completed item (command_execution, file_change, mcp_tool_call,
      // etc.) surfaces as a tool_use block so the Slack status line shows activity.
      const { id: _id, type: _t, ...rest } = item;
      return [
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                name: itemType || "tool",
                input: rest as Record<string, unknown>,
              },
            ],
          },
        },
      ];
    }

    case "turn.completed":
      return [{ type: "result", subtype: "success" }];

    case "turn.failed":
    case "error": {
      const msg =
        typeof ev.error === "string"
          ? ev.error
          : ev.error?.message ?? "codex turn failed";
      return [{ type: "result", subtype: "error", result: msg }];
    }

    default:
      return [];
  }
}
