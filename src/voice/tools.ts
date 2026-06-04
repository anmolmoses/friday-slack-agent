// Tools Friday can call from the voice route. Full Mac control, no guardrails
// (per Anmol's decision): arbitrary shell + AppleScript run without confirmation.
//
// `dispatch_to_claude` hands heavy engineering work to the EXISTING
// bin/dispatch-claude.sh, which needs a Slack thread to report back into. On
// first use we seed a thread in SLACK_VOICE_CHANNEL and reuse it for the session,
// so dispatched work streams back to Slack and the existing Stop-hook fires
// unchanged — full audit trail.

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { reindexIncremental } from "../memory/engram-bridge.ts";
import { searchMemory } from "../memory/search.ts";
import {
  cameraPermissionHelp,
  captureCameraFrame,
  lookupVisualPerson,
  rememberVisualPerson,
} from "../memory/vision.ts";
import { inferRepoFromText } from "../slack/routing.ts";
import type { VoiceConfig } from "./config.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const DISPATCH_SH = path.join(REPO_ROOT, "bin", "dispatch-claude.sh");
const VOICE_DISPATCH_DIR = "/tmp/friday-voice/dispatch";
const VOICE_SCREENSHOT_DIR = "/tmp/friday-voice/screenshots";
const VOICE_HELPER_DIR = path.join(
  process.env.HOME ?? "/tmp",
  ".friday",
  "voice",
);
const MOUSE_SRC = path.join(__dirname, "mouse-control.swift");
const MOUSE_BIN = path.join(VOICE_HELPER_DIR, "friday-mouse");
const ENGRAM_DIR = path.join(REPO_ROOT, "engram");
const ENGRAM_CLI = path.join(ENGRAM_DIR, "dist", "cli.js");
const ENGRAM_DB = path.join(REPO_ROOT, ".engram", "dashboard.db");

const MAX_OUTPUT = 4000; // chars of tool output handed back to the model

export interface RealtimeTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface RealtimeImageAttachment {
  path: string;
  prompt?: string;
}

export interface ToolExecutionResult {
  output: string;
  realtimeImages?: RealtimeImageAttachment[];
}

export type ToolRunResult = string | ToolExecutionResult;

function repoToolDescription(cfg?: VoiceConfig): string {
  const repos = cfg?.repos.map((r) => r.name).join(", ");
  return repos
    ? `Optional repo name. Known repos: ${repos}. If omitted, Friday will infer it from the prompt/URL/keywords.`
    : "Optional repo name. If omitted, Friday will infer it from the prompt when possible.";
}

function cameraState(cfg?: VoiceConfig): string {
  return cfg?.cameraEnabled
    ? "Camera is enabled."
    : "Camera is disabled by FRIDAY_VOICE_CAMERA=false.";
}

export function toolDefsForConfig(cfg?: VoiceConfig): RealtimeTool[] {
  return [
    {
      type: "function",
      name: "run_shell",
      description:
        "Run a shell command on Anmol's Mac (zsh login shell) and return stdout/stderr. Use for anything on the command line — file ops, querying system state, launching things, git, etc.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute.",
          },
        },
        required: ["command"],
      },
    },
    {
      type: "function",
      name: "run_applescript",
      description:
        "Run an AppleScript on the Mac. Use for UI automation and app control (System Events, controlling Music/Safari/Finder, dialogs, window management).",
      parameters: {
        type: "object",
        properties: {
          script: {
            type: "string",
            description: "The AppleScript source to run.",
          },
        },
        required: ["script"],
      },
    },
    {
      type: "function",
      name: "open_app",
      description:
        "Open / launch / focus a macOS application by name (e.g. 'Spotify', 'Visual Studio Code', 'Safari').",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Application name." },
        },
        required: ["name"],
      },
    },
    {
      type: "function",
      name: "type_text",
      description:
        "Type text into whatever app is currently focused (uses System Events keystroke). Requires Accessibility permission.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "Text to type into the focused app.",
          },
        },
        required: ["text"],
      },
    },
    {
      type: "function",
      name: "key_combo",
      description:
        "Press a keyboard shortcut in the focused app, e.g. 'cmd+t', 'cmd+shift+4', 'cmd+space', 'return'. Use modifiers cmd/shift/option/control.",
      parameters: {
        type: "object",
        properties: {
          combo: {
            type: "string",
            description: "Shortcut like 'cmd+shift+4'.",
          },
        },
        required: ["combo"],
      },
    },
    {
      type: "function",
      name: "web_search",
      description:
        "Search the public internet for current information. Use before answering questions that may depend on recent facts, releases, docs, prices, schedules, or live web content.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query." },
          limit: {
            type: "number",
            description: "Number of results to return, 1-8.",
          },
        },
        required: ["query"],
      },
    },
    {
      type: "function",
      name: "browser_open_url",
      description:
        "Open a URL in the user's browser. Use when Anmol asks to open a site or when a browser UI task needs a page loaded.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "URL to open. Bare domains are accepted.",
          },
          app: {
            type: "string",
            description:
              "Optional macOS browser app name, e.g. Safari, Chrome, Arc.",
          },
        },
        required: ["url"],
      },
    },
    {
      type: "function",
      name: "browser_page_text",
      description:
        "Fetch a web page and return readable extracted text plus title/status. Use after search results or URL mentions when you need page content, not just the result snippet.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "URL to read. Bare domains are accepted.",
          },
          max_chars: {
            type: "number",
            description: "Maximum extracted characters to return, 1000-12000.",
          },
        },
        required: ["url"],
      },
    },
    {
      type: "function",
      name: "browser_screenshot",
      description:
        "Take a browser screenshot. With a URL, captures that page through Playwright. Without a URL, captures the current screen so Friday can inspect the visible browser/UI.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Optional URL to capture with Playwright.",
          },
          full_page: {
            type: "boolean",
            description: "Capture the full page when URL is provided.",
          },
          browser: {
            type: "string",
            description:
              "Optional Playwright browser: chromium, firefox, or webkit.",
          },
        },
      },
    },
    {
      type: "function",
      name: "screen_screenshot",
      description:
        "Capture the current Mac screen to a PNG file and return its path/dimensions. Use before coordinate-based mouse control or when asked what is visible.",
      parameters: {
        type: "object",
        properties: {
          note: {
            type: "string",
            description: "Optional reason for the screenshot.",
          },
        },
      },
    },
    {
      type: "function",
      name: "camera_snapshot",
      description:
        `Capture one still image from the Mac camera and return its path/dimensions. ${cameraState(cfg)} Use only when Anmol asks Friday to look through the camera or when vision is needed.`,
      parameters: {
        type: "object",
        properties: {
          note: {
            type: "string",
            description: "Optional reason for the camera snapshot.",
          },
        },
      },
    },
    {
      type: "function",
      name: "camera_see",
      description:
        `Capture one Mac camera frame and attach it to the live Realtime conversation as vision input so Friday can inspect it. ${cameraState(cfg)} Use this to answer visual questions about the physical scene.`,
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description:
              "Short instruction for what to inspect in the camera image.",
          },
        },
      },
    },
    {
      type: "function",
      name: "visual_person_lookup",
      description:
        `Compare a camera frame or image path against Friday's confirmed visual-person memory. ${cameraState(cfg)} Treat matches as tentative unless confidence is high; ask for confirmation when uncertain.`,
      parameters: {
        type: "object",
        properties: {
          image_path: {
            type: "string",
            description:
              "Optional image path. If omitted, capture a fresh camera frame.",
          },
          limit: {
            type: "number",
            description: "Number of candidate people to return, 1-10.",
          },
        },
      },
    },
    {
      type: "function",
      name: "visual_person_remember",
      description:
        `Remember a confirmed person's visual identity by saving a camera image and an Engram-indexable memory card. ${cameraState(cfg)} Use only after Anmol or the person confirms their name.`,
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Confirmed person name.",
          },
          image_path: {
            type: "string",
            description:
              "Optional image path from camera_snapshot/camera_see. If omitted, capture a fresh camera frame.",
          },
          relationship: {
            type: "string",
            description: "Optional relationship/context, e.g. friend, teammate.",
          },
          notes: {
            type: "string",
            description: "Optional stable notes to remember about this person.",
          },
          description: {
            type: "string",
            description:
              "Optional visual description from the current camera image.",
          },
        },
        required: ["name"],
      },
    },
    {
      type: "function",
      name: "mouse_control",
      description:
        "Move/click/drag the Mac mouse using screen coordinates. It flashes an orange ring while controlling the pointer. Take a screenshot first unless coordinates are already known.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["check", "move", "click", "double_click", "drag"],
            description:
              "Mouse action. Use check to verify Accessibility permission without moving the pointer.",
          },
          x: {
            type: "number",
            description:
              "Start/target X coordinate in screen pixels from the top-left.",
          },
          y: {
            type: "number",
            description:
              "Start/target Y coordinate in screen pixels from the top-left.",
          },
          to_x: {
            type: "number",
            description: "Drag destination X coordinate.",
          },
          to_y: {
            type: "number",
            description: "Drag destination Y coordinate.",
          },
          duration_ms: {
            type: "number",
            description: "Drag duration in milliseconds.",
          },
        },
        required: ["action"],
      },
    },
    {
      type: "function",
      name: "memory_search",
      description:
        "Search Friday's local memory corpus for past conversations, preferences, project notes, and remembered facts. Use for questions about what Anmol said before or how he likes things done.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Memory search query." },
          limit: {
            type: "number",
            description: "Number of memory snippets, 1-10.",
          },
        },
        required: ["query"],
      },
    },
    {
      type: "function",
      name: "engram_recall",
      description:
        "Ask the associative engram memory engine for semantically related memories, even when they do not share keywords. Use for deeper long-term context and project associations.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Recall query." },
          limit: {
            type: "number",
            description: "Number of associative memories, 1-8.",
          },
        },
        required: ["query"],
      },
    },
    {
      type: "function",
      name: "remember",
      description:
        "Store a durable memory note, preference, decision, or lesson so Friday can recall it later. Use when Anmol explicitly says to remember something or states a stable preference.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Memory text to store." },
          topic: { type: "string", description: "Short topic label." },
          importance: { type: "number", description: "Importance from 1-5." },
        },
        required: ["text"],
      },
    },
    {
      type: "function",
      name: "dispatch_engineering",
      description:
        "Preferred tool for substantial engineering work. It infers the target repo from the prompt, GitHub URL, PR URL, or keywords; then dispatches to Claude+Slack when Slack is configured, otherwise local Codex in a Terminal. Use this instead of asking Anmol which repo unless the task is truly ambiguous and dangerous.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "The full engineering task instruction.",
          },
          repo: {
            type: "string",
            description: repoToolDescription(cfg),
          },
          engine: {
            type: "string",
            enum: ["auto", "codex", "claude"],
            description:
              "auto chooses Claude+Slack when available, otherwise local Codex. Use codex for local terminal work; claude for Slack-audited dispatch.",
          },
        },
        required: ["prompt"],
      },
    },
    {
      type: "function",
      name: "dispatch_to_codex",
      description:
        "Start a local Codex engineering session in Terminal. Use when Slack dispatch is unavailable, when Anmol says Codex, or for local repo work that should not depend on Slack.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "The full engineering task instruction.",
          },
          repo: {
            type: "string",
            description: repoToolDescription(cfg),
          },
        },
        required: ["prompt"],
      },
    },
    {
      type: "function",
      name: "dispatch_to_claude",
      description:
        "Hand a substantial engineering task to a full Claude Code session in a terminal (building a feature, fixing a bug, reviewing a PR, running a release). It runs asynchronously and reports back in Slack. Use this instead of doing big coding work yourself.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description:
              "The full task instruction for the Claude Code session.",
          },
          repo: {
            type: "string",
            description: repoToolDescription(cfg),
          },
        },
        required: ["prompt"],
      },
    },
  ];
}

export const TOOL_DEFS: RealtimeTool[] = toolDefsForConfig();

function truncate(s: string): string {
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n…[truncated]` : s;
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

function clampInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function artifactName(prefix: string, ext: string): string {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
}

function localDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function htmlDecode(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_m, dec: string) =>
      String.fromCodePoint(Number.parseInt(dec, 10)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ");
}

function stripHtml(html: string): string {
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|article|section|tr|blockquote)>/gi, "\n");
  return htmlDecode(withoutNoise.replace(/<[^>]+>/g, " "))
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function pageTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? stripHtml(m[1] ?? "").slice(0, 180) : "";
}

function normalizeUrlInput(raw: string): string {
  const trimmed = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  if (/^[\w.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(trimmed))
    return `https://${trimmed}`;
  return trimmed;
}

function normalizeSearchUrl(raw: string): string {
  const decoded = htmlDecode(raw);
  const withScheme = decoded.startsWith("//") ? `https:${decoded}` : decoded;
  try {
    const url = new URL(withScheme, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : url.href;
  } catch {
    return decoded;
  }
}

function ensureMouseBinary(): string | null {
  if (!existsSync(MOUSE_SRC)) return null;
  try {
    mkdirSync(VOICE_HELPER_DIR, { recursive: true });
    const shouldCompile =
      !existsSync(MOUSE_BIN) ||
      statSync(MOUSE_SRC).mtimeMs > statSync(MOUSE_BIN).mtimeMs;
    if (!shouldCompile) return MOUSE_BIN;
    const proc = Bun.spawnSync(
      ["/usr/bin/swiftc", "-O", MOUSE_SRC, "-o", MOUSE_BIN],
      {
        cwd: REPO_ROOT,
        stdout: "pipe",
        stderr: "pipe",
        env: process.env as Record<string, string>,
      },
    );
    if (proc.exitCode !== 0) return null;
    return MOUSE_BIN;
  } catch {
    return null;
  }
}

function screenRecordingHelp(): string {
  return [
    "Screen screenshot failed because macOS did not return a valid image.",
    "Grant Screen Recording permission to the app launching Friday voice, usually Terminal.",
    "On newer macOS this pane is named Screen & System Audio Recording.",
    "If Terminal is already enabled there, quit Terminal completely with Cmd+Q, reopen it, then restart Friday voice. macOS does not apply this permission to Terminal sessions that were already running.",
  ].join("\n");
}

function accessibilityHelp(extra = ""): string {
  return [
    extra || "Mouse control needs macOS Accessibility permission.",
    `Grant Accessibility to ${MOUSE_BIN} and Terminal in System Settings > Privacy & Security > Accessibility, then restart Friday voice.`,
  ].join("\n");
}

async function run(cmd: string[], input?: string): Promise<string> {
  const proc = Bun.spawn(cmd, {
    cwd: REPO_ROOT,
    stdin: input != null ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env as Record<string, string>,
  });
  if (input != null && proc.stdin) {
    proc.stdin.write(input);
    proc.stdin.end();
  }
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const body = [out.trim(), err.trim()].filter(Boolean).join("\n");
  if (code !== 0) return truncate(`[exit ${code}] ${body || "(no output)"}`);
  return truncate(body || "(ok, no output)");
}

// Map "cmd+shift+4" → AppleScript `keystroke "4" using {command down, shift down}`.
function comboToAppleScript(combo: string): string {
  const parts = combo
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  const modMap: Record<string, string> = {
    cmd: "command down",
    command: "command down",
    shift: "shift down",
    opt: "option down",
    option: "option down",
    alt: "option down",
    ctrl: "control down",
    control: "control down",
  };
  const keyMap: Record<string, string> = {
    return: "return",
    enter: "return",
    esc: "key code 53",
    escape: "key code 53",
    tab: "tab",
    space: "space",
    delete: "key code 51",
    backspace: "key code 51",
    up: "key code 126",
    down: "key code 125",
    left: "key code 123",
    right: "key code 124",
  };
  const mods: string[] = [];
  let key = "";
  for (const p of parts) {
    if (modMap[p]) mods.push(modMap[p]);
    else key = p;
  }
  const using = mods.length ? ` using {${mods.join(", ")}}` : "";
  let action: string;
  if (key === "space") action = `key code 49${using}`;
  else if (keyMap[key]?.startsWith("key code"))
    action = `${keyMap[key]}${using}`;
  else if (keyMap[key]) action = `keystroke ${keyMap[key]}${using}`;
  else action = `keystroke "${key}"${using}`;
  return `tell application "System Events" to ${action}`;
}

/** Stateful per-daemon-session tool runner (caches the seeded Slack thread). */
export class ToolRunner {
  private cfg: VoiceConfig;
  private dispatchThreadTs: string | null = null;

  constructor(cfg: VoiceConfig) {
    this.cfg = cfg;
  }

  async exec(name: string, args: Record<string, unknown>): Promise<ToolRunResult> {
    try {
      switch (name) {
        case "run_shell":
          return await run(["/bin/zsh", "-lc", String(args.command ?? "")]);
        case "run_applescript":
          return await run(
            ["/usr/bin/osascript", "-"],
            String(args.script ?? ""),
          );
        case "open_app":
          return await run(["/usr/bin/open", "-a", String(args.name ?? "")]);
        case "type_text":
          return await run(
            ["/usr/bin/osascript", "-"],
            `tell application "System Events" to keystroke ${JSON.stringify(String(args.text ?? ""))}`,
          );
        case "key_combo":
          return await run(
            ["/usr/bin/osascript", "-"],
            comboToAppleScript(String(args.combo ?? "")),
          );
        case "web_search":
          return await this.webSearch(String(args.query ?? ""), args.limit);
        case "browser_open_url":
          return await this.browserOpenUrl(
            String(args.url ?? ""),
            args.app ? String(args.app) : undefined,
          );
        case "browser_page_text":
          return await this.browserPageText(
            String(args.url ?? ""),
            args.max_chars,
          );
        case "browser_screenshot":
          return await this.browserScreenshot(
            args.url ? String(args.url) : undefined,
            Boolean(args.full_page),
            args.browser ? String(args.browser) : undefined,
          );
        case "screen_screenshot":
          return await this.screenScreenshot(
            args.note ? String(args.note) : undefined,
          );
        case "camera_snapshot":
          return await this.cameraSnapshot(
            args.note ? String(args.note) : undefined,
          );
        case "camera_see":
          return await this.cameraSee(
            args.prompt ? String(args.prompt) : undefined,
          );
        case "visual_person_lookup":
          return await this.visualPersonLookup(
            args.image_path ? String(args.image_path) : undefined,
            args.limit,
          );
        case "visual_person_remember":
          return await this.visualPersonRemember(
            String(args.name ?? ""),
            args.image_path ? String(args.image_path) : undefined,
            args.relationship ? String(args.relationship) : undefined,
            args.notes ? String(args.notes) : undefined,
            args.description ? String(args.description) : undefined,
          );
        case "mouse_control":
          return await this.mouseControl(
            String(args.action ?? ""),
            args.x,
            args.y,
            args.to_x,
            args.to_y,
            args.duration_ms,
          );
        case "memory_search":
          return this.memorySearch(String(args.query ?? ""), args.limit);
        case "engram_recall":
          return await this.engramRecall(String(args.query ?? ""), args.limit);
        case "remember":
          return await this.remember(
            String(args.text ?? ""),
            args.topic ? String(args.topic) : undefined,
            args.importance,
          );
        case "dispatch_engineering":
          return await this.dispatchEngineering(
            String(args.prompt ?? ""),
            args.repo ? String(args.repo) : undefined,
            args.engine ? String(args.engine) : "auto",
          );
        case "dispatch_to_codex":
          return await this.dispatchCodex(
            String(args.prompt ?? ""),
            args.repo ? String(args.repo) : undefined,
          );
        case "dispatch_to_claude":
          return await this.dispatchClaude(
            String(args.prompt ?? ""),
            args.repo ? String(args.repo) : undefined,
          );
        default:
          return `Unknown tool: ${name}`;
      }
    } catch (err) {
      return `Tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async webSearch(query: string, limitValue: unknown): Promise<string> {
    const q = query.trim();
    if (!q) return "web_search needs a non-empty query.";
    const limit = clampInt(limitValue, 5, 1, 8);
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 FridayVoice/1.0" },
        signal: controller.signal,
      });
      const html = await res.text();
      const results: Array<{ title: string; url: string; snippet: string }> =
        [];
      const anchorRe =
        /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      let match: RegExpExecArray | null;
      while (results.length < limit && (match = anchorRe.exec(html))) {
        const title = stripHtml(match[2] ?? "");
        const href = normalizeSearchUrl(match[1] ?? "");
        const nextChunk = html.slice(
          anchorRe.lastIndex,
          Math.min(html.length, anchorRe.lastIndex + 2400),
        );
        const snippetMatch = nextChunk.match(
          /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/i,
        );
        const snippet = snippetMatch
          ? stripHtml(snippetMatch[1] ?? "").slice(0, 420)
          : "";
        if (title && href) results.push({ title, url: href, snippet });
      }
      if (results.length === 0) {
        return `No parseable search results for "${q}". Try browser_page_text on a known URL or run_shell with a more specific search command.`;
      }
      return truncate(
        results
          .map(
            (r, i) =>
              `${i + 1}. ${r.title}\n${r.url}${r.snippet ? `\n${r.snippet}` : ""}`,
          )
          .join("\n\n"),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async browserOpenUrl(url: string, app?: string): Promise<string> {
    const normalized = normalizeUrlInput(url);
    if (!normalized) return "browser_open_url needs a URL.";
    const cmd = app?.trim()
      ? ["/usr/bin/open", "-a", app.trim(), normalized]
      : ["/usr/bin/open", normalized];
    const out = await run(cmd);
    return `Opened ${normalized}${app ? ` in ${app}` : ""}.\n${out}`;
  }

  private async browserPageText(
    url: string,
    maxCharsValue: unknown,
  ): Promise<string> {
    const normalized = normalizeUrlInput(url);
    if (!normalized) return "browser_page_text needs a URL.";
    const maxChars = clampInt(maxCharsValue, 6000, 1000, 12000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const res = await fetch(normalized, {
        headers: { "User-Agent": "Mozilla/5.0 FridayVoice/1.0" },
        signal: controller.signal,
      });
      const html = await res.text();
      const title = pageTitle(html);
      const text = stripHtml(html).slice(0, maxChars);
      return truncate(
        [
          `URL: ${res.url}`,
          `Status: ${res.status} ${res.statusText}`,
          title ? `Title: ${title}` : "",
          "",
          text || "(no readable text extracted)",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async screenScreenshot(note?: string): Promise<string> {
    mkdirSync(VOICE_SCREENSHOT_DIR, { recursive: true });
    const file = path.join(VOICE_SCREENSHOT_DIR, artifactName("screen", "png"));
    const shot = await run(["/usr/sbin/screencapture", "-x", file]);
    if (shot.startsWith("[exit ")) return `Screenshot failed: ${shot}`;
    if (!existsSync(file) || statSync(file).size < 1000) {
      await run([
        "/usr/bin/open",
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
      ]);
      return screenRecordingHelp();
    }
    const dims = await run([
      "/usr/bin/sips",
      "-g",
      "pixelWidth",
      "-g",
      "pixelHeight",
      file,
    ]);
    if (dims.startsWith("[exit ") || /Warning:|Error:/i.test(dims)) {
      await run([
        "/usr/bin/open",
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
      ]);
      return `${screenRecordingHelp()}\n\nsips output:\n${dims}`;
    }
    return truncate(
      [`Screenshot saved: ${file}`, note ? `Reason: ${note}` : "", dims]
        .filter(Boolean)
        .join("\n"),
    );
  }

  private async browserScreenshot(
    url?: string,
    fullPage = false,
    browser?: string,
  ): Promise<string> {
    if (!url?.trim())
      return await this.screenScreenshot("current screen/browser view");
    mkdirSync(VOICE_SCREENSHOT_DIR, { recursive: true });
    const file = path.join(
      VOICE_SCREENSHOT_DIR,
      artifactName("browser", "png"),
    );
    const normalized = normalizeUrlInput(url);
    const args = [
      "npx",
      "--yes",
      "playwright",
      "screenshot",
      "--wait-for-timeout",
      "1000",
    ];
    const requestedBrowser = browser?.trim().toLowerCase();
    if (
      requestedBrowser &&
      /^(cr|chromium|ff|firefox|wk|webkit)$/.test(requestedBrowser)
    ) {
      args.push("--browser", requestedBrowser);
    }
    if (fullPage) args.push("--full-page");
    args.push(normalized, file);
    const shot = await run(args);
    if (shot.startsWith("[exit ")) return `Browser screenshot failed: ${shot}`;
    if (!existsSync(file) || statSync(file).size < 1000) {
      return `Browser screenshot failed: Playwright did not produce a valid image at ${file}.`;
    }
    const dims = await run([
      "/usr/bin/sips",
      "-g",
      "pixelWidth",
      "-g",
      "pixelHeight",
      file,
    ]);
    if (dims.startsWith("[exit ") || /Warning:|Error:/i.test(dims)) {
      return `Browser screenshot failed: invalid image at ${file}.\n${dims}`;
    }
    return truncate(
      [`Browser screenshot saved: ${file}`, `URL: ${normalized}`, dims].join(
        "\n",
      ),
    );
  }

  private cameraDisabledMessage(): string | null {
    if (this.cfg.cameraEnabled) return null;
    return "Camera is disabled by FRIDAY_VOICE_CAMERA=false. Set FRIDAY_VOICE_CAMERA=true in .env and restart Friday voice to enable camera vision.";
  }

  private async captureCamera(): Promise<{
    file: string;
    relPath: string;
    dims: string;
  }> {
    const disabled = this.cameraDisabledMessage();
    if (disabled) throw new Error(disabled);
    try {
      return await captureCameraFrame({
        deviceIndex: this.cfg.cameraIndex,
        width: this.cfg.cameraWidth,
        height: this.cfg.cameraHeight,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/Camera capture failed/i.test(message)) throw err;
      throw new Error(cameraPermissionHelp(message));
    }
  }

  private async cameraSnapshot(note?: string): Promise<string> {
    const disabled = this.cameraDisabledMessage();
    if (disabled) return disabled;
    try {
      const shot = await this.captureCamera();
      return truncate(
        [
          `Camera snapshot saved: ${shot.file}`,
          `Memory-relative path: ${shot.relPath}`,
          note ? `Reason: ${note}` : "",
          shot.dims,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  private async cameraSee(prompt?: string): Promise<ToolExecutionResult | string> {
    const disabled = this.cameraDisabledMessage();
    if (disabled) return disabled;
    try {
      const shot = await this.captureCamera();
      const visionPrompt =
        prompt?.trim() ||
        "Inspect this Mac camera image and answer Anmol's visual question. If a visible person is unknown, ask for their name before storing identity.";
      return {
        output: truncate(
          [
            `Camera image captured and attached for vision: ${shot.file}`,
            `Memory-relative path: ${shot.relPath}`,
            shot.dims,
            "Use visual_person_lookup if this is about recognizing a person.",
            "Use visual_person_remember only after the person's name is confirmed.",
          ].join("\n"),
        ),
        realtimeImages: [{ path: shot.file, prompt: visionPrompt }],
      };
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  private async visualPersonLookup(
    imagePath?: string,
    limitValue?: unknown,
  ): Promise<string> {
    const disabled = this.cameraDisabledMessage();
    if (disabled) return disabled;
    try {
      const image = imagePath?.trim()
        ? { file: imagePath.trim(), relPath: imagePath.trim() }
        : await this.captureCamera();
      const matches = await lookupVisualPerson({
        imagePath: image.file,
        limit: clampInt(limitValue, 5, 1, 10),
      });
      if (matches.length === 0) {
        return `No visual person memories exist yet. Image checked: ${image.relPath}`;
      }
      return truncate(
        [
          `Image checked: ${image.relPath}`,
          "Visual identity candidates:",
          ...matches.map((m, i) => {
            const confidence = `${Math.round(m.confidence * 100)}%`;
            const caution =
              m.distance <= 12
                ? "strong"
                : m.distance <= 20
                  ? "tentative"
                  : "weak";
            return [
              `${i + 1}. ${m.name} (${caution}, confidence ${confidence}, distance ${m.distance}/64)`,
              m.relationship ? `relationship: ${m.relationship}` : "",
              m.notes ? `notes: ${m.notes}` : "",
              m.description ? `description: ${m.description}` : "",
              `reference: ${m.imagePath}`,
            ]
              .filter(Boolean)
              .join("\n");
          }),
          "Do not claim identity from a tentative/weak match without asking for confirmation.",
        ].join("\n\n"),
      );
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  private async visualPersonRemember(
    name: string,
    imagePath?: string,
    relationship?: string,
    notes?: string,
    description?: string,
  ): Promise<string> {
    const disabled = this.cameraDisabledMessage();
    if (disabled) return disabled;
    const confirmedName = name.trim();
    if (!confirmedName) {
      return "visual_person_remember needs a confirmed person name.";
    }
    try {
      const image = imagePath?.trim()
        ? { file: imagePath.trim(), relPath: imagePath.trim() }
        : await this.captureCamera();
      const remembered = await rememberVisualPerson({
        name: confirmedName,
        imagePath: image.file,
        relationship,
        notes,
        description,
      });
      return truncate(
        [
          `Remembered visual identity for ${remembered.profile.name}.`,
          `Person id: ${remembered.profile.id}`,
          `Reference image: ${remembered.image.path}`,
          `Visual hash: ${remembered.image.hash}`,
          remembered.indexed
            ? "Engram index updated."
            : "Engram index update was skipped or already running.",
        ].join("\n"),
      );
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  private async mouseControl(
    actionRaw: string,
    xValue: unknown,
    yValue: unknown,
    toXValue: unknown,
    toYValue: unknown,
    durationValue: unknown,
  ): Promise<string> {
    const action = actionRaw.trim();
    if (!["check", "move", "click", "double_click", "drag"].includes(action)) {
      return "mouse_control action must be check, move, click, double_click, or drag.";
    }
    const bin = ensureMouseBinary();
    if (!bin)
      return "Mouse helper unavailable: could not compile src/voice/mouse-control.swift with /usr/bin/swiftc.";
    if (action === "check") {
      const out = await run([bin, "check"]);
      if (out.startsWith("[exit 77]")) {
        await run([
          "/usr/bin/open",
          "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        ]);
        return accessibilityHelp(out);
      }
      return out.startsWith("[exit ")
        ? `Mouse helper check failed: ${out}`
        : `Mouse helper ready: ${out}`;
    }
    const x = Number(xValue);
    const y = Number(yValue);
    if (!Number.isFinite(x) || !Number.isFinite(y))
      return "mouse_control needs finite x and y screen coordinates.";
    const args = [bin, action, String(Math.round(x)), String(Math.round(y))];
    if (action === "drag") {
      const toX = Number(toXValue);
      const toY = Number(toYValue);
      if (!Number.isFinite(toX) || !Number.isFinite(toY))
        return "drag needs to_x and to_y coordinates.";
      args.push(
        String(Math.round(toX)),
        String(Math.round(toY)),
        String(clampInt(durationValue, 260, 60, 5000)),
      );
    }
    const out = await run(args);
    if (out.startsWith("[exit 77]")) {
      await run([
        "/usr/bin/open",
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      ]);
      return accessibilityHelp(out);
    }
    return `Mouse ${action} at ${Math.round(x)},${Math.round(y)} with orange control glow.\n${out}`;
  }

  private memorySearch(query: string, limitValue: unknown): string {
    const q = query.trim();
    if (!q) return "memory_search needs a non-empty query.";
    const limit = clampInt(limitValue, 5, 1, 10);
    const results = searchMemory(q, { limit, minScore: 0.02 });
    if (results.length === 0) return `No local memory matches for "${q}".`;
    return truncate(
      results
        .map((r, i) => {
          const score = r.score.toFixed(2);
          const loc = `${r.path}:${r.startLine}`;
          const conceptTags = r.conceptTags ?? [];
          const tags = conceptTags.length ? ` [${conceptTags.join(", ")}]` : "";
          return `${i + 1}. score ${score} ${loc}${tags}\n${r.snippet.replace(/\s+/g, " ").slice(0, 700)}`;
        })
        .join("\n\n"),
    );
  }

  private async engramRecall(
    query: string,
    limitValue: unknown,
  ): Promise<string> {
    const q = query.trim();
    if (!q) return "engram_recall needs a non-empty query.";
    if (!existsSync(ENGRAM_CLI))
      return `Engram CLI is not built at ${ENGRAM_CLI}.`;
    if (!existsSync(ENGRAM_DB))
      return `Engram database is not indexed at ${ENGRAM_DB}.`;
    const limit = clampInt(limitValue, 5, 1, 8);
    const proc = Bun.spawn(
      [
        "node",
        ENGRAM_CLI,
        "recall",
        q,
        "--db",
        ENGRAM_DB,
        "--associative",
        "--reinforce",
        "--mark-used",
        "-k",
        String(limit),
        "--json",
      ],
      {
        cwd: ENGRAM_DIR,
        stdout: "pipe",
        stderr: "pipe",
        env: process.env as Record<string, string>,
      },
    );
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* process already exited */
      }
    }, 12_000);
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    if (code !== 0)
      return `Engram recall failed (exit ${code}): ${truncate((err || out).trim() || "(no output)")}`;
    try {
      const hits = JSON.parse(out) as Array<{
        content?: string;
        source?: string | null;
        why?: string | null;
      }>;
      if (!Array.isArray(hits) || hits.length === 0)
        return `No associative engram matches for "${q}".`;
      return truncate(
        hits
          .map((h, i) => {
            const source = h.source ? ` (${h.source})` : "";
            const why = h.why ? `\nwhy: ${h.why}` : "";
            return `${i + 1}. ${String(h.content ?? "")
              .replace(/\s+/g, " ")
              .slice(0, 700)}${source}${why}`;
          })
          .join("\n\n"),
      );
    } catch {
      return truncate(out.trim() || "(engram returned no output)");
    }
  }

  private async remember(
    text: string,
    topicValue?: string,
    importanceValue?: unknown,
  ): Promise<string> {
    const body = text.trim();
    if (!body) return "remember needs non-empty text.";
    const topic = (topicValue?.trim() || "voice")
      .replace(/\s+/g, " ")
      .slice(0, 80);
    const importance = clampInt(importanceValue, 3, 1, 5);
    const date = localDate();
    const dir = path.join(REPO_ROOT, "memory", "daily");
    const file = path.join(dir, `${date}.md`);
    mkdirSync(dir, { recursive: true });
    if (!existsSync(file)) {
      writeFileSync(file, `# ${date}\n`);
    }
    appendFileSync(
      file,
      [
        "",
        `## Voice memory - ${new Date().toISOString()}`,
        `- Topic: ${topic}`,
        `- Importance: ${importance}/5`,
        `- Memory: ${body.replace(/\n+/g, "\n  ")}`,
        "",
      ].join("\n"),
    );
    const indexed = await reindexIncremental();
    return `Remembered in ${file}.${indexed ? " Engram index updated." : " Engram index update was skipped or already running."}`;
  }

  private resolveRepo(
    prompt: string,
    repo?: string,
  ): { name: string; path: string; reason: string } {
    const configured = this.cfg.repos;
    const names = configured.map((r) => r.name);
    const lower = (s: string) => s.toLowerCase();

    if (repo) {
      const explicit = configured.find((r) => lower(r.name) === lower(repo));
      if (explicit)
        return {
          name: explicit.name,
          path: explicit.path,
          reason: `explicit repo "${repo}"`,
        };
    }

    const fromUrl = inferRepoFromText(prompt, names);
    if (fromUrl) {
      const match = configured.find((r) => r.name === fromUrl)!;
      return { name: match.name, path: match.path, reason: "GitHub URL" };
    }

    for (const r of configured) {
      const escaped = r.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (
        new RegExp(`(^|[^a-z0-9_-])${escaped}([^a-z0-9_-]|$)`, "i").test(prompt)
      ) {
        return {
          name: r.name,
          path: r.path,
          reason: `repo name "${r.name}" mentioned`,
        };
      }
    }

    const aliases: Array<[RegExp, string]> = [
      [/\b(api|backend|server|cron|mongo|database|payments?)\b/i, "gx-backend"],
      [
        /\b(mobile|app|expo|react native|ios|android|ota|eas)\b/i,
        "gx-client-expo",
      ],
      [
        /\b(web|website|next|landing|frontend|client next)\b/i,
        "gx-client-next",
      ],
      [/\b(admin|dashboard|internal tool)\b/i, "gx-admin-client"],
      [/\b(talent|candidate|recruit)\b/i, "gx-talent-client"],
      [/\b(slack lookup|slack-lookup)\b/i, "slack-lookup"],
      [
        /\b(built at growthx|built-at-growthx|portfolio)\b/i,
        "Built-at-GrowthX",
      ],
    ];
    for (const [pattern, name] of aliases) {
      if (!pattern.test(prompt)) continue;
      const match = configured.find((r) => r.name === name);
      if (match)
        return {
          name: match.name,
          path: match.path,
          reason: `keyword alias → ${name}`,
        };
    }

    return {
      name: "friday",
      path: REPO_ROOT,
      reason: "no repo inferred; using Friday repo",
    };
  }

  private async dispatchEngineering(
    prompt: string,
    repo?: string,
    engine = "auto",
  ): Promise<string> {
    const wantsClaude =
      engine === "claude" ||
      (engine === "auto" &&
        Boolean(this.cfg.slackBotToken && this.cfg.slackVoiceChannel));
    if (wantsClaude) return await this.dispatchClaude(prompt, repo);
    return await this.dispatchCodex(prompt, repo);
  }

  private async dispatchClaude(prompt: string, repo?: string): Promise<string> {
    const { slackBotToken, slackVoiceChannel } = this.cfg;
    if (!slackBotToken || !slackVoiceChannel) {
      return await this.dispatchCodex(prompt, repo);
    }

    const resolved = this.resolveRepo(prompt, repo);
    const cwd = resolved.path;

    // Seed (or reuse) a Slack thread so dispatch-claude.sh can report back.
    if (!this.dispatchThreadTs) {
      const seed = await this.postSlack(
        `:microphone: *Voice dispatch* — Anmol asked me (by voice) to work on \`${resolved.name}\`.`,
      );
      if (!seed)
        return "I couldn't open a Slack thread to track that — Slack post failed.";
      this.dispatchThreadTs = seed;
    }

    const proc = Bun.spawn(["/bin/bash", DISPATCH_SH, cwd, prompt], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        SLACK_BOT_TOKEN: slackBotToken,
        SLACK_CHANNEL: slackVoiceChannel,
        SLACK_THREAD_TS: this.dispatchThreadTs,
        SLACK_USER_ID: this.cfg.slackUserId ?? "",
      } as Record<string, string>,
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      return `Dispatch failed (exit ${code}): ${truncate((err || out).trim())}`;
    }
    return `Kicked off a Claude session on ${resolved.name} (${resolved.reason}) — it's running in a terminal and will report back in the Slack thread. ${out.trim()}`;
  }

  private async dispatchCodex(prompt: string, repo?: string): Promise<string> {
    const resolved = this.resolveRepo(prompt, repo);
    mkdirSync(VOICE_DISPATCH_DIR, { recursive: true });
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
    const promptPath = path.join(VOICE_DISPATCH_DIR, `${id}.prompt.md`);
    const fullPrompt = [
      `You are handling an engineering task from Friday's voice route.`,
      `Target repo: ${resolved.name}`,
      `Repo path: ${resolved.path}`,
      `Repo selection reason: ${resolved.reason}`,
      "",
      prompt,
    ].join("\n");
    writeFileSync(promptPath, fullPrompt);

    const command = [
      `cd ${shellQuote(resolved.path)}`,
      [
        "codex exec",
        "--ask-for-approval never",
        "--sandbox danger-full-access",
        "--search",
        `--cd ${shellQuote(resolved.path)}`,
        `< ${shellQuote(promptPath)}`,
      ].join(" "),
      "printf '\\n[Friday voice Codex dispatch complete]\\n'",
    ].join(" && ");

    const script = [
      `tell application "Terminal"`,
      `activate`,
      `do script ${JSON.stringify(command)}`,
      `end tell`,
    ].join("\n");
    const res = await run(["/usr/bin/osascript", "-"], script);
    if (res.startsWith("[exit ")) return `Codex dispatch failed: ${res}`;
    return `Started a local Codex session on ${resolved.name} (${resolved.reason}). It is running in Terminal.`;
  }

  /** Post to SLACK_VOICE_CHANNEL via Web API; returns the message ts (thread root). */
  private async postSlack(text: string): Promise<string | null> {
    try {
      const res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.cfg.slackBotToken}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({ channel: this.cfg.slackVoiceChannel, text }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        ts?: string;
        error?: string;
      };
      return data.ok && data.ts ? data.ts : null;
    } catch {
      return null;
    }
  }
}
