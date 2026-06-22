#!/usr/bin/env bun
/**
 * friday-selftest — drive ONE real Friday turn locally, with NO Slack connection.
 *
 * Why this exists: `bun run dev` boots Slack Socket Mode and would start
 * answering real messages in the live workspace — unsafe for testing a code
 * change. This harness boots the exact same turn pipeline (SessionManager →
 * routing → brain spawn (codex/claude) → stream-json parse → response) against
 * an in-memory session store and a synthetic event, so you can verify a change
 * end-to-end before claiming it works. Nothing is posted to Slack.
 *
 * Usage:
 *   bun run selftest "what repos do you work with?"
 *   bun run selftest --verbose "review the open PRs"        # stream tool_use events
 *   bun run selftest --channel C0257TR1CD7 "yo"             # test vibes-lint path
 *   bun run selftest --brain claude "..."                   # force the claude brain
 *   bun run selftest --repo gx-backend "..."                # set a target repo
 *   bun run selftest --timeout 120000 "..."                 # override timeout (ms)
 *
 * Exit code is 0 on a real response, 1 on error/timeout — so it composes in CI
 * and in `bun run check`.
 */
import { loadConfig } from "../src/config.ts";
import { SessionManager } from "../src/session/manager.ts";
import { InMemorySessionStore } from "../src/session/store/memory.ts";
import { AgentRouter } from "../src/agents/router.ts";
import { WorktreeManager } from "../src/worktree/manager.ts";
import { parseCommand } from "../src/slack/commands.ts";
import { isVibesChannel } from "../src/slack/routing.ts";

const ANMOL = "U09SZ4DM8TH";
// Neutral, non-vibes channel id so vibes-lint doesn't apply unless asked.
const DEFAULT_CHANNEL = "C_SELFTEST";

function parseArgs(argv: string[]) {
  let channel = DEFAULT_CHANNEL;
  let user = ANMOL;
  let brain: "codex" | "claude" | null = null;
  let repo: string | null = null;
  let timeoutMs = 180_000;
  let verbose = false;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--channel") channel = argv[++i];
    else if (a === "--user") user = argv[++i];
    else if (a === "--brain") brain = argv[++i] === "claude" ? "claude" : "codex";
    else if (a === "--repo") repo = argv[++i];
    else if (a === "--timeout") timeoutMs = Number(argv[++i]);
    else if (a === "--verbose" || a === "-v") verbose = true;
    else rest.push(a);
  }
  return { channel, user, brain, repo, timeoutMs, verbose, prompt: rest.join(" ").trim() };
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.prompt) {
    console.error(
      "usage: bun run selftest [--channel C..] [--user U..] [--brain codex|claude] [--repo NAME] [--timeout MS] [--verbose] \"<prompt>\"",
    );
    process.exit(2);
  }

  // Force the brain BEFORE loadConfig reads FRIDAY_BRAIN.
  if (opts.brain) process.env.FRIDAY_BRAIN = opts.brain;
  const config = loadConfig();

  const store = new InMemorySessionStore();
  const sessionManager = new SessionManager(store, config);
  sessionManager.agentRouter = new AgentRouter(config.repos, ".claude/agents");
  sessionManager.worktreeManager = new WorktreeManager(config.repos);
  sessionManager.botUserId = "UFRIDAYBOT";
  // NOTE: no slackApp wired on purpose — turn runs offline. The manager guards
  // every slackApp use with `if (this.slackApp)`, so thread-history fetch is
  // simply skipped (correct — there is no real thread).

  const threadId = `selftest-${Date.now()}`;
  const ts = String(Date.now() / 1000);
  const parsed = parseCommand(opts.prompt);

  const started = Date.now();
  const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;

  console.log(bold("\n▶ friday-selftest"));
  console.log(dim(`  brain=${config.brain.engine}  channel=${opts.channel}${isVibesChannel(opts.channel) ? " (vibes)" : ""}  thread=${threadId}`));
  console.log(dim(`  prompt: ${opts.prompt}`));
  if (parsed.command) console.log(dim(`  command: !${parsed.command}`));
  console.log("");

  const done = new Promise<{ ok: boolean; text: string }>((resolve) => {
    const timer = setTimeout(() => {
      resolve({ ok: false, text: `timeout after ${opts.timeoutMs}ms` });
    }, opts.timeoutMs);
    const finish = (ok: boolean, text: string) => {
      clearTimeout(timer);
      resolve({ ok, text });
    };

    sessionManager.onSpawn = (s, info) => {
      console.log(dim(`  ↪ spawn ${s.agentType ?? "chat"} (pid ${info?.pid ?? "?"}) ${elapsed()}`));
    };
    sessionManager.onEvent = (_s, event) => {
      if (!opts.verbose) return;
      if (event.type === "assistant") {
        for (const block of event.message?.content ?? []) {
          if (block.type === "tool_use") {
            console.log(dim(`  · tool ${cyan(block.name)} ${elapsed()}`));
          }
        }
      }
    };
    sessionManager.onCommandResponse = (_e, response) => finish(true, response);
    sessionManager.onResponse = (_s, response) => finish(true, response ?? "");
    sessionManager.onError = (_s, error) => finish(false, String(error ?? "unknown error"));
  });

  await sessionManager.handleMessage({
    threadId,
    channel: opts.channel,
    user: opts.user,
    text: opts.prompt,
    ts,
    command: parsed.command,
    files: [],
  });

  const result = await done;

  console.log("");
  if (result.ok) {
    console.log(bold(green(`✓ response (${elapsed()})`)));
    console.log("");
    console.log(result.text || dim("(empty / suppressed)"));
  } else {
    console.log(bold(red(`✗ failed (${elapsed()})`)));
    console.log("");
    console.log(red(result.text));
  }
  console.log("");
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(red(`harness crashed: ${err?.stack ?? err}`));
  process.exit(1);
});
