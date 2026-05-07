import path from "node:path";
import { readFileSync } from "node:fs";
import type { Config } from "../config.ts";
import type { SessionStore } from "../session/store/interface.ts";
import { handleHealth } from "./routes/health.ts";
import { handleSessions, handleSessionDetail } from "./routes/sessions.ts";
import { handleLogs } from "./routes/logs.ts";
import { handleMemoryList, handleMemoryRead } from "./routes/memory.ts";
import { handleEngramGraph, handleEngramRecall, handleEngramReindex, handleEngramDream } from "./routes/engram.ts";
import { handleChatSend, handleChatStream } from "./routes/chat.ts";
import { ChatManager } from "./chat-manager.ts";
import { getSnapshot, subscribe, type DashboardEvent } from "./dashboard-state.ts";
import {
  handleListFiles,
  handleReadFile,
  handleWriteFile,
  handleListProcesses,
  handleProcessDetails,
  handleAttachTerminal,
  handleKillProcess,
  handleThreadKill,
  handleThreadMute,
  handleWorktreePurge,
} from "./dashboard-api.ts";
import type { SessionManager } from "../session/manager.ts";
import type { WorktreeManager } from "../worktree/manager.ts";
import { clearPersonaCache, getPersonaState } from "../claude/args.ts";
import { log } from "../logger.ts";

const PUBLIC_DIR = path.resolve(import.meta.dir, "../../public");
const DASHBOARD_HTML_PATH = path.join(import.meta.dir, "dashboard.html");
const startedAt = new Date().toISOString();

function cors(res: Response): Response {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type");
  // Chrome private-network access: lets public HTTPS pages (example.com docs)
  // reach this localhost server once the user grants the permission prompt.
  res.headers.set("Access-Control-Allow-Private-Network", "true");
  return res;
}

export function startHttpServer(deps: {
  store: SessionStore;
  config: Config;
  sessionManager: SessionManager;
  worktreeManager: WorktreeManager;
  refreshWorktrees: () => Promise<void>;
}): void {
  const { store, config, sessionManager, worktreeManager, refreshWorktrees } = deps;
  const chatManager = new ChatManager(config);

  const server = Bun.serve({
    port: config.http.port,
    hostname: "127.0.0.1",
    idleTimeout: 255, // max for SSE connections (seconds)
    async fetch(req) {
      const url = new URL(req.url);

      // CORS preflight
      if (req.method === "OPTIONS") {
        return cors(new Response(null, { status: 204 }));
      }

      try {
        let res: Response;

        // Static files
        if (url.pathname === "/" || url.pathname === "/index.html") {
          const file = Bun.file(path.join(PUBLIC_DIR, "index.html"));
          if (await file.exists()) {
            res = new Response(file, {
              headers: { "Content-Type": "text/html; charset=utf-8" },
            });
          } else {
            res = new Response("Dashboard not found. Create public/index.html", {
              status: 404,
            });
          }
          return cors(res);
        }

        // Live dashboard (Live/Threads/Files/Processes)
        if (url.pathname === "/live" || url.pathname === "/dashboard") {
          try {
            const html = readFileSync(DASHBOARD_HTML_PATH, "utf-8");
            res = new Response(html, {
              headers: { "Content-Type": "text/html; charset=utf-8" },
            });
          } catch (err) {
            res = new Response(`dashboard html missing: ${err}`, { status: 500 });
          }
          return cors(res);
        }

        // API routes
        if (url.pathname === "/api/health") {
          res = await handleHealth(store, config, startedAt);
        } else if (url.pathname === "/api/sessions") {
          res = await handleSessions(store);
        } else if (url.pathname.startsWith("/api/sessions/")) {
          const threadId = decodeURIComponent(url.pathname.slice("/api/sessions/".length));
          res = await handleSessionDetail(store, threadId);
        } else if (url.pathname === "/api/logs") {
          res = await handleLogs(url.searchParams);
        } else if (url.pathname === "/api/memory" && !url.pathname.includes("/api/memory/")) {
          res = await handleMemoryList();
        } else if (url.pathname.startsWith("/api/memory/")) {
          const filePath = decodeURIComponent(url.pathname.slice("/api/memory/".length));
          res = await handleMemoryRead(filePath);
        } else if (url.pathname === "/api/engram/graph" && req.method === "GET") {
          res = await handleEngramGraph();
        } else if (url.pathname === "/api/engram/recall" && req.method === "POST") {
          res = await handleEngramRecall(req);
        } else if (url.pathname === "/api/engram/reindex" && req.method === "POST") {
          res = await handleEngramReindex();
        } else if (url.pathname === "/api/engram/dream" && req.method === "POST") {
          res = await handleEngramDream(req);
        } else if (url.pathname === "/api/chat" && req.method === "POST") {
          const body = await req.json();
          res = await handleChatSend(chatManager, body);
        } else if (url.pathname === "/api/chat/stream") {
          res = handleChatStream(chatManager, url.searchParams);
        } else if (url.pathname === "/api/chat/sessions") {
          const sessions = chatManager.getAllSessions();
          res = Response.json({ sessions });
        } else if (url.pathname === "/api/state") {
          res = Response.json(getSnapshot());
        } else if (url.pathname === "/api/files" && req.method === "GET") {
          res = await handleListFiles(url);
        } else if (url.pathname === "/api/file" && req.method === "GET") {
          res = await handleReadFile(url);
        } else if (url.pathname === "/api/file" && req.method === "POST") {
          res = await handleWriteFile(req);
        } else if (url.pathname === "/api/processes" && req.method === "GET") {
          res = await handleListProcesses();
        } else if (url.pathname === "/api/process" && req.method === "GET") {
          res = await handleProcessDetails(url);
        } else if (url.pathname === "/api/attach" && req.method === "POST") {
          res = await handleAttachTerminal(req);
        } else if (url.pathname === "/api/persona/state") {
          res = Response.json(getPersonaState());
        } else if (url.pathname === "/api/persona/reload" && req.method === "POST") {
          clearPersonaCache();
          log.info("persona", "cache cleared via dashboard — next spawn will re-read friday-personal/*.md");
          res = Response.json({ ok: true, ...getPersonaState() });
        } else if (url.pathname === "/api/kill" && req.method === "POST") {
          res = await handleKillProcess(req);
        } else if (url.pathname === "/api/thread/kill" && req.method === "POST") {
          res = await handleThreadKill(req, sessionManager);
        } else if (url.pathname === "/api/thread/mute" && req.method === "POST") {
          res = await handleThreadMute(req, sessionManager);
        } else if (url.pathname === "/api/worktree/purge" && req.method === "POST") {
          res = await handleWorktreePurge(req, worktreeManager, refreshWorktrees);
        } else if (url.pathname === "/events") {
          const stream = new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              const send = (obj: unknown) => {
                try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)); }
                catch { /* client gone */ }
              };

              send({ type: "snapshot", payload: getSnapshot() });

              const unsub = subscribe((ev: DashboardEvent | { kind: "snapshot" }) => {
                if ("kind" in ev && ev.kind === "snapshot") {
                  send({ type: "snapshot", payload: getSnapshot() });
                } else {
                  send({ type: "tick", event: ev, payload: getSnapshot() });
                }
              });

              const hb = setInterval(() => {
                try { controller.enqueue(encoder.encode(`: heartbeat\n\n`)); }
                catch { /* client gone */ }
              }, 15_000);

              req.signal.addEventListener("abort", () => {
                unsub();
                clearInterval(hb);
                try { controller.close(); } catch { /* */ }
              });
            },
          });
          res = new Response(stream, {
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache, no-transform",
              "connection": "keep-alive",
              "x-accel-buffering": "no",
            },
          });
        } else {
          res = Response.json({ error: "not found" }, { status: 404 });
        }

        return cors(res);
      } catch (err) {
        log.error("http", `${req.method} ${url.pathname} — ${err}`);
        return cors(Response.json({ error: "internal server error" }, { status: 500 }));
      }
    },
  });

  log.info("boot", `HTTP server listening on http://localhost:${server.port}`);
}
