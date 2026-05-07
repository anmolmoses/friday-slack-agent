import path from "node:path";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import type { App } from "@slack/bolt";
import type { Config } from "../config.ts";
import type { SpawnHandle, SpawnResult, StreamEvent } from "../claude/types.ts";
import type { SlackMessageEvent, SlackFileAttachment } from "../slack/events.ts";
import type { RoutingHint } from "../slack/routing.ts";
import type { SessionStore } from "./store/interface.ts";
import type { ThreadSession } from "./types.ts";
import type { AgentRouter } from "../agents/router.ts";
import type { AgentDefinition } from "../agents/loader.ts";
import type { WorktreeManager } from "../worktree/manager.ts";
import { createSession } from "./types.ts";
import { spawnClaude as defaultSpawnClaude } from "../claude/spawner.ts";
import { spawnCodex } from "../codex/spawner.ts";
import { withTimeout } from "../lifecycle/timeout.ts";
import { buildPromptPreamble, invalidateThreadCache } from "../slack/thread-context.ts";
import { downloadSlackFiles, collectThreadImageFiles } from "../slack/files.ts";
import { generateMcpConfig } from "../claude/mcp-config.ts";
import { buildStandupPreamble } from "../standup/handler.ts";
import { isVibesChannel, inferRepoFromText } from "../slack/routing.ts";
import {
  classifyJab,
  pruneRecentJabs,
  ragebaitFragment,
  recordJab,
  shouldInjectRagebaitMode,
  shouldInjectSpiralBrake,
  spiralBrakeFragment,
  updateSpiralScore,
} from "./spiral.ts";
import { log } from "../logger.ts";
import { recallContext, engramRecallEnabled } from "../memory/engram-bridge.ts";
import { captureExchange, engramCaptureEnabled } from "../memory/auto-capture.ts";

type SpawnClaudeFn = typeof defaultSpawnClaude;

export class SessionManager {
  private store: SessionStore;
  private config: Config;
  private handles = new Map<string, SpawnHandle>();
  private seenMessages = new Set<string>();
  // Threads we deliberately killed (dashboard "stop" / CLI). When the killed
  // run's result lands in onRunComplete we swallow the SIGTERM error and skip
  // draining, instead of surfacing a spurious "Error: …" in the thread.
  private killedThreads = new Set<string>();
  private spawnClaude: SpawnClaudeFn;
  // Raw user message per thread (pre-preamble), stashed for auto-capture on completion.
  private lastUserMsg = new Map<string, { text: string; user: string | null }>();

  slackApp?: App;
  botUserId?: string;
  agentRouter?: AgentRouter;
  worktreeManager?: WorktreeManager;
  onResponse?: (session: ThreadSession, response: string) => void;
  onEvent?: (session: ThreadSession, event: StreamEvent) => void;
  onSpawn?: (session: ThreadSession, info: SpawnHandle["spawnInfo"]) => void;
  onMessageBuffered?: (event: SlackMessageEvent) => void;
  onError?: (session: ThreadSession, error: string | null) => void;
  onCommandResponse?: (event: SlackMessageEvent, response: string) => void;

  constructor(store: SessionStore, config: Config, spawnClaude?: SpawnClaudeFn) {
    this.store = store;
    this.config = config;
    // Brain selection: Codex (ChatGPT sub) drives chat/memory/docs by default;
    // coding is still dispatched to Claude. Flip via FRIDAY_BRAIN=claude. An
    // explicit override (tests) always wins.
    const defaultBrain =
      config.brain.engine === "codex" ? spawnCodex : defaultSpawnClaude;
    this.spawnClaude = spawnClaude ?? defaultBrain;
    log.info("manager", `brain engine: ${config.brain.engine}`);
  }

  async handleMessage(event: SlackMessageEvent): Promise<void> {
    // Deduplicate: Slack fires both `message` and `app_mention` for @mentions
    if (this.seenMessages.has(event.ts)) return;
    this.seenMessages.add(event.ts);
    // Prevent unbounded growth — old ts values are never needed again
    if (this.seenMessages.size > 1000) {
      const entries = [...this.seenMessages];
      for (let i = 0; i < 500; i++) this.seenMessages.delete(entries[i]);
    }

    // Invalidate thread context cache so next prompt gets fresh history
    invalidateThreadCache(event.threadId);

    let session = await this.store.get(event.threadId);

    if (!session) {
      session = createSession(event.threadId, event.channel);
      await this.store.set(event.threadId, session);
    }

    // Ragebait detection — only matters in vibes channels and only for
    // non-owner users. Track the rolling 15-min jab count per user so the
    // next prompt build can inject the ragebait protocol if it's escalating.
    const OWNER = "U_OWNER";
    if (isVibesChannel(event.channel) && event.user !== OWNER) {
      pruneRecentJabs(session);
      const cls = classifyJab({
        text: event.text,
        mentionsFriday: !!this.botUserId && event.text.includes(`<@${this.botUserId}>`),
        hasAttachment: !!event.files && event.files.length > 0,
      });
      if (cls.isJab) {
        const count = recordJab(session, event.user, event.text);
        log.info(
          "ragebait",
          `thread=${session.threadId} user=${event.user} jabs=${count} reasons=${cls.reasons.join(",")}`,
        );
        await this.store.set(session.threadId, session);
      }
    }

    // Muted threads: ignore everything EXCEPT !unmute (so the user can wake
    // her back up) and !mute itself (so a re-mute gets a confirmation
    // instead of confusing silence). No spawn, no eyes-react, no buffering,
    // no pattern routing — this thread is shut for Friday until !unmute.
    if (session.muted && event.command !== "unmute" && event.command !== "mute") {
      return;
    }

    if (event.command) {
      const handled = await this.handleCommand(session, event);
      if (handled) return;
    }

    if (session.status === "busy") {
      session.pendingMessages.push({
        user: event.user,
        text: event.text,
        ts: event.ts,
        command: event.command ?? undefined,
      });
      await this.store.set(session.threadId, session);
      this.onMessageBuffered?.(event);
      return;
    }

    session.status = "busy";
    session.lastActivity = Date.now();
    await this.store.set(session.threadId, session);

    this.runClaudeWithAgent(session, event.text, event.ts, event.files, event.routingHint ?? null, event.user);
  }

  async getSession(threadId: string): Promise<ThreadSession | undefined> {
    return this.store.get(threadId);
  }

  async resetSession(threadId: string): Promise<void> {
    const session = await this.store.get(threadId);
    if (session && session.status === "busy") {
      const handle = this.handles.get(threadId);
      if (handle) {
        handle.kill();
        this.handles.delete(threadId);
      }
    }
    await this.store.delete(threadId);

    // Kill the per-thread tmux dispatch session and clear the resume state,
    // so the next repo-work request gets a fresh Claude conversation in a
    // fresh Terminal window.
    const safeThread = threadId.replace(/\./g, "-");
    await this.killThreadTmux(threadId);
    try {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(`/tmp/friday-dispatch/${safeThread}.sessionid`);
    } catch {
      // file might not exist
    }
  }

  /** Kill the per-thread tmux dispatch session (the repo-work Terminal). No-op
   * if tmux isn't installed or the session doesn't exist. */
  private async killThreadTmux(threadId: string): Promise<void> {
    const tmuxName = `friday-thread-${threadId.replace(/\./g, "-")}`;
    try {
      await Bun.spawn(["/opt/homebrew/bin/tmux", "kill-session", "-t", tmuxName], {
        stdout: "ignore",
        stderr: "ignore",
      }).exited;
    } catch {
      // tmux not installed or session not present — both are fine.
    }
  }

  /**
   * Hard-stop a thread on demand (dashboard "stop" button / CLI). Kills any
   * in-flight claude run, kills the per-thread tmux dispatch session, drops
   * buffered messages so nothing re-spawns, and (by default) mutes the thread
   * so Friday ignores future messages until resumed.
   *
   * Unlike resetSession this KEEPS the session row and its resume sessionId —
   * `setMuted(threadId, false)` (Resume) or `!unmute` brings her back where she
   * left off. Returns what actually happened so the UI can confirm.
   */
  async killThread(
    threadId: string,
    opts: { mute?: boolean } = {},
  ): Promise<{ found: boolean; killedRun: boolean; muted: boolean }> {
    const session = await this.store.get(threadId);
    if (!session) return { found: false, killedRun: false, muted: false };

    const mute = opts.mute ?? true;

    // Drop the buffer first so the killed run's onRunComplete can't drain it.
    session.pendingMessages = [];

    let killedRun = false;
    const handle = this.handles.get(threadId);
    if (handle) {
      // Mark before kill so the result handler swallows the SIGTERM error.
      this.killedThreads.add(threadId);
      handle.kill();
      this.handles.delete(threadId);
      killedRun = true;
    }

    session.status = "idle";
    session.pid = null;
    if (mute) session.muted = true;
    await this.store.set(threadId, session);

    await this.killThreadTmux(threadId);

    log.info(
      "kill-thread",
      `thread=${threadId} killedRun=${killedRun} muted=${session.muted ?? false}`,
    );
    return { found: true, killedRun, muted: session.muted ?? false };
  }

  /** Toggle a thread's muted flag (dashboard Resume, or pure mute/unmute).
   * Does not touch any running process — use killThread to also stop a run. */
  async setMuted(
    threadId: string,
    muted: boolean,
  ): Promise<{ found: boolean; muted: boolean }> {
    const session = await this.store.get(threadId);
    if (!session) return { found: false, muted: false };
    session.muted = muted;
    await this.store.set(threadId, session);
    log.info("kill-thread", `thread=${threadId} muted=${muted}`);
    return { found: true, muted };
  }

  private async handleCommand(
    session: ThreadSession,
    event: SlackMessageEvent,
  ): Promise<boolean> {
    switch (event.command) {
      case "reset": {
        await this.resetSession(session.threadId);
        this.onCommandResponse?.(event, "Session reset.");
        return true;
      }

      case "status": {
        const ago = session.lastActivity
          ? `${Math.round((Date.now() - session.lastActivity) / 1000)}s ago`
          : "never";
        const lines = [
          `*Status:* ${session.status}${session.muted ? " (muted)" : ""}`,
          `*Agent:* ${session.agentType ?? "default"}`,
          `*Repo:* ${session.targetRepo ?? "none"}`,
          `*Worktree:* ${session.worktreePath ?? "none"}`,
          `*Last activity:* ${ago}`,
          `*Pending messages:* ${session.pendingMessages.length}`,
        ];
        this.onCommandResponse?.(event, lines.join("\n"));
        return true;
      }

      case "help": {
        const helpText = [
          "*Commands:*",
          "`!build` — Build agent (continues to Claude)",
          "`!frontend` — Frontend agent (continues to Claude)",
          "`!review` — Review agent (continues to Claude)",
          "`!architect` — Architect agent (continues to Claude)",
          "`!repo <name>` — Set target repository",
          "`!branch <ref>` — Set base branch ref",
          "`!worktrees` — List active worktrees + disk usage",
          "`!reset` — Reset session",
          "`!status` — Show session status",
          "`!quiet` — Minimal output",
          "`!normal` — Normal output",
          "`!verbose` — Verbose output",
          "`!memory <query>` — BM25 search over memory (records recalls)",
          "`!memstatus` — Recall/corpus stats",
          "`!promote [N]` — Rank promotion candidates (preview)",
          "`!dream [light|dry]` — Run light/deep phases; writes to MEMORY.md",
          "`!dump <text>` — Log daily activity / pending items (parses `remind me on <day>`)",
          "`!done <id>` — Mark a dump entry done",
          "`!pending` — Show open dumps (last 7 days)",
          "`!digest` — Preview the morning digest now",
          "`!mute` — Disconnect Friday from this thread (no replies until `!unmute`)",
          "`!unmute` — Reconnect Friday to this thread",
          "`!help` — Show this help",
        ].join("\n");
        this.onCommandResponse?.(event, helpText);
        return true;
      }

      case "quiet": {
        session.verbosity = "quiet";
        await this.store.set(session.threadId, session);
        this.onCommandResponse?.(event, "Quiet mode.");
        return true;
      }

      case "verbose": {
        session.verbosity = "verbose";
        await this.store.set(session.threadId, session);
        this.onCommandResponse?.(event, "Verbose mode.");
        return true;
      }

      case "normal": {
        session.verbosity = "normal";
        await this.store.set(session.threadId, session);
        this.onCommandResponse?.(event, "Normal mode.");
        return true;
      }

      case "mute": {
        if (session.muted) {
          this.onCommandResponse?.(event, "Already muted on this thread. `!unmute` to wake me back up.");
        } else {
          session.muted = true;
          await this.store.set(session.threadId, session);
          this.onCommandResponse?.(event, "Muted on this thread :zipper_mouth_face: I won't reply to anything here until `!unmute`.");
        }
        return true;
      }

      case "unmute": {
        if (!session.muted) {
          this.onCommandResponse?.(event, "Not muted — I'm already listening.");
        } else {
          session.muted = false;
          await this.store.set(session.threadId, session);
          this.onCommandResponse?.(event, "Unmuted :bell: back online for this thread.");
        }
        return true;
      }

      case "worktrees": {
        if (!this.worktreeManager) {
          this.onCommandResponse?.(event, "Worktree manager not configured.");
          return true;
        }
        const sessions = await this.store.getAll();
        const activity = new Map<string, number>();
        for (const [tid, s] of sessions) activity.set(tid, s.lastActivity);
        const all = await this.worktreeManager.listAllWorktrees(activity);
        if (all.length === 0) {
          this.onCommandResponse?.(event, "No active worktrees.");
          return true;
        }
        const gb = (b: number) => `${(b / (1024 * 1024 * 1024)).toFixed(2)}GB`;
        const total = all.reduce((sum, w) => sum + w.diskBytes, 0);
        const cap = this.config.worktree.diskCapBytes;
        const rows = all
          .sort((a, b) => b.diskBytes - a.diskBytes)
          .map(
            (w) =>
              `${w.dirty ? ":warning:" : ":white_check_mark:"} \`${w.repoName}\` ${w.branch ?? "?"} — ${gb(w.diskBytes)}${w.dirty ? " (dirty)" : ""}`,
          );
        this.onCommandResponse?.(
          event,
          [
            `*Worktrees:* ${all.length} · *Disk:* ${gb(total)} / ${gb(cap)} cap`,
            ...rows,
          ].join("\n"),
        );
        return true;
      }

      case "build":
      case "frontend":
      case "review":
      case "architect": {
        session.agentType = event.command;
        await this.store.set(session.threadId, session);
        return false;
      }

      case "repo": {
        const repoName = event.text.trim();
        const match = this.config.repos.find((r) => r.name === repoName);
        if (match) {
          session.targetRepo = match.name;
          await this.store.set(session.threadId, session);
          this.onCommandResponse?.(event, `Repository set to *${match.name}*.`);
        } else {
          const available = this.config.repos.map((r) => r.name).join(", ");
          this.onCommandResponse?.(
            event,
            `Unknown repo "${repoName}". Available: ${available || "none configured"}`,
          );
        }
        return true;
      }

      case "branch": {
        const ref = event.text.trim();
        session.baseRef = ref;
        await this.store.set(session.threadId, session);
        this.onCommandResponse?.(event, `Base ref set to *${ref}*.`);
        return true;
      }

      case "dump": {
        const text = event.text.trim();
        if (!text) {
          this.onCommandResponse?.(event, "Usage: `!dump <what you did / what's pending>`. Reminders inside: `remind me on monday`, `remind me tomorrow`, `remind me on 2026-05-10`.");
          return true;
        }
        const { addDump } = await import("../dumps/store.ts");
        const entry = addDump(text);
        const reminderLine =
          entry.reminders.length > 0
            ? `\n_Reminders parsed:_ ${entry.reminders.map((r) => r.date).join(", ")}`
            : "";
        this.onCommandResponse?.(event, `Logged \`${entry.id}\`.${reminderLine}`);
        return true;
      }

      case "done": {
        const id = event.text.trim();
        if (!id) {
          this.onCommandResponse?.(event, "Usage: `!done <id>` (id from `!pending` or the dump confirmation).");
          return true;
        }
        const { markDone } = await import("../dumps/store.ts");
        const entry = markDone(id);
        if (!entry) {
          this.onCommandResponse?.(event, `No dump with id \`${id}\`.`);
        } else {
          this.onCommandResponse?.(event, `✅ \`${id}\` marked done.`);
        }
        return true;
      }

      case "pending": {
        const { openDumpsSince } = await import("../dumps/store.ts");
        const open = openDumpsSince(7);
        if (open.length === 0) {
          this.onCommandResponse?.(event, "Nothing pending in the last 7 days. ✨");
          return true;
        }
        const body = open
          .map((e) => `• \`${e.id}\` — ${e.text}`)
          .join("\n");
        this.onCommandResponse?.(event, `*Pending (${open.length}):*\n${body}`);
        return true;
      }

      case "digest": {
        const { buildDigest } = await import("../dumps/scheduler.ts");
        const text = buildDigest();
        this.onCommandResponse?.(event, text ?? "Nothing to report — clean slate. ✨");
        return true;
      }

      case "memory": {
        const query = event.text.trim();
        if (!query) {
          this.onCommandResponse?.(event, "Usage: `!memory <query>`");
          return true;
        }
        const { searchMemory } = await import("../memory/search.ts");
        const results = searchMemory(query, { limit: 8 });
        if (results.length === 0) {
          this.onCommandResponse?.(event, `No matches for "${query}".`);
          return true;
        }
        const body = results
          .map((r) => {
            const tags = r.conceptTags?.length ? `  _${r.conceptTags.slice(0, 4).join(", ")}_` : "";
            const preview = r.snippet.slice(0, 220).replace(/\s+/g, " ");
            return `• *${r.path}:${r.startLine}-${r.endLine}* (score ${r.score.toFixed(2)})${tags}\n  > ${preview}${r.snippet.length > 220 ? "…" : ""}`;
          })
          .join("\n");
        this.onCommandResponse?.(event, body);
        return true;
      }

      case "memstatus": {
        const { loadRecallStore, loadPhaseSignalStore } = await import("../memory/recall.ts");
        const { loadCorpus } = await import("../memory/corpus.ts");
        const recall = loadRecallStore();
        const signals = loadPhaseSignalStore();
        const corpus = loadCorpus();
        const entries = Object.values(recall.entries);
        const promoted = entries.filter((e) => e.promotedAt).length;
        const lines = [
          `*Memory status*`,
          `• Corpus: ${corpus.length} snippets`,
          `• Short-term recall: ${entries.length} entries (${promoted} promoted, ${entries.length - promoted} pending)`,
          `• Phase signals: ${Object.keys(signals.entries).length}`,
          `• Recall updated: ${recall.updatedAt}`,
        ];
        this.onCommandResponse?.(event, lines.join("\n"));
        return true;
      }

      case "promote": {
        this.onCommandResponse?.(event, "Ranking promotion candidates…");
        (async () => {
          try {
            const { rankPromotionCandidates, formatCandidates } = await import("../memory/promote.ts");
            const limit = Number.parseInt(event.text.trim() || "10", 10) || 10;
            const candidates = rankPromotionCandidates({ limit });
            if (candidates.length === 0) {
              this.onCommandResponse?.(event, "No candidates meet the 0.8 promotion gate.");
              return;
            }
            this.onCommandResponse?.(
              event,
              `Top ${candidates.length} candidates:\n\`\`\`\n${formatCandidates(candidates)}\n\`\`\`\nRun \`!dream\` to actually write them to MEMORY.md.`,
            );
          } catch (err) {
            this.onCommandResponse?.(event, `Promote failed: ${err}`);
          }
        })();
        return true;
      }

      case "dream": {
        const args = event.text.trim();
        const lightOnly = /\blight\b/.test(args);
        const dryRun = /\bdry\b/.test(args);
        const withDecay = /\bdecay\b/.test(args);
        this.onCommandResponse?.(event, `Dreaming (${lightOnly ? "light only" : dryRun ? "dry run" : "full"})… this can take a minute.`);
        (async () => {
          try {
            const { runDream } = await import("../memory/dreaming.ts");
            const result = await runDream({ lightOnly, dryRun, withNarrative: true, withDecay });
            const head = `Dream complete. light=${result.lightHits} rem=${result.remHits} deep=${result.deepPromoted}${withDecay ? ` decay=${result.decayArchived}` : ""}`;
            this.onCommandResponse?.(
              event,
              `${head}\n\n${result.summary.slice(0, 2500)}`,
            );
          } catch (err) {
            this.onCommandResponse?.(event, `Dream failed: ${err}`);
          }
        })();
        return true;
      }

      default:
        return false;
    }
  }

  private async runClaudeWithAgent(
    session: ThreadSession,
    prompt: string,
    latestTs?: string,
    files?: SlackFileAttachment[],
    routingHint: RoutingHint | null = null,
    requestingUser: string | null = null,
  ): Promise<void> {
    // Stash the RAW user message (before preamble) for auto-capture on completion.
    if (engramCaptureEnabled()) {
      this.lastUserMsg.set(session.threadId, { text: prompt, user: requestingUser });
    }
    try {
      // Inject identity + thread context so Claude knows who it is and what was said
      if (this.slackApp && latestTs) {
        const preamble = await buildPromptPreamble(
          this.slackApp,
          session.channel,
          session.threadId,
          latestTs,
          this.botUserId,
        );
        prompt = `${preamble}\n\n${prompt}`;
      }

      // Standup workflow preamble — only when this thread IS the standup
      // kickoff thread. Tells Claude the format + rules + carry-over context.
      const standupPreamble = buildStandupPreamble(
        session.channel,
        session.threadId,
      );
      if (standupPreamble) {
        prompt = `${standupPreamble}\n\n${prompt}`;
      }

      // Pattern-routing hint — tells Friday what she's been proactively pulled
      // in for (PR review, bug triage, catchup). The hint instructs her tone
      // and output structure for that specific trigger.
      if (routingHint) {
        const { hintPromptFragment } = await import("../slack/routing.ts");
        const fragment = hintPromptFragment(routingHint, prompt);
        if (fragment) prompt = `${fragment}\n\n${prompt}`;
      }

      // Infer the target repo + agent from the message when the thread wasn't
      // explicitly pinned with !repo / !review. A natural-language
      // "review <PR-url>" (or an auto-routed PR-review) otherwise leaves
      // targetRepo null, so the worktree block below never fires and the run
      // happens in Friday's own cwd with no isolation. We infer from the FULL
      // prompt (preamble + thread history included) so follow-ups like
      // "review again" still resolve the repo from the PR link upthread.
      if (this.worktreeManager && !session.targetRepo) {
        const inferred = inferRepoFromText(
          prompt,
          this.config.repos.map((r) => r.name),
        );
        if (inferred) {
          session.targetRepo = inferred;
          await this.store.set(session.threadId, session);
          log.info("manager", `thread=${session.threadId} inferred targetRepo=${inferred} (worktree isolation)`);
        }
      }

      // Anti-spiral guardrails — only injected in vibes channels where the
      // failure mode lives. A real spiral incident is the canonical scar.
      if (isVibesChannel(session.channel)) {
        pruneRecentJabs(session);
        if (shouldInjectRagebaitMode(session)) {
          prompt = `${ragebaitFragment()}\n\n${prompt}`;
          log.info("ragebait", `thread=${session.threadId} mode=ON`);
        }
        if (shouldInjectSpiralBrake(session)) {
          prompt = `${spiralBrakeFragment()}\n\n${prompt}`;
          log.info("spiral", `thread=${session.threadId} brake=ON score=${session.spiralScore}`);
        }
      }

      // Download image files from Slack and append their paths to the prompt.
      // Scan the WHOLE thread, not just the triggering message: the reporter
      // often attaches the screenshot to the root message while Friday is
      // @mentioned in a later reply with no file. Missing that image is what
      // leaves a dispatched Claude blocked with no screenshot to disambiguate.
      try {
        const triggerFiles = files ?? [];
        const threadFiles = this.slackApp
          ? await collectThreadImageFiles(
              this.slackApp,
              session.channel,
              session.threadId,
            )
          : [];
        // Dedupe by url (the trigger message is also part of the thread fetch).
        const seen = new Set<string>();
        const allFiles = [...triggerFiles, ...threadFiles].filter((f) => {
          if (seen.has(f.url)) return false;
          seen.add(f.url);
          return true;
        });
        if (allFiles.length > 0) {
          const localPaths = await downloadSlackFiles(
            allFiles,
            session.threadId,
            this.config.slack.botToken,
          );
          if (localPaths.length > 0) {
            const pathList = localPaths.map((p) => `- ${p}`).join("\n");
            prompt += `\n\nImages shared in this thread are saved at these paths — use the Read tool to view them, and when you dispatch work to Claude, pass these absolute paths in the prompt:\n${pathList}`;
          }
        }
      } catch (err) {
        console.error("[manager] Failed to download Slack files:", err);
      }

      // Ensure today's daily note exists
      ensureDailyNote();

      // Resolve agent definition (for model, effort, tool restrictions)
      let agentDef: AgentDefinition | null = null;

      // Compose agent system prompt
      if (session.agentType && this.agentRouter) {
        session.systemPrompt =
          (await this.agentRouter.composeSystemPrompt(session)) ?? null;
        agentDef = await this.agentRouter.resolveAgent(session);
        await this.store.set(session.threadId, session);
      }

      // Worktree isolation for EVERY repo-bound thread, so concurrent threads
      // (multiple PR reviews, builds across projects) never collide on git
      // state. Light checkout by default (instant); build/frontend threads get
      // a full setup-worktree.sh provision (env + MCPs + npm install) so the
      // app is runnable, done once and remembered via worktreeProvisioned.
      if (this.worktreeManager && session.targetRepo) {
        const needsFull =
          session.agentType === "build" || session.agentType === "frontend";
        try {
          const exists =
            session.worktreePath != null &&
            (await this.worktreeManager.worktreeExists(
              session.targetRepo,
              session.threadId,
            ));

          if (!exists) {
            session.worktreePath = await this.worktreeManager.createWorktree(
              session.targetRepo,
              session.threadId,
              session.baseRef ?? undefined,
              needsFull ? "full" : "light",
            );
            session.worktreeProvisioned = needsFull;
            await this.store.set(session.threadId, session);
          } else if (needsFull && !session.worktreeProvisioned) {
            // Light worktree exists but this is the first build — upgrade it.
            const upgraded = await this.worktreeManager.upgradeWorktree(
              session.targetRepo,
              session.threadId,
              session.baseRef ?? undefined,
            );
            session.worktreeProvisioned = upgraded;
            await this.store.set(session.threadId, session);
          }
        } catch (err) {
          console.error("[manager] Failed to create/provision worktree:", err);
          // Continue without worktree — spawner falls back to cwd
        }
      }

      // Generate per-thread MCP config
      try {
        session.mcpConfigPath = generateMcpConfig(session.threadId);
        await this.store.set(session.threadId, session);
      } catch (err) {
        console.error("[manager] Failed to generate MCP config:", err);
      }

      // Write status file for MCP friday-status server
      this.writeStatusFile();

      // Resolve target repo path for cwd fallback (decision 4: cwd → target repo)
      let targetRepoCwd: string | undefined;
      if (session.targetRepo) {
        const repo = this.config.repos.find((r) => r.name === session.targetRepo);
        if (repo) targetRepoCwd = repo.path;
      }

      // Associative recall (engram) for this message — extra system-prompt
      // context. Off unless ENGRAM_RECALL=1; always fails soft to no context.
      let memoryContext: string | undefined;
      if (engramRecallEnabled()) {
        try { memoryContext = (await recallContext(prompt)) || undefined; }
        catch { memoryContext = undefined; }
      }

      const rawHandle = this.spawnClaude(session, prompt, this.config.claude, targetRepoCwd, this.config.slack.botToken, agentDef, requestingUser, memoryContext);
      const handle = withTimeout(
        rawHandle,
        this.config.claude.timeoutMs,
        (reason) => {
          console.warn(`[manager] Claude timed out for thread ${session.threadId}: ${reason}`);
        },
        this.config.claude.maxTimeoutMs,
      );
      this.handles.set(session.threadId, handle);
      session.pid = handle.pid;
      try { this.onSpawn?.(session, rawHandle.spawnInfo); }
      catch (err) { console.warn("[manager] onSpawn threw:", err); }

      handle.onEvent((event: StreamEvent) => {
        if (event.type === "system" && event.subtype === "init") {
          session.sessionId = event.session_id;
        }
        this.onEvent?.(session, event);
      });

      handle.result.then(
        (result: SpawnResult) => this.onRunComplete(session, result),
        (err: unknown) => this.onRunComplete(session, {
          sessionId: null,
          response: "",
          events: [],
          exitCode: null,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    } catch (err) {
      // Agent prompt composition or worktree creation failed fatally
      session.status = "idle";
      session.lastError = {
        type: "setup",
        message: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      };
      await this.store.set(session.threadId, session);
      this.onError?.(session, session.lastError.message);
    }
  }

  private async onRunComplete(
    session: ThreadSession,
    result: SpawnResult,
  ): Promise<void> {
    this.handles.delete(session.threadId);
    session.pid = null;

    // Deliberate kill (dashboard "stop" / CLI): swallow the SIGTERM error and
    // skip draining. killThread already cleared pending + set muted/idle and
    // persisted, so just keep the session id (for Resume) and settle to idle.
    if (this.killedThreads.has(session.threadId)) {
      this.killedThreads.delete(session.threadId);
      if (result.sessionId) session.sessionId = result.sessionId;
      session.status = "idle";
      session.pendingMessages = [];
      await this.store.set(session.threadId, session);
      this.writeStatusFile();
      log.info("kill-thread", `thread=${session.threadId} run terminated`);
      return;
    }

    if (result.sessionId) {
      session.sessionId = result.sessionId;
    }

    if (result.error) {
      session.lastError = {
        type: "spawn",
        message: result.error,
        timestamp: Date.now(),
      };
      this.onError?.(session, result.error);
    }

    if (result.response) {
      // Track Friday's own self-deprecation streak in vibes channels — feeds
      // the spiral-brake injection on the next turn.
      if (isVibesChannel(session.channel)) {
        const before = session.spiralScore ?? 0;
        updateSpiralScore(session, result.response);
        if (session.spiralScore !== before) {
          log.info(
            "spiral",
            `thread=${session.threadId} score ${before}→${session.spiralScore}`,
          );
        }
      }
      this.onResponse?.(session, result.response);

      // Auto-capture this exchange into memory/ so it becomes recallable later.
      if (engramCaptureEnabled()) {
        const last = this.lastUserMsg.get(session.threadId);
        if (last) {
          captureExchange({
            channel: session.channel,
            threadId: session.threadId,
            user: last.user,
            userText: last.text,
            reply: result.response,
          });
        }
      }
    } else if (!result.error) {
      // Silent failure: the spawn exited cleanly (no error) but produced no
      // response text. This happens when Claude hits --max-turns mid-tool-use,
      // when the stream parser encounters malformed JSON, or when the model
      // exits without emitting a final result event. Without surfacing this
      // explicitly, the user sees a "thinking…" status that never resolves
      // and has no way to know the run failed. (2026-05-08 incident: thread
      // 1778225259.441429 — Friday ran 14 mongo queries + grep, then her
      // spawn died at turn ~25 with zero text output, leaving the
      // "Focusmaxxing…" status verb up indefinitely.)
      const numEvents = result.events?.length ?? 0;
      const lastSessionId = result.sessionId ?? session.sessionId ?? "unknown";
      const transcriptHint =
        `~/.claude/projects/-Users-anmol-Documents-GitHub-Friday/${lastSessionId}.jsonl`;
      log.warn(
        "silent-fail",
        `thread=${session.threadId} session=${lastSessionId} events=${numEvents} exitCode=${result.exitCode} — spawn exited clean with no response text`,
      );
      session.lastError = {
        type: "silent-fail",
        message: `Spawn exited with code ${result.exitCode} after ${numEvents} stream events but produced no final assistant text. Likely max-turns hit or stream parse issue. Transcript: ${transcriptHint}`,
        timestamp: Date.now(),
      };
      // Surface in Slack so the thread author isn't left staring at a
      // thinking-verb that never resolves. Keep the message terse and link
      // the diagnostic path in case the user wants to dig.
      this.onError?.(
        session,
        `_silent fail — my run completed with no text output (events=${numEvents}, exit=${result.exitCode}). Likely \`--max-turns\` was hit. Transcript: \`${transcriptHint}\`_`,
      );
    }

    if (session.pendingMessages.length > 0) {
      const combined = session.pendingMessages
        .map((m) => `[${m.user}]: ${m.text}`)
        .join("\n");
      // For permission purposes, downgrade to the most-restrictive user in the
      // batch: if anyone other than the user contributed to this drain, treat the
      // run as non-owner so the self-edit guard locks Friday's source.
      const OWNER = "U_OWNER";
      const nonOwner = session.pendingMessages.find((m) => m.user !== OWNER);
      const drainUser = nonOwner ? nonOwner.user : OWNER;
      session.pendingMessages = [];
      session.status = "draining";
      await this.store.set(session.threadId, session);
      this.runClaudeWithAgent(session, combined, undefined, undefined, null, drainUser).catch((err) => {
        console.error("[manager] Drain failed:", err);
        session.status = "idle";
        this.store.set(session.threadId, session);
      });
    } else {
      session.status = "idle";
      await this.store.set(session.threadId, session);
    }

    // Update status file after run completes
    this.writeStatusFile();
  }

  private async writeStatusFile(): Promise<void> {
    try {
      const allSessions = await this.store.getAll();
      const sessions: Record<string, unknown> = {};
      for (const s of allSessions.values()) {
        sessions[s.threadId] = {
          status: s.status,
          agentType: s.agentType,
          channel: s.channel,
          pendingCount: s.pendingMessages.length,
          lastActivity: s.lastActivity,
        };
      }
      const statusData = {
        startedAt: this.startedAt,
        sessions,
      };
      writeFileSync("/tmp/friday-status.json", JSON.stringify(statusData, null, 2));
    } catch {
      // Non-critical — don't crash if status write fails
    }
  }

  private startedAt = new Date().toISOString();
}

function ensureDailyNote(): void {
  const fridayRoot = path.resolve(import.meta.dir, "../..");
  const today = new Date().toISOString().split("T")[0];
  const dailyDir = path.join(fridayRoot, "memory", "daily");
  mkdirSync(dailyDir, { recursive: true });
  const dailyPath = path.join(dailyDir, `${today}.md`);
  if (!existsSync(dailyPath)) {
    writeFileSync(dailyPath, `# ${today}\n\n`);
  }
}

