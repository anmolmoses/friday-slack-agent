import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { ThreadSession } from "../types.ts";
import type { SessionStore } from "./interface.ts";
import { log } from "../../logger.ts";

interface SerializedFile {
  version: 1;
  updatedAt: string;
  sessions: Record<string, ThreadSession>;
}

export class FileSessionStore implements SessionStore {
  private sessions = new Map<string, ThreadSession>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;

  constructor(private readonly filePath: string) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const data = JSON.parse(raw) as SerializedFile;
      for (const [threadId, session] of Object.entries(data.sessions ?? {})) {
        // Reset any transient status from the prior process — we can't resume
        // a process that was mid-turn. Drop pending messages so we don't drain
        // into a stale session.
        this.sessions.set(threadId, {
          ...session,
          status: "idle",
          pid: null,
          pendingMessages: [],
          // Defaults for fields added after sessions.json was first written.
          spiralScore: typeof session.spiralScore === "number" ? session.spiralScore : 0,
          recentJabs: Array.isArray(session.recentJabs) ? session.recentJabs : [],
          worktreeProvisioned:
            typeof session.worktreeProvisioned === "boolean"
              ? session.worktreeProvisioned
              : false,
        });
      }
      log.info("session-store", `Loaded ${this.sessions.size} sessions from ${this.filePath}`);
    } catch (err) {
      log.warn("session-store", `Failed to load ${this.filePath}: ${err}`);
    }
  }

  private schedule(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch((err) => log.error("session-store", `flush failed: ${err}`));
    }, 200);
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const data: SerializedFile = {
        version: 1,
        updatedAt: new Date().toISOString(),
        sessions: Object.fromEntries(this.sessions),
      };
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2));
      renameSync(tmp, this.filePath);
    } finally {
      this.flushing = false;
    }
  }

  async get(threadId: string): Promise<ThreadSession | undefined> {
    return this.sessions.get(threadId);
  }

  async set(threadId: string, session: ThreadSession): Promise<void> {
    this.sessions.set(threadId, session);
    this.schedule();
  }

  async delete(threadId: string): Promise<void> {
    this.sessions.delete(threadId);
    this.schedule();
  }

  async getAll(): Promise<Map<string, ThreadSession>> {
    return new Map(this.sessions);
  }

  async updateActivity(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (session) {
      session.lastActivity = Date.now();
      this.schedule();
    }
  }

  async flushNow(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
}
