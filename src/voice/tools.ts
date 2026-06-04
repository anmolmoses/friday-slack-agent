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
import type { VoiceConfig } from "./config.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const DISPATCH_SH = path.join(REPO_ROOT, "bin", "dispatch-claude.sh");

const MAX_OUTPUT = 4000; // chars of tool output handed back to the model

export interface RealtimeTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const TOOL_DEFS: RealtimeTool[] = [
  {
    type: "function",
    name: "run_shell",
    description:
      "Run a shell command on Anmol's Mac (zsh login shell) and return stdout/stderr. Use for anything on the command line — file ops, querying system state, launching things, git, etc.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute." },
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
        script: { type: "string", description: "The AppleScript source to run." },
      },
      required: ["script"],
    },
  },
  {
    type: "function",
    name: "open_app",
    description: "Open / launch / focus a macOS application by name (e.g. 'Spotify', 'Visual Studio Code', 'Safari').",
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
    description: "Type text into whatever app is currently focused (uses System Events keystroke). Requires Accessibility permission.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to type into the focused app." },
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
        combo: { type: "string", description: "Shortcut like 'cmd+shift+4'." },
      },
      required: ["combo"],
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
        prompt: { type: "string", description: "The full task instruction for the Claude Code session." },
        repo: {
          type: "string",
          description: "Optional repo name to run in (one of the configured repos). Omit for a general/non-repo task.",
        },
      },
      required: ["prompt"],
    },
  },
];

function truncate(s: string): string {
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n…[truncated]` : s;
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
  const parts = combo.split("+").map((p) => p.trim().toLowerCase()).filter(Boolean);
  const modMap: Record<string, string> = {
    cmd: "command down", command: "command down",
    shift: "shift down",
    opt: "option down", option: "option down", alt: "option down",
    ctrl: "control down", control: "control down",
  };
  const keyMap: Record<string, string> = {
    return: "return", enter: "return", esc: "key code 53", escape: "key code 53",
    tab: "tab", space: "space", delete: "key code 51", backspace: "key code 51",
    up: "key code 126", down: "key code 125", left: "key code 123", right: "key code 124",
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
  else if (keyMap[key]?.startsWith("key code")) action = `${keyMap[key]}${using}`;
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

  async exec(name: string, args: Record<string, unknown>): Promise<string> {
    try {
      switch (name) {
        case "run_shell":
          return await run(["/bin/zsh", "-lc", String(args.command ?? "")]);
        case "run_applescript":
          return await run(["/usr/bin/osascript", "-"], String(args.script ?? ""));
        case "open_app":
          return await run(["/usr/bin/open", "-a", String(args.name ?? "")]);
        case "type_text":
          return await run(
            ["/usr/bin/osascript", "-"],
            `tell application "System Events" to keystroke ${JSON.stringify(String(args.text ?? ""))}`,
          );
        case "key_combo":
          return await run(["/usr/bin/osascript", "-"], comboToAppleScript(String(args.combo ?? "")));
        case "dispatch_to_claude":
          return await this.dispatch(String(args.prompt ?? ""), args.repo ? String(args.repo) : undefined);
        default:
          return `Unknown tool: ${name}`;
      }
    } catch (err) {
      return `Tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async dispatch(prompt: string, repo?: string): Promise<string> {
    const { slackBotToken, slackVoiceChannel } = this.cfg;
    if (!slackBotToken || !slackVoiceChannel) {
      return "I can't dispatch — no Slack channel is configured (set SLACK_VOICE_CHANNEL). I can do it directly here instead.";
    }

    // Resolve cwd: the named repo's clone root, else the Friday repo itself.
    let cwd = REPO_ROOT;
    if (repo) {
      const match = this.cfg.repos.find((r) => r.name.toLowerCase() === repo.toLowerCase());
      if (!match) {
        return `I don't have a repo called "${repo}". Configured repos: ${this.cfg.repos.map((r) => r.name).join(", ") || "(none)"}.`;
      }
      cwd = match.path;
    }

    // Seed (or reuse) a Slack thread so dispatch-claude.sh can report back.
    if (!this.dispatchThreadTs) {
      const seed = await this.postSlack(
        `:microphone: *Voice dispatch* — Anmol asked me (by voice) to work on ${repo ? `\`${repo}\`` : "a task"}.`,
      );
      if (!seed) return "I couldn't open a Slack thread to track that — Slack post failed.";
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
    return `Kicked off a Claude session${repo ? ` on ${repo}` : ""} — it's running in a terminal and will report back in the Slack thread. ${out.trim()}`;
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
      const data = (await res.json()) as { ok: boolean; ts?: string; error?: string };
      return data.ok && data.ts ? data.ts : null;
    } catch {
      return null;
    }
  }
}
