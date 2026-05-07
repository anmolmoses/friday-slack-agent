import { readFileSync } from "node:fs";
import type { Config } from "../config.ts";
import type { ThreadSession } from "../session/types.ts";
import type { AgentDefinition } from "../agents/loader.ts";
import type { SpawnHandle, SpawnResult, StreamEvent } from "./types.ts";
import { buildClaudeArgs } from "./args.ts";
import { createStreamParser } from "./parser.ts";

export function spawnClaude(
  session: ThreadSession,
  prompt: string,
  config: Config["claude"],
  targetRepoCwd?: string,
  botToken?: string,
  agentDef?: AgentDefinition | null,
  requestingUser?: string | null,
  memoryContext?: string,
): SpawnHandle {
  const args = buildClaudeArgs(session, prompt, config, agentDef, memoryContext);
  const cwd = session.worktreePath ?? targetRepoCwd ?? process.cwd();
  const argv = ["claude", ...args];

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    FRIDAY_SPAWNED: "1",
    SLACK_CHANNEL: session.channel,
    SLACK_THREAD_TS: session.threadId,
    // Identifies which Slack user this spawn is acting on behalf of.
    // The PreToolUse self-edit guard hook in ~/.claude/settings.json
    // uses this to enforce that only the user can mutate Friday's own
    // source. Empty string when unknown — hook treats that as
    // non-owner (fail-safe).
    SLACK_USER_ID: requestingUser ?? "",
    // Lets the self-edit guard tell whether the spawn is rooted in Friday's
    // own checkout (in which case relative-path writes also need scrutiny).
    FRIDAY_SPAWN_CWD: cwd,
    FRIDAY_MEMORY_DIR: new URL("../../memory", import.meta.url).pathname,
    ...(botToken ? { SLACK_BOT_TOKEN: botToken } : {}),
  };

  // CRITICAL: never leak an Anthropic API key into the child. When the Claude
  // CLI sees ANTHROPIC_API_KEY it bills the metered API instead of the Max
  // subscription — which silently drains API credits on every spawned turn.
  // Voice-vision keeps its key under FRIDAY_VISION_ANTHROPIC_KEY instead.
  delete env.ANTHROPIC_API_KEY;

  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", env });

  const listeners: Array<(event: StreamEvent) => void> = [];
  const events: StreamEvent[] = [];
  let sessionId: string | null = null;
  let resultText = "";
  let lastAssistantText = "";

  const result = (async (): Promise<SpawnResult> => {
    const parser = createStreamParser();

    try {
      const reader = proc.stdout.getReader();

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = new TextDecoder().decode(value);
        const parsed = parser.feed(chunk);

        for (const event of parsed) {
          events.push(event);

          if (event.type === "system" && event.subtype === "init") {
            sessionId = event.session_id;
          }

          if (event.type === "assistant") {
            // Track the last assistant turn's text (not accumulated across turns)
            let turnText = "";
            for (const block of event.message.content) {
              if (block.type === "text" && block.text) {
                turnText += block.text;
              }
            }
            if (turnText) {
              lastAssistantText = turnText;
            }
          }

          if (event.type === "result") {
            resultText = event.result ?? event.text ?? "";
          }

          for (const listener of listeners) {
            try {
              listener(event);
            } catch (err) {
              console.warn("[spawner] Event listener threw:", err);
            }
          }
        }
      }
    } catch (err) {
      console.error("[spawner] Error reading stdout:", err);
    }

    const exitCode = await proc.exited;

    let error: string | null = null;
    if (exitCode !== 0) {
      try {
        error = await new Response(proc.stderr).text();
      } catch {
        error = `Process exited with code ${exitCode}`;
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
    spawnInfo: (() => {
      // Recover the system-prompt file from argv so the dashboard can show
      // the actual SOUL/AGENTS/IDENTITY content Friday was given.
      const idx = argv.indexOf("--append-system-prompt-file");
      const systemPromptFile = idx >= 0 && argv[idx + 1] ? argv[idx + 1] : null;
      let systemPromptContent: string | null = null;
      if (systemPromptFile) {
        try { systemPromptContent = readFileSync(systemPromptFile, "utf-8"); }
        catch { /* file may not exist on disk yet */ }
      }
      return {
        pid: proc.pid ?? null,
        argv,
        cwd,
        prompt,
        // Names only — values may contain SLACK_BOT_TOKEN and the user's full
        // shell environment. Surfacing values would leak secrets to the dashboard.
        envKeys: Object.keys(env).sort(),
        resumedSessionId: session.sessionId ?? null,
        systemPromptFile,
        systemPromptContent,
      };
    })(),
  };
}
