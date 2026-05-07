// Tools Friday can call from the voice route. Full Mac control, no guardrails
// (per the user's decision): arbitrary shell + AppleScript run without confirmation.
//
// `dispatch_engineering` hands heavy engineering work to local Codex by default
// and returns immediately. `dispatch_to_claude` remains available only when
// the user explicitly asks for the Slack/Claude route.

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  accessSync,
  appendFileSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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
import {
  buildCodexDispatchCommand,
  resolveEngineeringEngine,
  resolveVoiceRepo,
} from "./engineering-routing.ts";
import type { VoiceConfig } from "./config.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const DISPATCH_SH = path.join(REPO_ROOT, "bin", "dispatch-claude.sh");
const VOICE_DISPATCH_DIR = "/tmp/friday-voice/dispatch";
const VOICE_BACKGROUND_DIR = "/tmp/friday-voice/background";
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
const NODE_BIN =
  process.env.NODE_BIN ||
  ["/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node"].find((p) =>
    existsSync(p),
  ) ||
  "node";

const MAX_OUTPUT = 4000; // chars of tool output handed back to the model
function envNumber(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  const n = Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

const REALTIME_IMAGE_MAX_PX = envNumber(
  "FRIDAY_VOICE_REALTIME_IMAGE_MAX_PX",
  768,
  640,
  1600,
);
const REALTIME_IMAGE_FAST_MAX_PX = envNumber(
  "FRIDAY_VOICE_REALTIME_IMAGE_FAST_MAX_PX",
  640,
  480,
  REALTIME_IMAGE_MAX_PX,
);
const REALTIME_IMAGE_FORMAT =
  process.env.FRIDAY_VOICE_REALTIME_IMAGE_FORMAT?.toLowerCase() === "png"
    ? "png"
    : "jpeg";
const REALTIME_IMAGE_QUALITY = envNumber(
  "FRIDAY_VOICE_REALTIME_IMAGE_QUALITY",
  70,
  35,
  95,
);
const REALTIME_IMAGE_FAST_QUALITY = envNumber(
  "FRIDAY_VOICE_REALTIME_IMAGE_FAST_QUALITY",
  60,
  35,
  95,
);
interface BackgroundProcessOptions {
  label?: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  commandForDisplay: string;
}

interface BackgroundProcessStart {
  id: string;
  label: string;
  pid?: number;
  tmuxSession: string;
  launcher: "tmux" | "nohup" | "daemon";
  cwd: string;
  command: string;
  logFile: string;
  doneFile: string;
  scriptFile: string;
  metaFile: string;
  startedAt: string;
  status: "running" | "failed";
  exitCode?: number;
  endedAt?: string;
  launchOut?: string;
  launchErr?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

interface DesktopBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ToolRunnerHooks {
  currentPerception?: () => string;
  rememberCurrentSpeaker?: (args: {
    name: string;
    relationship?: string;
    notes?: string;
  }) => Promise<string>;
}

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
        "Run a shell command on the user's Mac (zsh login shell). If it finishes within the short voice grace, return stdout/stderr; otherwise keep it running as a managed background job and return the job id/log path so FRIDAY can speak immediately.",
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
      name: "run_shell_background",
      description:
        "Start a longer shell command in the background and return immediately with a job id and log path. Use for installs, tests, builds, file scans, downloads, or anything that should not delay FRIDAY speaking.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to start.",
          },
          cwd: {
            type: "string",
            description:
              "Optional working directory. Defaults to the Friday repo.",
          },
          label: {
            type: "string",
            description:
              "Short human-readable job label, e.g. 'typecheck' or 'browser task'.",
          },
        },
        required: ["command"],
      },
    },
    {
      type: "function",
      name: "background_job_status",
      description:
        "Check one background job or list recent background jobs started by FRIDAY voice. Use this when the user asks for progress on background work.",
      parameters: {
        type: "object",
        properties: {
          job_id: {
            type: "string",
            description: "Optional job id returned by run_shell_background.",
          },
          tail_lines: {
            type: "number",
            description: "How many log lines to include, 5-80.",
          },
        },
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
        "Open / launch / focus a macOS application by name (e.g. 'Visual Studio Code', 'Safari', 'Slack').",
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
      name: "app_quick_switch",
      description:
        "Open/focus a Mac app and use its quick switcher/command palette to jump to a channel, person, file, or destination. For Slack channel/person navigation this uses the visible app with Cmd+K, not Slack API tokens. Do not use this to send messages.",
      parameters: {
        type: "object",
        properties: {
          app: {
            type: "string",
            description: "Application name, e.g. Slack, Cursor, Google Chrome.",
          },
          query: {
            type: "string",
            description:
              "Destination to type into the app switcher, e.g. agent-test or tech-support.",
          },
          shortcut: {
            type: "string",
            description:
              "Optional shortcut to open the switcher. Defaults to cmd+k.",
          },
        },
        required: ["app", "query"],
      },
    },
    {
      type: "function",
      name: "app_send_text",
      description:
        "Open/focus a Mac app, jump to a destination through its quick switcher/command palette, type text, and optionally submit it. For Slack this uses the visible app with Cmd+K and keyboard typing, not Slack API tokens. Use only when the destination and exact text are explicit.",
      parameters: {
        type: "object",
        properties: {
          app: {
            type: "string",
            description: "Application name, e.g. Slack.",
          },
          destination: {
            type: "string",
            description:
              "Destination to type into the app switcher, e.g. agent-test or a person name.",
          },
          text: {
            type: "string",
            description: "Exact text to type into the destination.",
          },
          shortcut: {
            type: "string",
            description:
              "Optional shortcut to open the destination switcher. Defaults to cmd+k.",
          },
          submit: {
            type: "boolean",
            description:
              "Whether to press Return after typing. Defaults true. Set false for drafts/tests.",
          },
        },
        required: ["app", "destination", "text"],
      },
    },
    {
      type: "function",
      name: "app_search_text",
      description:
        "Open/focus any Mac app, focus its search/location/command field with a keyboard shortcut, type exact text, and optionally press Return. This ONLY searches/navigates — it does NOT start media playback. In Spotify/Apple Music/YouTube it just shows search results; to actually PLAY a result you must then click it with find_and_click. Keyboard-driven, not tied to one specific app.",
      parameters: {
        type: "object",
        properties: {
          app: {
            type: "string",
            description: "Application name, e.g. Music, Chrome, Notes.",
          },
          text: {
            type: "string",
            description: "Exact search/query text to type.",
          },
          shortcut: {
            type: "string",
            description:
              "Shortcut to focus search/location. Defaults to cmd+l; use cmd+k for command palettes.",
          },
          submit: {
            type: "boolean",
            description:
              "Whether to press Return after typing. Defaults true.",
          },
          mode: {
            type: "string",
            description:
              "Optional intent label. Cosmetic only — it does NOT cause playback. Searching is not playing.",
          },
          dry_run: {
            type: "boolean",
            description:
              "When true, validate and return the planned keyboard action without opening or typing.",
          },
          async: {
            type: "boolean",
            description:
              "When true, start the keyboard automation as a managed background job and return immediately. Defaults true for responsiveness.",
          },
        },
        required: ["app", "text"],
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
        "Open a URL in the user's browser. Use when the user asks to open a site or when a browser UI task needs a page loaded.",
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
      name: "browser_submit_text",
      description:
        "Open/focus a known browser search surface and submit text without coordinate clicking. Use for tasks like opening ChatGPT, Google, GitHub, YouTube, Bing, or DuckDuckGo and searching for a phrase.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description:
              "Site URL or domain to open, e.g. chatgpt.com, google.com, github.com.",
          },
          text: {
            type: "string",
            description: "Text/search query to submit.",
          },
          app: {
            type: "string",
            description:
              "Optional macOS browser app name, e.g. Google Chrome, Safari.",
          },
          submit: {
            type: "boolean",
            description:
              "Whether to submit immediately. Defaults true for known search URLs.",
          },
          verify: {
            type: "boolean",
            description:
              "Whether to attach a screen image after opening/submitting so Friday can verify the visible state.",
          },
        },
        required: ["url", "text"],
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
      name: "screen_brief",
      description:
        "Quickly identify the frontmost Mac app and window title without taking a screenshot. Use for simple 'what is on my screen' questions when visual details or coordinates are not needed.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
    {
      type: "function",
      name: "screen_see",
      description:
        "Capture the current Mac screen and attach it to the live Realtime conversation as vision input so Friday can inspect the visible UI. Use this before mouse_control for desktop/app tasks. Pass `app` with the app you are controlling so the screenshot shows that window and not the editor.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description:
              "Short instruction for what to inspect or which coordinates/actions to find.",
          },
          app: {
            type: "string",
            description:
              "App to bring to the front before capturing, e.g. 'Google Chrome'. Strongly recommended whenever you just opened or are controlling a specific app, so vision matches what you act on.",
          },
        },
      },
    },
    {
      type: "function",
      name: "camera_snapshot",
      description:
        `Capture one still image from the Mac camera and return its path/dimensions. ${cameraState(cfg)} Use only when the user asks Friday to look through the camera or when vision is needed.`,
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
        `Remember a confirmed person's visual identity by saving a camera image and an Engram-indexable memory card. ${cameraState(cfg)} Use only after the user or the person confirms their name.`,
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
      name: "current_perception",
      description:
        "Return Friday's latest background camera/speaker recognition cache. This is fast and does not open the camera, take a screenshot, or add response latency. Use before asking who is present or who is speaking.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
    {
      type: "function",
      name: "voice_person_remember",
      description:
        "Remember the latest detected speaker's voice under a confirmed person name. Use only after that person or the user explicitly confirms the name.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Confirmed speaker name.",
          },
          relationship: {
            type: "string",
            description: "Optional relationship/context, e.g. friend, teammate.",
          },
          notes: {
            type: "string",
            description: "Optional stable notes to remember about this speaker.",
          },
        },
        required: ["name"],
      },
    },
    {
      type: "function",
      name: "find_and_click",
      description:
        "PREFERRED way to click something on screen. Describe a UI element in plain words (e.g. 'the Compose button', 'the search box', 'the first email row') and Claude vision locates its exact pixel and clicks it. Far more reliable than guessing mouse_control coordinates. Pass `app` to focus the right window first.",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description:
              "Plain-language description of the on-screen element to click, e.g. 'the blue Send button'.",
          },
          action: {
            type: "string",
            enum: ["click", "double_click", "move"],
            description: "What to do at the located element. Defaults to click.",
          },
          app: {
            type: "string",
            description:
              "App to bring to the front before locating, e.g. 'Google Chrome'. Strongly recommended.",
          },
        },
        required: ["target"],
      },
    },
    {
      type: "function",
      name: "mouse_control",
      description:
        "Low-level mouse move/click/drag using exact screen coordinates. Prefer find_and_click for clicking UI elements; use this only when you already know precise coordinates or need drag. It flashes an orange ring while controlling the pointer.",
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
              "Start/target X coordinate in macOS display coordinates from the top-left. Use the screen_see coordinate scale, not raw Retina screenshot pixels.",
          },
          y: {
            type: "number",
            description:
              "Start/target Y coordinate in macOS display coordinates from the top-left. Use the screen_see coordinate scale, not raw Retina screenshot pixels.",
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
        "Search Friday's local memory corpus for past conversations, preferences, project notes, and remembered facts. Use for questions about what the user said before or how he likes things done.",
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
        "Store a durable memory note, preference, decision, or lesson so Friday can recall it later. Use when the user explicitly says to remember something or states a stable preference.",
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
        "Preferred tool for substantial engineering work. It infers the target repo from the prompt, GitHub URL, PR URL, or keywords; then starts a local Codex session and returns immediately. Use this instead of asking the user which repo unless the task is truly ambiguous and dangerous.",
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
              "auto uses local Codex. Use claude only when the user explicitly asks for Slack/Claude/cloud dispatch.",
          },
          dry_run: {
            type: "boolean",
            description:
              "Readiness/probe mode only: prepare the local Codex command without launching Terminal.",
          },
        },
        required: ["prompt"],
      },
    },
    {
      type: "function",
      name: "dispatch_to_codex",
      description:
        "Start a local Codex engineering session in Terminal and return immediately. Use when Slack dispatch is unavailable, when the user says Codex, or for local repo work that should not depend on Slack.",
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
        "Hand a substantial engineering task to a Claude/Slack worker in the background. It returns immediately and reports back in Slack. Use only when the user explicitly asks for Slack, Claude, or cloud dispatch.",
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

function jobId(label?: string): string {
  const safe = (label?.trim() || "job")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${safe || "job"}`;
}

function tmuxBin(): string {
  return existsSync("/opt/homebrew/bin/tmux") ? "/opt/homebrew/bin/tmux" : "tmux";
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

function browserSubmitUrl(
  rawUrl: string,
  query: string,
  submit: boolean,
): { url: string; label: string; verifyDelayMs: number } | null {
  try {
    const url = new URL(normalizeUrlInput(rawUrl));
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    const setQ = (param = "q") => {
      url.searchParams.set(param, query);
      return url.href;
    };

    if (host === "chatgpt.com" || host.endsWith(".chatgpt.com")) {
      url.protocol = "https:";
      url.hostname = "chatgpt.com";
      url.pathname = "/";
      url.search = "";
      if (submit) url.searchParams.set("q", query);
      url.searchParams.set("model", "auto");
      return {
        url: url.href,
        label: "ChatGPT",
        verifyDelayMs: submit ? 3200 : 1800,
      };
    }
    if (host === "google.com" || host.endsWith(".google.com")) {
      url.protocol = "https:";
      url.hostname = "www.google.com";
      url.pathname = "/search";
      url.search = "";
      return { url: setQ(), label: "Google", verifyDelayMs: 1800 };
    }
    if (host === "duckduckgo.com" || host.endsWith(".duckduckgo.com")) {
      url.protocol = "https:";
      url.hostname = "duckduckgo.com";
      url.pathname = "/";
      url.search = "";
      return { url: setQ(), label: "DuckDuckGo", verifyDelayMs: 1800 };
    }
    if (host === "bing.com" || host.endsWith(".bing.com")) {
      url.protocol = "https:";
      url.hostname = "www.bing.com";
      url.pathname = "/search";
      url.search = "";
      return { url: setQ(), label: "Bing", verifyDelayMs: 1800 };
    }
    if (host === "youtube.com" || host.endsWith(".youtube.com")) {
      url.protocol = "https:";
      url.hostname = "www.youtube.com";
      url.pathname = "/results";
      url.search = "";
      return {
        url: setQ("search_query"),
        label: "YouTube",
        verifyDelayMs: 2200,
      };
    }
    if (host === "github.com" || host.endsWith(".github.com")) {
      url.protocol = "https:";
      url.hostname = "github.com";
      url.pathname = "/search";
      url.search = "";
      return { url: setQ(), label: "GitHub", verifyDelayMs: 2200 };
    }
    if (host === "npmjs.com" || host.endsWith(".npmjs.com")) {
      url.protocol = "https:";
      url.hostname = "www.npmjs.com";
      url.pathname = "/search";
      url.search = "";
      return { url: setQ(), label: "npm", verifyDelayMs: 2200 };
    }
    return null;
  } catch {
    return null;
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

function parseDesktopBounds(output: string): DesktopBounds | undefined {
  const nums = output.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  if (nums.length < 4) return undefined;
  const [left, top, right, bottom] = nums;
  const width = right - left;
  const height = bottom - top;
  if (
    !Number.isFinite(left) ||
    !Number.isFinite(top) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return undefined;
  }
  return { x: left, y: top, width, height };
}

async function run(
  cmd: string[],
  input?: string,
  opts: { timeoutMs?: number; cwd?: string } = {},
): Promise<string> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd ?? REPO_ROOT,
    stdin: input != null ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env as Record<string, string>,
  });
  let timedOut = false;
  const timer =
    opts.timeoutMs && opts.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          try {
            proc.kill();
          } catch {
            /* ignore */
          }
        }, opts.timeoutMs)
      : null;
  if (input != null && proc.stdin) {
    proc.stdin.write(input);
    proc.stdin.end();
  }
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const body = [out.trim(), err.trim()].filter(Boolean).join("\n");
    if (timedOut)
      return truncate(
        `[timeout ${opts.timeoutMs}ms] ${body || "(no output before timeout)"}`,
      );
    if (code !== 0) return truncate(`[exit ${code}] ${body || "(no output)"}`);
    return truncate(body || "(ok, no output)");
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  private hooks: ToolRunnerHooks;
  private dispatchThreadTs: string | null = null;

  constructor(cfg: VoiceConfig, hooks: ToolRunnerHooks = {}) {
    this.cfg = cfg;
    this.hooks = hooks;
  }

  async exec(name: string, args: Record<string, unknown>): Promise<ToolRunResult> {
    try {
      switch (name) {
        case "run_shell":
          return await this.runShellSmart(String(args.command ?? ""));
        case "run_shell_background":
          return this.runShellBackground(
            String(args.command ?? ""),
            args.cwd ? String(args.cwd) : undefined,
            args.label ? String(args.label) : undefined,
          );
        case "background_job_status":
          return this.backgroundJobStatus(
            args.job_id ? String(args.job_id) : undefined,
            args.tail_lines,
          );
        case "run_applescript":
          return await run(
            ["/usr/bin/osascript", "-"],
            String(args.script ?? ""),
          );
        case "open_app":
          return await this.openApp(String(args.name ?? ""));
        case "app_quick_switch":
          return await this.appQuickSwitch(
            String(args.app ?? ""),
            String(args.query ?? ""),
            args.shortcut ? String(args.shortcut) : undefined,
          );
        case "app_send_text":
          return await this.appSendText(
            String(args.app ?? ""),
            String(args.destination ?? ""),
            String(args.text ?? ""),
            args.shortcut ? String(args.shortcut) : undefined,
            args.submit,
            args.dry_run,
          );
        case "app_search_text":
          return await this.appSearchText(
            String(args.app ?? ""),
            String(args.text ?? ""),
            args.shortcut ? String(args.shortcut) : undefined,
            args.submit,
            args.mode ? String(args.mode) : undefined,
            args.dry_run,
            args.async,
          );
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
        case "browser_submit_text":
          return await this.browserSubmitText(
            String(args.url ?? ""),
            String(args.text ?? ""),
            args.app ? String(args.app) : undefined,
            args.submit,
            args.verify,
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
        case "screen_brief":
          return await this.screenBrief();
        case "screen_see":
          return await this.screenSee(
            args.prompt ? String(args.prompt) : undefined,
            args.app ? String(args.app) : undefined,
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
        case "current_perception":
          return this.currentPerception();
        case "voice_person_remember":
          return await this.voicePersonRemember(
            String(args.name ?? ""),
            args.relationship ? String(args.relationship) : undefined,
            args.notes ? String(args.notes) : undefined,
          );
        case "find_and_click":
          return await this.findAndClick(
            args.target ? String(args.target) : "",
            args.action ? String(args.action) : undefined,
            args.app ? String(args.app) : undefined,
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
            args.dry_run === true || args.dry_run === "true",
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

  private startBackgroundProcess(
    opts: BackgroundProcessOptions,
  ): BackgroundProcessStart {
    mkdirSync(VOICE_BACKGROUND_DIR, { recursive: true });
    const id = jobId(opts.label);
    const logFile = path.join(VOICE_BACKGROUND_DIR, `${id}.log`);
    const metaFile = path.join(VOICE_BACKGROUND_DIR, `${id}.json`);
    const doneFile = path.join(VOICE_BACKGROUND_DIR, `${id}.done.json`);
    const scriptFile = path.join(VOICE_BACKGROUND_DIR, `${id}.zsh`);
    const cwd = opts.cwd?.trim() || REPO_ROOT;
    const startedAt = new Date().toISOString();
    appendFileSync(
      logFile,
      [
        `[friday background job ${id}]`,
        `started: ${startedAt}`,
        `cwd: ${cwd}`,
        `command: ${opts.commandForDisplay}`,
        "",
      ].join("\n"),
    );
    const commandLine = opts.args.map(shellQuote).join(" ");
    const envExports = opts.env
      ? Object.entries(opts.env)
          .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
          .map(([key, value]) => `export ${key}=${shellQuote(String(value))}`)
      : [];
    const wrapper = [
      "set +e",
      ...envExports,
      `printf '[friday background job ${id} wrapper pid %s]\\n' "$$" >> ${shellQuote(logFile)}`,
      `${commandLine} >> ${shellQuote(logFile)} 2>&1`,
      "code=$?",
      'ended_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
      `printf '\\n[friday background job ${id} exited %s at %s]\\n' "$code" "$ended_at" >> ${shellQuote(logFile)}`,
      'job_status="failed"',
      '[ "$code" -eq 0 ] && job_status="complete"',
      `printf '{"status":"%s","exitCode":%s,"endedAt":"%s"}\\n' "$job_status" "$code" "$ended_at" > ${shellQuote(doneFile)}`,
      "done_code=$?",
      `printf '[friday background job ${id} wrote done marker %s]\\n' "$done_code" >> ${shellQuote(logFile)}`,
      'exit "$code"',
    ].join("\n");
    writeFileSync(scriptFile, `${wrapper}\n`);
    chmodSync(scriptFile, 0o700);
    const tmuxSession = `friday-bg-${id
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120)}`;
    let pid: number | undefined;
    let launcherKind: "tmux" | "nohup" = "tmux";
    const tmuxCommand = `${shellQuote("/bin/zsh")} ${shellQuote(scriptFile)}`;
    const tmuxLaunch = Bun.spawnSync(
      [tmuxBin(), "new-session", "-d", "-s", tmuxSession, "-c", cwd, tmuxCommand],
      {
        cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: opts.env ?? (process.env as Record<string, string>),
      },
    );
    const tmuxErr = Buffer.from(tmuxLaunch.stderr).toString().trim();
    const tmuxOut = Buffer.from(tmuxLaunch.stdout).toString().trim();
    if (tmuxLaunch.exitCode !== 0) {
      appendFileSync(
        logFile,
        `[tmux launch failed ${tmuxLaunch.exitCode}] ${tmuxErr || tmuxOut || "(no output)"}\n`,
      );
      launcherKind = "nohup";
    }

    if (launcherKind === "nohup") {
      const launcher = [
        "nohup",
        "/bin/zsh",
        shellQuote(scriptFile),
        `>> ${shellQuote(logFile)} 2>&1 &`,
        "echo $!",
      ].join(" ");
      const launched = Bun.spawnSync(["/bin/zsh", "-lc", launcher], {
        cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: opts.env ?? (process.env as Record<string, string>),
      });
      const launchOut = Buffer.from(launched.stdout).toString().trim();
      const launchErr = Buffer.from(launched.stderr).toString().trim();
      pid = Number(launchOut.split(/\s+/)[0]);
      if (launched.exitCode !== 0 || !Number.isFinite(pid) || pid <= 0) {
        const failed = {
          id,
          label: opts.label?.trim() || "background job",
          cwd,
          command: opts.commandForDisplay,
          logFile,
          doneFile,
          scriptFile,
          tmuxSession,
          launcher: launcherKind,
          startedAt,
          status: "failed",
          exitCode: launched.exitCode,
          endedAt: new Date().toISOString(),
        };
        writeFileSync(metaFile, JSON.stringify(failed, null, 2));
        return {
          ...failed,
          label: failed.label,
          launcher: failed.launcher,
          status: "failed",
          metaFile,
          launchOut,
          launchErr,
        };
      }
    }
    const meta: BackgroundProcessStart = {
      id,
      label: opts.label?.trim() || "background job",
      ...(pid ? { pid } : {}),
      tmuxSession,
      launcher: launcherKind,
      cwd,
      command: opts.commandForDisplay,
      logFile,
      doneFile,
      scriptFile,
      metaFile,
      startedAt,
      status: "running",
    };
    const { metaFile: _metaFile, ...storedMeta } = meta;
    writeFileSync(metaFile, JSON.stringify(storedMeta, null, 2));
    return meta;
  }

  private backgroundStartMessage(start: BackgroundProcessStart): string {
    if (start.status === "failed") {
      return truncate(
        [
          `Failed to start background job ${start.id}.`,
          start.launchErr ? `stderr: ${start.launchErr}` : "",
          start.launchOut ? `stdout: ${start.launchOut}` : "",
          `Log: ${start.logFile}`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
    return [
      `Started background job ${start.id}.`,
      start.pid ? `PID: ${start.pid}` : `Session: ${start.tmuxSession}`,
      `Log: ${start.logFile}`,
      `Working directory: ${start.cwd}`,
    ].join("\n");
  }

  private startDaemonAppleScriptJob(opts: {
    label: string;
    commandForDisplay: string;
    script: string;
    timeoutMs?: number;
  }): BackgroundProcessStart {
    mkdirSync(VOICE_BACKGROUND_DIR, { recursive: true });
    const id = jobId(opts.label);
    const logFile = path.join(VOICE_BACKGROUND_DIR, `${id}.log`);
    const metaFile = path.join(VOICE_BACKGROUND_DIR, `${id}.json`);
    const doneFile = path.join(VOICE_BACKGROUND_DIR, `${id}.done.json`);
    const scriptFile = path.join(VOICE_BACKGROUND_DIR, `${id}.applescript`);
    const cwd = REPO_ROOT;
    const startedAt = new Date().toISOString();
    writeFileSync(scriptFile, `${opts.script}\n`);
    appendFileSync(
      logFile,
      [
        `[friday background job ${id}]`,
        `started: ${startedAt}`,
        `cwd: ${cwd}`,
        `command: ${opts.commandForDisplay}`,
        "launcher: daemon",
        "",
      ].join("\n"),
    );
    const start: BackgroundProcessStart = {
      id,
      label: opts.label,
      pid: process.pid,
      tmuxSession: "",
      launcher: "daemon",
      cwd,
      command: opts.commandForDisplay,
      logFile,
      doneFile,
      scriptFile,
      metaFile,
      startedAt,
      status: "running",
    };
    const { metaFile: _metaFile, ...storedMeta } = start;
    writeFileSync(metaFile, JSON.stringify(storedMeta, null, 2));
    void (async () => {
      appendFileSync(
        logFile,
        `[friday background job ${id} daemon pid ${process.pid}]\n`,
      );
      const out = await run(["/usr/bin/osascript", "-"], opts.script, {
        timeoutMs: opts.timeoutMs ?? 5_000,
      });
      if (out.trim()) appendFileSync(logFile, `${out.trim()}\n`);
      const exitCode = out.startsWith("[timeout ")
        ? 124
        : Number(out.match(/^\[exit\s+(\d+)\]/i)?.[1] ?? 0);
      const endedAt = new Date().toISOString();
      const status = exitCode === 0 ? "complete" : "failed";
      appendFileSync(
        logFile,
        `\n[friday background job ${id} exited ${exitCode} at ${endedAt}]\n`,
      );
      writeFileSync(
        doneFile,
        JSON.stringify({ status, exitCode, endedAt }, null, 2),
      );
      try {
        writeFileSync(
          metaFile,
          JSON.stringify({ ...storedMeta, status, exitCode, endedAt }, null, 2),
        );
      } catch {
        /* best effort */
      }
    })();
    return start;
  }

  private spawnBackgroundProcess(opts: BackgroundProcessOptions): string {
    return this.backgroundStartMessage(this.startBackgroundProcess(opts));
  }

  private cleanBackgroundCommandOutput(
    logText: string,
    start: BackgroundProcessStart,
  ): string {
    const skipPrefixes = [
      `[friday background job ${start.id}]`,
      `started:`,
      `cwd:`,
      `command:`,
      `[friday background job ${start.id} wrapper pid`,
      `[friday background job ${start.id} exited`,
      `[friday background job ${start.id} wrote done marker`,
      `[tmux launch failed`,
    ];
    return logText
      .split(/\r?\n/)
      .filter((line) => !skipPrefixes.some((prefix) => line.startsWith(prefix)))
      .join("\n")
      .trim();
  }

  private completedBackgroundOutput(start: BackgroundProcessStart): string {
    let exitCode = 0;
    try {
      const done = JSON.parse(readFileSync(start.doneFile, "utf8")) as {
        exitCode?: number;
      };
      exitCode = Number.isFinite(done.exitCode) ? Number(done.exitCode) : 0;
    } catch {
      /* best effort */
    }
    const body = existsSync(start.logFile)
      ? this.cleanBackgroundCommandOutput(readFileSync(start.logFile, "utf8"), start)
      : "";
    if (exitCode !== 0)
      return truncate(`[exit ${exitCode}] ${body || "(no output)"}`);
    return truncate(body || "(ok, no output)");
  }

  private async runShellSmart(command: string): Promise<string> {
    const cmd = command.trim();
    if (!cmd) return "run_shell needs a non-empty command.";
    const start = this.startBackgroundProcess({
      label: "shell",
      args: ["/bin/zsh", "-lc", cmd],
      cwd: REPO_ROOT,
      commandForDisplay: cmd,
    });
    if (start.status === "failed") return this.backgroundStartMessage(start);
    if (this.shouldBackgroundImmediately(cmd)) {
      return this.backgroundStartMessage(start);
    }

    const fastWaitMs = Math.max(80, this.cfg.runShellFastWaitMs);
    const deadline = Date.now() + fastWaitMs;
    while (Date.now() < deadline) {
      if (existsSync(start.doneFile)) return this.completedBackgroundOutput(start);
      await sleep(80);
    }

    return truncate(
      [
        `Still running after ${Math.round(fastWaitMs / 100) / 10}s, so I kept it in the background.`,
        this.backgroundStartMessage(start),
        "Use background_job_status with this job id for progress.",
      ].join("\n"),
    );
  }

  private shouldBackgroundImmediately(command: string): boolean {
    return /\b(sleep|codex|claude)\b|(?:^|[;&|]\s*)(bun|npm|pnpm|yarn)\s+(run\s+)?(dev|start|build|test|install|add|ci)\b|(?:^|[;&|]\s*)(make|xcodebuild|pytest|cargo|go|gradle|mvn)\b/i.test(
      command,
    );
  }

  private async openApp(name: string): Promise<string> {
    const app = name.trim();
    if (!app) return "open_app needs an application name.";
    const out = await run(["/usr/bin/open", "-a", app]);
    return out.startsWith("[exit ")
      ? `Open app failed for ${app}: ${out}`
      : `Opened ${app}.\n${out}`;
  }

  // Bring an app to the front of the CURRENT Space and raise its window, so a
  // following screenshot shows what Friday is controlling instead of whatever
  // editor/terminal happened to be frontmost. Best-effort; never throws.
  private async focusApp(name: string): Promise<void> {
    const app = name.trim();
    if (!app) return;
    const script = [
      `tell application ${JSON.stringify(app)} to activate`,
      "delay 0.35",
      `tell application "System Events"`,
      `  try`,
      `    tell process ${JSON.stringify(app)}`,
      `      set frontmost to true`,
      `      try`,
      `        perform action "AXRaise" of front window`,
      `      end try`,
      `    end tell`,
      `  end try`,
      `end tell`,
    ].join("\n");
    await run(["/usr/bin/osascript", "-"], script, { timeoutMs: 3_000 });
  }

  private async appQuickSwitch(
    appValue: string,
    queryValue: string,
    shortcutValue?: string,
  ): Promise<string> {
    const app = appValue.trim();
    const query = queryValue.replace(/^#+/, "").trim();
    if (!app) return "app_quick_switch needs an app name.";
    if (!query) return "app_quick_switch needs a destination query.";
    const opened = await this.openApp(app);
    if (/^Open app failed/i.test(opened)) return opened;
    const shortcutScript = comboToAppleScript(shortcutValue?.trim() || "cmd+k");
    const script = [
      `tell application ${JSON.stringify(app)} to activate`,
      "delay 0.6",
      shortcutScript,
      "delay 0.25",
      `tell application "System Events" to keystroke ${JSON.stringify(query)}`,
      "delay 0.15",
      `tell application "System Events" to key code 36`,
    ].join("\n");
    const out = await run(["/usr/bin/osascript", "-"], script, {
      timeoutMs: 4_000,
    });
    return out.startsWith("[exit ") || out.startsWith("[timeout ")
      ? `App quick switch failed for ${app} to ${query}: ${out}`
      : `Quick switched ${app} to ${query} using ${shortcutValue?.trim() || "cmd+k"}.\n${out}`;
  }

  private async appSendText(
    appValue: string,
    destinationValue: string,
    textValue: string,
    shortcutValue?: string,
    submitValue: unknown = true,
    dryRunValue: unknown = false,
  ): Promise<string> {
    const app = appValue.trim();
    const destination = destinationValue.replace(/^#+/, "").trim();
    const text = textValue.trim();
    const shortcut = shortcutValue?.trim() || "cmd+k";
    const submit = submitValue !== false;
    const dryRun = dryRunValue === true || dryRunValue === "true";
    if (!app) return "app_send_text needs an app name.";
    if (!destination) return "app_send_text needs a destination.";
    if (!text) return "app_send_text needs text to send.";
    if (dryRun) {
      return submit
        ? `Sent app text dry run in ${app} to ${destination}: ${text}`
        : `Prepared app text dry run in ${app} to ${destination} without sending: ${text}`;
    }
    const opened = await this.openApp(app);
    if (/^Open app failed/i.test(opened)) return opened;
    const script = [
      `tell application ${JSON.stringify(app)} to activate`,
      "delay 0.6",
      comboToAppleScript(shortcut),
      "delay 0.25",
      `tell application "System Events" to keystroke ${JSON.stringify(destination)}`,
      "delay 0.15",
      `tell application "System Events" to key code 36`,
      "delay 0.55",
      `tell application "System Events" to keystroke ${JSON.stringify(text)}`,
      ...(submit ? ["delay 0.12", `tell application "System Events" to key code 36`] : []),
    ].join("\n");
    const out = await run(["/usr/bin/osascript", "-"], script, {
      timeoutMs: 5_000,
    });
    if (out.startsWith("[exit ") || out.startsWith("[timeout ")) {
      return `App send text failed for ${app} to ${destination}: ${out}`;
    }
    return submit
      ? `Sent app text in ${app} to ${destination}: ${text}\n${out}`
      : `Prepared app text in ${app} to ${destination} without sending: ${text}\n${out}`;
  }

  private async appSearchText(
    appValue: string,
    textValue: string,
    shortcutValue?: string,
    submitValue: unknown = true,
    modeValue?: string,
    dryRunValue: unknown = false,
    asyncValue: unknown = true,
  ): Promise<string> {
    const app = appValue.trim();
    const text = textValue.trim();
    const shortcut = shortcutValue?.trim() || "cmd+l";
    const submit = submitValue !== false;
    const dryRun = dryRunValue === true || dryRunValue === "true";
    const asyncMode = asyncValue !== false && asyncValue !== "false";
    const mode = /play/i.test(modeValue ?? "") ? "play" : "search";
    if (!app) return "app_search_text needs an app name.";
    if (!text) return "app_search_text needs text to type.";
    if (dryRun) {
      return submit
        ? `App ${mode} text submitted dry run in ${app}: ${text} using ${shortcut}.`
        : `App ${mode} text typed dry run in ${app} without submitting: ${text} using ${shortcut}.`;
    }
    const script = [
      `tell application ${JSON.stringify(app)} to activate`,
      "delay 0.6",
      comboToAppleScript(shortcut),
      "delay 0.25",
      `tell application "System Events" to key code 0 using {command down}`,
      "delay 0.08",
      `tell application "System Events" to keystroke ${JSON.stringify(text)}`,
      ...(submit ? ["delay 0.15", `tell application "System Events" to key code 36`] : []),
    ].join("\n");
    if (asyncMode) {
      const start = this.startDaemonAppleScriptJob({
        label: `app-${mode}`,
        commandForDisplay: `app ${mode} in ${app}: ${text}`,
        script,
        timeoutMs: 5_000,
      });
      return truncate(
        [
          submit
            ? `App ${mode} text submitted in ${app}: ${text} using ${shortcut}.`
            : `App ${mode} text typed in ${app} without submitting: ${text} using ${shortcut}.`,
          this.backgroundStartMessage(start),
        ].join("\n"),
      );
    }
    const opened = await this.openApp(app);
    if (/^Open app failed/i.test(opened)) return opened;
    const out = await run(["/usr/bin/osascript", "-"], script, {
      timeoutMs: 5_000,
    });
    if (out.startsWith("[exit ") || out.startsWith("[timeout ")) {
      return `App ${mode} text failed in ${app}: ${out}`;
    }
    return submit
      ? `App ${mode} text submitted in ${app}: ${text} using ${shortcut}.\n${out}`
      : `App ${mode} text typed in ${app} without submitting: ${text} using ${shortcut}.\n${out}`;
  }

  private runShellBackground(
    command: string,
    cwd?: string,
    label?: string,
  ): string {
    const cmd = command.trim();
    if (!cmd) return "run_shell_background needs a non-empty command.";
    return this.spawnBackgroundProcess({
      label: label || "shell",
      args: ["/bin/zsh", "-lc", cmd],
      cwd: cwd?.trim() || REPO_ROOT,
      commandForDisplay: cmd,
    });
  }

  private backgroundJobStatus(jobIdValue?: string, tailLinesValue?: unknown): string {
    if (!existsSync(VOICE_BACKGROUND_DIR)) {
      return "No background jobs have been started yet.";
    }
    const tailLines = clampInt(tailLinesValue, 20, 5, 80);
    const files = readdirSync(VOICE_BACKGROUND_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => path.join(VOICE_BACKGROUND_DIR, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (files.length === 0) return "No background jobs have been started yet.";

    const wanted = jobIdValue?.trim();
    const metaFile = wanted
      ? files.find((f) => path.basename(f, ".json") === wanted)
      : undefined;
    if (wanted && !metaFile) return `No background job found with id ${wanted}.`;

    const describe = (file: string): string => {
      try {
        const meta = JSON.parse(readFileSync(file, "utf8")) as {
          id?: string;
          label?: string;
          pid?: number;
          status?: string;
          exitCode?: number;
          startedAt?: string;
          endedAt?: string;
          logFile?: string;
          doneFile?: string;
          tmuxSession?: string;
          launcher?: string;
          cwd?: string;
        };
        const doneFile = meta.doneFile || `${file.replace(/\.json$/, "")}.done.json`;
        if (existsSync(doneFile)) {
          try {
            const done = JSON.parse(readFileSync(doneFile, "utf8")) as {
              status?: string;
              exitCode?: number;
              endedAt?: string;
            };
            Object.assign(meta, done);
          } catch {
            /* best effort */
          }
        } else if (meta.logFile && existsSync(meta.logFile)) {
          const logText = readFileSync(meta.logFile, "utf8");
          const matches = Array.from(
            logText.matchAll(
              /\[friday background job .* exited (\d+) at ([^\]]+)\]/g,
            ),
          );
          const last = matches.at(-1);
          if (last) {
            const exitCode = Number(last[1]);
            Object.assign(meta, {
              status: exitCode === 0 ? "complete" : "failed",
              exitCode,
              endedAt: last[2],
            });
          }
        }
        const alive =
          meta.status === "running" &&
          (typeof meta.pid === "number"
            ? this.pidAlive(meta.pid)
            : meta.tmuxSession
              ? this.tmuxAlive(meta.tmuxSession)
              : false)
            ? "alive"
            : "not running";
        const status =
          meta.status === "running" && alive === "not running"
            ? "lost"
            : (meta.status ?? "unknown");
        if (status !== meta.status || existsSync(doneFile)) {
          try {
            const endedAt =
              meta.endedAt ??
              (status !== "running" ? new Date().toISOString() : undefined);
            writeFileSync(
              file,
              JSON.stringify({ ...meta, status, ...(endedAt ? { endedAt } : {}) }, null, 2),
            );
          } catch {
            /* best effort */
          }
        }
        return [
          `${meta.id ?? path.basename(file, ".json")} — ${status} (${alive})`,
          meta.label ? `label: ${meta.label}` : "",
          meta.launcher ? `launcher: ${meta.launcher}` : "",
          meta.tmuxSession ? `session: ${meta.tmuxSession}` : "",
          meta.pid ? `pid: ${meta.pid}` : "",
          typeof meta.exitCode === "number" ? `exit: ${meta.exitCode}` : "",
          meta.startedAt ? `started: ${meta.startedAt}` : "",
          meta.endedAt ? `ended: ${meta.endedAt}` : "",
          meta.cwd ? `cwd: ${meta.cwd}` : "",
          meta.logFile ? `log: ${meta.logFile}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      } catch (err) {
        return `${path.basename(file, ".json")} — metadata unreadable: ${err instanceof Error ? err.message : String(err)}`;
      }
    };

    if (!metaFile) {
      return truncate(
        ["Recent background jobs:", ...files.slice(0, 6).map(describe)].join(
          "\n\n",
        ),
      );
    }

    const summary = describe(metaFile);
    let tail = "";
    try {
      const meta = JSON.parse(readFileSync(metaFile, "utf8")) as {
        logFile?: string;
      };
      if (meta.logFile && existsSync(meta.logFile)) {
        const lines = readFileSync(meta.logFile, "utf8")
          .split(/\r?\n/)
          .slice(-tailLines)
          .join("\n");
        tail = `\n\nLast ${tailLines} log lines:\n${lines}`;
      }
    } catch {
      /* best effort */
    }
    return truncate(`${summary}${tail}`);
  }

  private pidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private tmuxAlive(session: string): boolean {
    const res = Bun.spawnSync([tmuxBin(), "has-session", "-t", session], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return res.exitCode === 0;
  }

  private async webSearch(query: string, limitValue: unknown): Promise<string> {
    const q = query.trim();
    if (!q) return "web_search needs a non-empty query.";
    const limit = clampInt(limitValue, 5, 1, 8);
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
    const controller = new AbortController();
    const timeoutMs = Math.max(1000, this.cfg.webFetchTimeoutMs);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError")
        return `web_search timed out after ${timeoutMs}ms. Say that the live search is slow, or use browser_open_url / run_shell_background for a deeper search.`;
      return `web_search failed: ${err instanceof Error ? err.message : String(err)}`;
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

  private async browserSubmitText(
    url: string,
    text: string,
    app?: string,
    submitValue: unknown = true,
    verifyValue: unknown = true,
  ): Promise<ToolExecutionResult | string> {
    const normalized = normalizeUrlInput(url);
    const query = text.trim();
    if (!normalized) return "browser_submit_text needs a URL.";
    if (!query) return "browser_submit_text needs text to submit.";

    const target = browserSubmitUrl(normalized, query, submitValue !== false);
    if (!target) {
      return `browser_submit_text does not know a reliable non-coordinate search URL for ${normalized}. Use browser_open_url followed by screen_see for visual control.`;
    }

    const openOut = await this.browserOpenUrl(target.url, app);
    if (verifyValue === false) {
      return truncate(
        [
          `Submitted browser text to ${target.label}: ${query}`,
          `URL: ${target.url}`,
          openOut,
        ].join("\n"),
      );
    }

    await sleep(target.verifyDelayMs);
    try {
      const shot = await this.captureScreen();
      const image = await this.realtimeImageCopy(shot.file, "screen");
      return {
        output: truncate(
          [
            `Submitted browser text to ${target.label}: ${query}`,
            `URL: ${target.url}`,
            `Screen captured for verification: ${shot.file}`,
            shot.dims,
            image.resized
              ? `Realtime vision attachment: ${image.file}\n${image.dims}`
              : "",
            openOut,
          ]
            .filter(Boolean)
            .join("\n"),
        ),
        realtimeImages: [
          {
            path: image.file,
            prompt:
              "Verify the browser search/chat submission state. Say whether the requested query, results, login prompt, or blocker is visible.",
          },
        ],
      };
    } catch (err) {
      return truncate(
        [
          `Submitted browser text to ${target.label}: ${query}`,
          `URL: ${target.url}`,
          `Verification screenshot failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
          openOut,
        ].join("\n"),
      );
    }
  }

  private async browserPageText(
    url: string,
    maxCharsValue: unknown,
  ): Promise<string> {
    const normalized = normalizeUrlInput(url);
    if (!normalized) return "browser_page_text needs a URL.";
    const maxChars = clampInt(maxCharsValue, 6000, 1000, 12000);
    const controller = new AbortController();
    const timeoutMs = Math.max(1000, this.cfg.webFetchTimeoutMs);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError")
        return `browser_page_text timed out after ${timeoutMs}ms for ${normalized}. Say the page is slow, or open it in the browser and use screen_see.`;
      return `browser_page_text failed for ${normalized}: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      clearTimeout(timer);
    }
  }

  private async captureScreen(): Promise<{ file: string; dims: string }> {
    mkdirSync(VOICE_SCREENSHOT_DIR, { recursive: true });
    try {
      chmodSync(VOICE_SCREENSHOT_DIR, 0o777);
    } catch {
      /* best effort; accessSync below gives the actionable error */
    }
    try {
      accessSync(VOICE_SCREENSHOT_DIR, constants.W_OK);
    } catch {
      throw new Error(
        `Screen screenshot failed because ${VOICE_SCREENSHOT_DIR} is not writable by the Friday daemon. Run: sudo chown -R "$USER":wheel /tmp/friday-voice && chmod -R u+rwX,go+rwX /tmp/friday-voice`,
      );
    }
    const file = path.join(VOICE_SCREENSHOT_DIR, artifactName("screen", "png"));
    const shot = await run(["/usr/sbin/screencapture", "-x", file]);
    if (shot.startsWith("[exit ")) throw new Error(`Screenshot failed: ${shot}`);
    for (let i = 0; i < 10; i++) {
      if (existsSync(file) && statSync(file).size >= 1000) break;
      await sleep(120);
    }
    if (!existsSync(file) || statSync(file).size < 1000) {
      await run([
        "/usr/bin/open",
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
      ]);
      throw new Error(screenRecordingHelp());
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
      throw new Error(`${screenRecordingHelp()}\n\nsips output:\n${dims}`);
    }
    return { file, dims };
  }

  private async realtimeImageCopy(
    file: string,
    label: string,
    opts: { maxPx?: number; quality?: number } = {},
  ): Promise<{ file: string; dims: string; resized: boolean }> {
    const ext = REALTIME_IMAGE_FORMAT === "png" ? "png" : "jpg";
    const out = path.join(
      VOICE_SCREENSHOT_DIR,
      artifactName(`${label}-rt`, ext),
    );
    const args = [
      "/usr/bin/sips",
      "-Z",
      String(opts.maxPx ?? REALTIME_IMAGE_MAX_PX),
      "-s",
      "format",
      REALTIME_IMAGE_FORMAT,
      ...(REALTIME_IMAGE_FORMAT === "jpeg"
        ? ["-s", "formatOptions", String(opts.quality ?? REALTIME_IMAGE_QUALITY)]
        : []),
      file,
      "--out",
      out,
    ];
    const resized = await run(args);
    if (
      resized.startsWith("[exit ") ||
      /Warning:|Error:/i.test(resized) ||
      !existsSync(out) ||
      statSync(out).size < 1000
    ) {
      return { file, dims: "", resized: false };
    }
    const dims = await run([
      "/usr/bin/sips",
      "-g",
      "pixelWidth",
      "-g",
      "pixelHeight",
      out,
    ]);
    return { file: out, dims, resized: true };
  }

  private pixelDimensions(
    dims: string,
  ): { width: number; height: number } | undefined {
    const width = Number(dims.match(/pixelWidth:\s*(\d+)/)?.[1]);
    const height = Number(dims.match(/pixelHeight:\s*(\d+)/)?.[1]);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;
    return { width, height };
  }

  private async desktopBounds(): Promise<DesktopBounds | undefined> {
    const out = await run(
      [
        "/usr/bin/osascript",
        "-e",
        'tell application "Finder" to get bounds of window of desktop',
      ],
      undefined,
      { timeoutMs: 1500 },
    );
    if (/^\[(exit|timeout)\s+/i.test(out)) return undefined;
    return parseDesktopBounds(out);
  }

  private async screenCoordinateContext(args: {
    fullDims: string;
    imageDims: string;
  }): Promise<string | undefined> {
    const full = this.pixelDimensions(args.fullDims);
    const image = this.pixelDimensions(args.imageDims);
    if (!full || !image || full.width <= 0 || full.height <= 0) return undefined;
    const desktop = await this.desktopBounds();
    const targetWidth = desktop?.width ?? full.width;
    const targetHeight = desktop?.height ?? full.height;
    const scaleX = targetWidth / image.width;
    const scaleY = targetHeight / image.height;
    const originNote =
      desktop && (desktop.x !== 0 || desktop.y !== 0)
        ? `After scaling, add desktop origin offset x=${desktop.x}, y=${desktop.y}.`
        : "The current desktop origin is x=0, y=0.";
    return [
      `Coordinate mapping: the attached image is ${image.width}x${image.height}, scaled from a ${full.width}x${full.height} screenshot bitmap.`,
      desktop
        ? `mouse_control expects macOS display coordinates in the ${targetWidth}x${targetHeight} top-left coordinate space, not raw Retina screenshot pixels. Scale image x by ${scaleX.toFixed(3)} and image y by ${scaleY.toFixed(3)} before clicking. ${originNote}`
        : `mouse_control expects full-screen coordinates. Scale image x by ${scaleX.toFixed(3)} and image y by ${scaleY.toFixed(3)} before clicking.`,
    ].join(" ");
  }

  private screenVisionNeedsDetail(prompt?: string): boolean {
    const text = prompt?.trim();
    if (!text) return true;
    return /\b(click|press|type|move|scroll|drag|coordinate|coordinates|button|field|input|read|locate|verify|confirm|choose|target|mouse|control|form|menu|link|checkbox|where|x,y|x y)\b/i.test(
      text,
    );
  }

  private async screenScreenshot(note?: string): Promise<string> {
    try {
      const shot = await this.captureScreen();
      return truncate(
        [`Screenshot saved: ${shot.file}`, note ? `Reason: ${note}` : "", shot.dims]
          .filter(Boolean)
          .join("\n"),
      );
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  private async screenBrief(): Promise<string> {
    const script = `
tell application "System Events"
  set frontApp to first application process whose frontmost is true
  set appName to name of frontApp
  set windowName to ""
  try
    set windowName to name of front window of frontApp
  end try
  return appName & linefeed & windowName
end tell
`;
    const out = await run(["/usr/bin/osascript", "-"], script, {
      timeoutMs: 1500,
    });
    if (/^\[exit\s+\d+\]/i.test(out) || /^\[timeout/i.test(out)) {
      return accessibilityHelp(
        "Accessibility permission required for fast screen brief.",
      ) + `\n${out}`;
    }
    const [appRaw, windowRaw] = out.split(/\r?\n/);
    const app = appRaw?.trim();
    const windowTitle = windowRaw?.trim();
    if (!app) return "Fast screen brief could not identify the frontmost app.";
    return truncate(
      [
        `Frontmost app: ${app}`,
        windowTitle ? `Window title: ${windowTitle}` : "Window title: unavailable",
        "Use screen_see if visual details or coordinates are needed.",
      ].join("\n"),
    );
  }

  private async screenSee(
    prompt?: string,
    app?: string,
  ): Promise<ToolExecutionResult | string> {
    try {
      if (app?.trim()) {
        await this.focusApp(app);
        await sleep(250);
      }
      const shot = await this.captureScreen();
      const detailed = this.screenVisionNeedsDetail(prompt);
      const image = await this.realtimeImageCopy(
        shot.file,
        "screen",
        detailed
          ? {}
          : { maxPx: REALTIME_IMAGE_FAST_MAX_PX, quality: REALTIME_IMAGE_FAST_QUALITY },
      );
      const coordinateContext = detailed
        ? await this.screenCoordinateContext({
            fullDims: shot.dims,
            imageDims: image.dims,
          })
        : undefined;
      const visionPrompt =
        [
          prompt?.trim() ||
            "Inspect this Mac screen screenshot. Identify visible UI state, relevant coordinates, and the safest next action. For coordinate clicks, give exact full-screen x,y targets.",
          coordinateContext,
        ]
          .filter(Boolean)
          .join("\n\n");
      return {
        output: truncate(
          [
            `Screen captured and attached for vision: ${shot.file}`,
            shot.dims,
            image.resized
              ? `Realtime vision attachment: ${image.file}\n${image.dims}`
              : "",
            "Use mouse_control only after inspecting this image and choosing clear coordinates.",
          ]
            .filter(Boolean)
            .join("\n"),
        ),
        realtimeImages: [{ path: image.file, prompt: visionPrompt }],
      };
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  // Ask Claude to find a UI element in the current screen and return its center
  // in macOS display points (the space mouse_control expects). Returns undefined
  // when the element is not visible or Claude/key is unavailable.
  private async groundOnScreen(
    target: string,
  ): Promise<
    | { x: number; y: number; label: string }
    | { error: string }
  > {
    if (!this.cfg.anthropicApiKey) {
      return {
        error:
          "Claude vision grounding is unavailable: set FRIDAY_VISION_ANTHROPIC_KEY in .env to enable find_and_click.",
      };
    }
    const shot = await this.captureScreen();
    // Resize to a Claude-friendly size; grounding is proportional so exact px is fine.
    const image = await this.realtimeImageCopy(shot.file, "ground", {
      maxPx: 1280,
      quality: 80,
    });
    const imgPath = image.resized ? image.file : shot.file;
    const imgDims =
      this.pixelDimensions(image.resized ? image.dims : shot.dims) ??
      this.pixelDimensions(shot.dims);
    if (!imgDims) return { error: "Could not measure the screenshot dimensions." };
    const b64 = readFileSync(imgPath).toString("base64");
    const mediaType = imgPath.endsWith(".png") ? "image/png" : "image/jpeg";
    const instruction = [
      `This is a ${imgDims.width}x${imgDims.height} screenshot of a Mac screen.`,
      `Find this UI element: "${target}".`,
      `Respond with ONLY compact JSON and nothing else.`,
      `If found: {"found":true,"x":<int>,"y":<int>,"label":"<short name of what you found>"}`,
      `where x,y is the CENTER of that element in PIXEL coordinates of THIS image (0..${imgDims.width}, 0..${imgDims.height}).`,
      `If it is not visible: {"found":false,"reason":"<short reason>"}.`,
    ].join(" ");
    let text: string;
    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": this.cfg.anthropicApiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.cfg.visionGroundingModel,
          max_tokens: 200,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: mediaType, data: b64 },
                },
                { type: "text", text: instruction },
              ],
            },
          ],
        }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return {
          error: `Claude vision request failed (${resp.status}): ${body.slice(0, 200) || resp.statusText}`,
        };
      }
      const data = (await resp.json()) as {
        content?: Array<{ type: string; text?: string }>;
      };
      text = (data.content ?? [])
        .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
        .join("")
        .trim();
    } catch (err) {
      return {
        error: `Claude vision request errored: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return { error: `Claude returned no coordinates: ${text.slice(0, 120)}` };
    let parsed: {
      found?: boolean;
      x?: number;
      y?: number;
      label?: string;
      reason?: string;
    };
    try {
      parsed = JSON.parse(json);
    } catch {
      return { error: `Could not parse grounding JSON: ${json.slice(0, 120)}` };
    }
    if (!parsed.found || !Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) {
      return {
        error: `Not found on screen${parsed.reason ? `: ${parsed.reason}` : ""}.`,
      };
    }
    // Map image-pixel coords proportionally into the display-point space that
    // mouse_control expects (desktop bounds when available, else screenshot px).
    const desktop = await this.desktopBounds();
    const targetW = desktop?.width ?? imgDims.width;
    const targetH = desktop?.height ?? imgDims.height;
    const originX = desktop?.x ?? 0;
    const originY = desktop?.y ?? 0;
    const px = originX + (parsed.x! / imgDims.width) * targetW;
    const py = originY + (parsed.y! / imgDims.height) * targetH;
    return { x: Math.round(px), y: Math.round(py), label: parsed.label ?? target };
  }

  private async findAndClick(
    target: string,
    actionRaw: string | undefined,
    app: string | undefined,
  ): Promise<string> {
    const description = target.trim();
    if (!description) return "find_and_click needs a target description.";
    const action = ["click", "double_click", "move"].includes(
      (actionRaw ?? "click").trim(),
    )
      ? (actionRaw ?? "click").trim()
      : "click";
    if (app?.trim()) {
      await this.focusApp(app);
      await sleep(250);
    }
    const ground = await this.groundOnScreen(description);
    if ("error" in ground) {
      return `Could not click "${description}" — ${ground.error}`;
    }
    const result = await this.mouseControl(
      action,
      ground.x,
      ground.y,
      undefined,
      undefined,
      undefined,
    );
    const verb =
      action === "move" ? "Moved pointer to" : action === "double_click" ? "Double-clicked" : "Clicked";
    return `${verb} "${ground.label}" at ${ground.x},${ground.y} (Claude-grounded).\n${result}`;
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
    const shot = await run(args, undefined, {
      timeoutMs: Math.max(1000, this.cfg.browserScreenshotTimeoutMs),
    });
    if (shot.startsWith("[exit ") || shot.startsWith("[timeout "))
      return `Browser screenshot failed: ${shot}`;
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
        warmupMs: this.cfg.cameraWarmupMs,
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
        "Inspect this Mac camera image and answer the user's visual question. If a visible person is unknown, ask for their name before storing identity.";
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

  private currentPerception(): string {
    return this.hooks.currentPerception?.() ?? "No background perception cache is available yet.";
  }

  private async voicePersonRemember(
    name: string,
    relationship?: string,
    notes?: string,
  ): Promise<string> {
    const confirmedName = name.trim();
    if (!confirmedName) return "voice_person_remember needs a confirmed speaker name.";
    if (!this.hooks.rememberCurrentSpeaker) {
      return "Speaker recognition is not wired into this daemon session.";
    }
    return await this.hooks.rememberCurrentSpeaker({
      name: confirmedName,
      relationship,
      notes,
    });
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
    if (action === "check") {
      const bin = ensureMouseBinary();
      if (!bin)
        return "Mouse helper unavailable: could not compile src/voice/mouse-control.swift with /usr/bin/swiftc.";
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
    const fallback = async (reason: string) => {
      const fallbackOut = await this.appleScriptMouseFallback(action, x, y);
      if (fallbackOut)
        return `Mouse ${action} at ${Math.round(x)},${Math.round(y)} via Terminal Accessibility fallback.\nReason helper was not used: ${reason}\n${fallbackOut}`;
      return reason;
    };
    const bin = ensureMouseBinary();
    if (!bin) {
      return await fallback(
        "Mouse helper unavailable: could not compile src/voice/mouse-control.swift with /usr/bin/swiftc.",
      );
    }
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
      const fallbackOut = await fallback(out);
      if (!fallbackOut.startsWith("[exit 77]")) return fallbackOut;
      await run([
        "/usr/bin/open",
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      ]);
      return accessibilityHelp(out);
    }
    return `Mouse ${action} at ${Math.round(x)},${Math.round(y)} with orange control glow.\n${out}`;
  }

  private async appleScriptMouseFallback(
    action: string,
    x: number,
    y: number,
  ): Promise<string | null> {
    if (action !== "click" && action !== "double_click") return null;
    const point = `{${Math.round(x)}, ${Math.round(y)}}`;
    const script =
      action === "double_click"
        ? `tell application "System Events"\nclick at ${point}\ndelay 0.08\nclick at ${point}\nend tell`
        : `tell application "System Events" to click at ${point}`;
    const out = await run(["/usr/bin/osascript", "-"], script);
    if (out.startsWith("[exit ")) return null;
    return out;
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
        NODE_BIN,
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
    return resolveVoiceRepo({
      prompt,
      repo,
      configured: this.cfg.repos,
      fallbackPath: REPO_ROOT,
    });
  }

  private async dispatchEngineering(
    prompt: string,
    repo?: string,
    engine = "auto",
    dryRun = false,
  ): Promise<string> {
    if (resolveEngineeringEngine(engine) === "claude")
      return await this.dispatchClaude(prompt, repo);
    return await this.dispatchCodex(prompt, repo, dryRun);
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
        `:microphone: *Voice dispatch* — the user asked me (by voice) to work on \`${resolved.name}\`.`,
      );
      if (!seed)
        return "I couldn't open a Slack thread to track that — Slack post failed.";
      this.dispatchThreadTs = seed;
    }

    return this.spawnBackgroundProcess({
      label: `claude-${resolved.name}`,
      args: ["/bin/bash", DISPATCH_SH, cwd, prompt],
      cwd: REPO_ROOT,
      commandForDisplay: `${DISPATCH_SH} ${cwd} <voice prompt>`,
      env: {
        ...process.env,
        SLACK_BOT_TOKEN: slackBotToken,
        SLACK_CHANNEL: slackVoiceChannel,
        SLACK_THREAD_TS: this.dispatchThreadTs,
        SLACK_USER_ID: this.cfg.slackUserId ?? "",
      } as Record<string, string>,
    });
  }

  private async dispatchCodex(
    prompt: string,
    repo?: string,
    dryRun = false,
  ): Promise<string> {
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

    const command = buildCodexDispatchCommand({
      repoPath: resolved.path,
      promptPath,
    });

    if (dryRun || process.env.FRIDAY_VOICE_DISPATCH_DRY_RUN === "1") {
      return truncate(
        [
          `Dry run: local Codex dispatch prepared for ${resolved.name} (${resolved.reason}).`,
          `Prompt: ${promptPath}`,
          `Command: ${command}`,
        ].join("\n"),
      );
    }

    const script = [
      `tell application "Terminal"`,
      `activate`,
      `do script ${JSON.stringify(command)}`,
      `end tell`,
    ].join("\n");
    const res = await run(["/usr/bin/osascript", "-"], script, {
      timeoutMs: Math.max(1000, this.cfg.dispatchLaunchTimeoutMs),
    });
    if (res.startsWith("[exit ") || res.startsWith("[timeout "))
      return `Codex dispatch failed: ${res}`;
    return `Started a local Codex session on ${resolved.name} (${resolved.reason}). It is running in Terminal.`;
  }

  /** Post to SLACK_VOICE_CHANNEL via Web API; returns the message ts (thread root). */
  private async postSlack(text: string): Promise<string | null> {
    const controller = new AbortController();
    const timeoutMs = Math.max(1000, this.cfg.webFetchTimeoutMs);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.cfg.slackBotToken}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({ channel: this.cfg.slackVoiceChannel, text }),
        signal: controller.signal,
      });
      const data = (await res.json()) as {
        ok: boolean;
        ts?: string;
        error?: string;
      };
      return data.ok && data.ts ? data.ts : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
