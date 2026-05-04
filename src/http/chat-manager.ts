import path from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import type { Config } from "../config.ts";
import { createStreamParser } from "../claude/parser.ts";
import { loadPersona } from "../persona.ts";

const FRIDAY_ROOT = path.resolve(import.meta.dir, "../..");
const CHAT_TMP_DIR = "/tmp/friday-chat";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  tools?: { name: string; input: string }[];
}

export interface WebChatSession {
  id: string;
  claudeSessionId: string | null;
  status: "idle" | "busy";
  history: ChatMessage[];
  createdAt: number;
  lastActivity: number;
}

type SSEController = ReadableStreamDefaultController<Uint8Array>;

export class ChatManager {
  private sessions = new Map<string, WebChatSession>();
  private controllers = new Map<string, SSEController>();
  private activeProcs = new Map<string, { kill: () => void }>();
  private config: Config;

  constructor(config: Config) {
    this.config = config;

    // Cleanup stale sessions every 10 minutes
    setInterval(() => this.cleanup(), 10 * 60 * 1000);
  }

  createSession(id?: string): WebChatSession {
    const sessionId = id ?? crypto.randomUUID();
    const session: WebChatSession = {
      id: sessionId,
      claudeSessionId: null,
      status: "idle",
      history: [],
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  getSession(id: string): WebChatSession | undefined {
    return this.sessions.get(id);
  }

  getAllSessions(): WebChatSession[] {
    return [...this.sessions.values()].sort(
      (a, b) => b.lastActivity - a.lastActivity,
    );
  }

  setController(sessionId: string, controller: SSEController): void {
    this.controllers.set(sessionId, controller);
  }

  removeController(sessionId: string): void {
    this.controllers.delete(sessionId);
    // Kill the process if browser disconnected
    const proc = this.activeProcs.get(sessionId);
    if (proc) {
      proc.kill();
      this.activeProcs.delete(sessionId);
    }
  }

  async sendMessage(sessionId: string, message: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Session not found");
    if (session.status === "busy") throw new Error("Session is busy");

    session.status = "busy";
    session.lastActivity = Date.now();
    session.history.push({
      role: "user",
      content: message,
      timestamp: Date.now(),
    });

    // Build a combined system prompt file (persona + memory instructions)
    const persona = await loadPersona();
    const memoryDir = path.join(FRIDAY_ROOT, "memory");
    const instructionsFile = path.join(memoryDir, "instructions.md");
    let instructions = "";
    try {
      instructions = await Bun.file(instructionsFile).text();
    } catch { /* missing file is ok */ }

    mkdirSync(CHAT_TMP_DIR, { recursive: true });
    const systemPromptFile = path.join(CHAT_TMP_DIR, `${sessionId}.md`);
    writeFileSync(systemPromptFile, `${persona}\n\n${instructions}`);

    const args = [
      "-p",
      message,
      "--output-format",
      "stream-json",
      "--verbose",
      "--max-turns",
      String(this.config.claude.maxTurns),
      "--add-dir",
      memoryDir,
      "--append-system-prompt-file",
      systemPromptFile,
      "--exclude-dynamic-system-prompt-sections",
      "--permission-mode",
      this.config.claude.permissionMode,
    ];

    if (session.claudeSessionId) {
      args.push("--resume", session.claudeSessionId);
    }

    const proc = Bun.spawn(["claude", ...args], {
      cwd: FRIDAY_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        FRIDAY_SPAWNED: "1",
        FRIDAY_MEMORY_DIR: memoryDir,
      },
    });

    this.activeProcs.set(sessionId, { kill: () => proc.kill() });

    const controller = this.controllers.get(sessionId);
    const parser = createStreamParser();
    const encoder = new TextEncoder();
    let responseText = "";
    let lastAssistantText = "";
    const tools: { name: string; input: string }[] = [];

    const pushSSE = (event: string, data: unknown) => {
      if (!controller) return;
      try {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(payload));
      } catch {
        // Controller closed
      }
    };

    try {
      const reader = proc.stdout.getReader();

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = new TextDecoder().decode(value);
        const events = parser.feed(chunk);

        for (const event of events) {
          if (event.type === "system" && event.subtype === "init") {
            session.claudeSessionId = event.session_id;
            pushSSE("init", {
              sessionId: session.id,
              claudeSessionId: event.session_id,
            });
          }

          if (event.type === "assistant") {
            let turnText = "";
            for (const block of event.message.content) {
              if (block.type === "text" && block.text) {
                turnText += block.text;
                pushSSE("text", { text: block.text });
              }
              if (block.type === "tool_use") {
                const inputStr =
                  typeof block.input === "string"
                    ? block.input
                    : JSON.stringify(block.input);
                tools.push({ name: block.name ?? "unknown", input: inputStr });
                pushSSE("tool_use", {
                  name: block.name ?? "unknown",
                  input: inputStr.slice(0, 200),
                });
              }
            }
            if (turnText) lastAssistantText = turnText;
          }

          if (event.type === "result") {
            responseText = event.result ?? event.text ?? "";
            pushSSE("result", { text: responseText });
          }
        }
      }
    } catch (err) {
      pushSSE("error", {
        message: err instanceof Error ? err.message : String(err),
      });
    }

    const exitCode = await proc.exited;
    this.activeProcs.delete(sessionId);

    if (exitCode !== 0) {
      let stderr = "";
      try {
        stderr = await new Response(proc.stderr).text();
      } catch { /* ignore */ }
      console.error(`[chat] claude exited with code ${exitCode}: ${stderr.slice(0, 500)}`);
      pushSSE("error", { message: stderr || `Process exited with code ${exitCode}` });
    }

    const finalText = responseText || lastAssistantText;
    if (finalText) {
      session.history.push({
        role: "assistant",
        content: finalText,
        timestamp: Date.now(),
        tools: tools.length > 0 ? tools : undefined,
      });
    }

    session.status = "idle";
    session.lastActivity = Date.now();
    pushSSE("done", {});
  }

  private cleanup(): void {
    const staleMs = 30 * 60 * 1000; // 30 minutes
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.status === "idle" && now - session.lastActivity > staleMs) {
        this.sessions.delete(id);
        this.controllers.delete(id);
      }
    }
  }
}
