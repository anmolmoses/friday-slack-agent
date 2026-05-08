/**
 * Bun HTTP server for Friday's live dashboard.
 *
 * Routes:
 *   GET  /              → HTML dashboard (single-page, tabbed)
 *   GET  /api/state     → current snapshot as JSON
 *   GET  /api/files     → list directory entries (?path=...)
 *   GET  /api/file      → read a file (?path=...)
 *   POST /api/file      → write a file ({path, content})
 *   GET  /api/processes → list claude children + tmux dispatch sessions
 *   POST /api/kill      → kill a pid or tmux session ({pid|tmuxName, kind, signal?})
 *   GET  /events        → server-sent events stream of state updates
 *
 * Mounted on port 3457 (default), localhost-only. The HTML is read from
 * disk on every request so UI tweaks don't need a Friday restart.
 */

import { getSnapshot, subscribe, type DashboardEvent } from "./dashboard-state.ts";
import {
  handleListFiles,
  handleReadFile,
  handleWriteFile,
  handleListProcesses,
  handleKillProcess,
} from "./dashboard-api.ts";
import { log } from "../logger.ts";
import { readFileSync } from "node:fs";
import path from "node:path";

const DASHBOARD_PORT = Number(process.env.FRIDAY_DASHBOARD_PORT ?? 3457);
const HTML_PATH = path.join(import.meta.dir, "dashboard.html");

export function startDashboardServer(): void {
  const server = Bun.serve({
    port: DASHBOARD_PORT,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/" || url.pathname === "/dashboard") {
        try {
          const html = readFileSync(HTML_PATH, "utf-8");
          return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
        } catch (err) {
          return new Response(`dashboard html missing: ${err}`, { status: 500 });
        }
      }

      if (url.pathname === "/api/state") {
        return Response.json(getSnapshot());
      }
      if (url.pathname === "/api/files" && req.method === "GET") {
        return handleListFiles(url);
      }
      if (url.pathname === "/api/file" && req.method === "GET") {
        return handleReadFile(url);
      }
      if (url.pathname === "/api/file" && req.method === "POST") {
        return handleWriteFile(req);
      }
      if (url.pathname === "/api/processes" && req.method === "GET") {
        return handleListProcesses();
      }
      if (url.pathname === "/api/kill" && req.method === "POST") {
        return handleKillProcess(req);
      }

      if (url.pathname === "/events") {
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
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache, no-transform",
            "connection": "keep-alive",
            "x-accel-buffering": "no",
          },
        });
      }

      return new Response("not found", { status: 404 });
    },
    error(err) {
      log.error("dashboard", `server error: ${err}`);
      return new Response("internal error", { status: 500 });
    },
  });
  log.info("dashboard", `live dashboard at http://${server.hostname}:${server.port}/`);
}
