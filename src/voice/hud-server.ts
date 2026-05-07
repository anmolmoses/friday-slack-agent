// Tiny localhost server that backs the JARVIS HUD overlay.
//   GET /        → the HUD page (hud/hud.html)
//   GET /events  → SSE stream of {state, detail} as Friday's mode changes
// The Swift overlay (hud/overlay.swift) loads / in a transparent always-on-top
// WKWebView; the page subscribes to /events and animates per state.

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HUD_HTML = path.join(__dirname, "hud", "hud.html");

export type HudState =
  | "offline"   // daemon up, not listening
  | "listening" // mic on, waiting for you
  | "hearing"   // you're speaking
  | "thinking"  // processing / running a tool
  | "speaking"; // Friday is talking

type Client = ReadableStreamDefaultController<Uint8Array>;

export class HudServer {
  private port: number;
  private clients = new Set<Client>();
  private state: HudState = "offline";
  private detail = "";
  private server: ReturnType<typeof Bun.serve> | null = null;
  private enc = new TextEncoder();

  constructor(port: number) {
    this.port = port;
  }

  start(): boolean {
    if (this.server) return true;
    try {
      this.server = Bun.serve({
        port: this.port,
        hostname: "127.0.0.1",
        idleTimeout: 0,
        fetch: (req) => this.handle(req),
      });
      console.log(`[voice:hud] serving on http://127.0.0.1:${this.port}`);
      return true;
    } catch (err) {
      this.server = null;
      const message = err instanceof Error ? err.message : String(err);
      console.log(
        `[voice:hud] disabled: could not bind http://127.0.0.1:${this.port} (${message})`,
      );
      return false;
    }
  }

  stop(): void {
    try { this.server?.stop(true); } catch { /* ignore */ }
    this.server = null;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/`;
  }

  /** Update the displayed mode and push it to every connected overlay. */
  set(state: HudState, detail = ""): void {
    if (state === this.state && detail === this.detail) return;
    this.state = state;
    this.detail = detail;
    this.broadcast();
  }

  /** Push a live voice-amplitude sample (0..1) to drive the waveform. */
  pushLevel(level: number): void {
    const msg = this.enc.encode(`data: ${JSON.stringify({ level: Number(level.toFixed(3)) })}\n\n`);
    for (const c of this.clients) {
      try { c.enqueue(msg); } catch { this.clients.delete(c); }
    }
  }

  private payload(): string {
    return JSON.stringify({ state: this.state, detail: this.detail });
  }

  private broadcast(): void {
    const msg = this.enc.encode(`data: ${this.payload()}\n\n`);
    for (const c of this.clients) {
      try { c.enqueue(msg); } catch { this.clients.delete(c); }
    }
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/events") {
      const self = this;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          self.clients.add(controller);
          // Prime with current state immediately.
          controller.enqueue(self.enc.encode(`data: ${self.payload()}\n\n`));
          const hb = setInterval(() => {
            try { controller.enqueue(self.enc.encode(": ping\n\n")); }
            catch { clearInterval(hb); }
          }, 15_000);
          req.signal.addEventListener("abort", () => {
            clearInterval(hb);
            self.clients.delete(controller);
            try { controller.close(); } catch { /* */ }
          });
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
        },
      });
    }

    // Default: the HUD page.
    const file = Bun.file(HUD_HTML);
    if (await file.exists()) {
      return new Response(file, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return new Response("hud.html missing", { status: 404 });
  }
}
