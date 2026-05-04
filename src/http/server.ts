import path from "node:path";
import type { Config } from "../config.ts";
import type { SessionStore } from "../session/store/interface.ts";
import { handleHealth } from "./routes/health.ts";
import { handleSessions, handleSessionDetail } from "./routes/sessions.ts";
import { handleLogs } from "./routes/logs.ts";
import { handleMemoryList, handleMemoryRead } from "./routes/memory.ts";
import { handleChatSend, handleChatStream } from "./routes/chat.ts";
import { ChatManager } from "./chat-manager.ts";
import { log } from "../logger.ts";

const PUBLIC_DIR = path.resolve(import.meta.dir, "../../public");
const startedAt = new Date().toISOString();

function cors(res: Response): Response {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return res;
}

export function startHttpServer(deps: {
  store: SessionStore;
  config: Config;
}): void {
  const { store, config } = deps;
  const chatManager = new ChatManager(config);

  const server = Bun.serve({
    port: config.http.port,
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
        } else if (url.pathname === "/api/chat" && req.method === "POST") {
          const body = await req.json();
          res = await handleChatSend(chatManager, body);
        } else if (url.pathname === "/api/chat/stream") {
          res = handleChatStream(chatManager, url.searchParams);
        } else if (url.pathname === "/api/chat/sessions") {
          const sessions = chatManager.getAllSessions();
          res = Response.json({ sessions });
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
