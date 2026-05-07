import { loadConfig } from "./config.ts";
import { createSlackApp } from "./slack/app.ts";
import { registerEventHandlers } from "./slack/events.ts";
import { formatToolStatuses, extractThinkingStatus } from "./slack/formatting.ts";
import { SlackResponder } from "./slack/responder.ts";
import { isVibesChannel } from "./slack/routing.ts";
import { lintVibesResponse } from "./slack/vibes-lint.ts";
import { SessionManager } from "./session/manager.ts";
import { FileSessionStore } from "./session/store/file.ts";
import path from "node:path";
import { setupGracefulShutdown } from "./lifecycle/shutdown.ts";
import { registerHomeTab } from "./slack/home.ts";
import { checkOrphanedSessions } from "./lifecycle/health.ts";
import { cleanupStaleSessions } from "./lifecycle/cleanup.ts";
import { AgentRouter } from "./agents/router.ts";
import { WorktreeManager } from "./worktree/manager.ts";
import { reapWorktrees } from "./worktree/reaper.ts";
import { monitorSocketHealth } from "./slack/socket-health.ts";
import { startNightlyDream } from "./memory/scheduler.ts";
import { startDumpDigest } from "./dumps/scheduler.ts";
import { startStandupScheduler } from "./standup/scheduler.ts";
import { isStandupThread } from "./standup/handler.ts";
import {
  ensureThread,
  setThreadMeta,
  recordStreamEvent as dashRecordStreamEvent,
  recordResponse as dashRecordResponse,
  recordError as dashRecordError,
  recordIncomingMessage as dashRecordIncomingMessage,
  recordRouting as dashRecordRouting,
  recordSpawn as dashRecordSpawn,
  recordWorktrees as dashRecordWorktrees,
} from "./http/dashboard-state.ts";
import { log } from "./logger.ts";
import { reindexIncremental, startMemoryWatch, engramRecallEnabled } from "./memory/engram-bridge.ts";
import { engramCaptureEnabled } from "./memory/auto-capture.ts";

const config = loadConfig();
const app = createSlackApp(config);

const store = new FileSessionStore(
  path.resolve(import.meta.dir, "..", "memory", "sessions.json"),
);
const sessionManager = new SessionManager(store, config);
const agentRouter = new AgentRouter(config.repos, ".claude/agents");
const worktreeManager = new WorktreeManager(config.repos);
sessionManager.agentRouter = agentRouter;
sessionManager.worktreeManager = worktreeManager;
sessionManager.slackApp = app;
const responder = new SlackResponder(app);

// Sentinels Friday may emit instead of a real reply. Treated as "suppress
// posting" — the openclaw persona documents NO_REPLY as a silent-marker; other
// upstream tools use the pi_sr variant.
const SILENCE_SENTINELS = [
  "NO_REPLY",
  "___pi_sr_silent_marker___",
];

function isSilentResponse(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  return SILENCE_SENTINELS.some(
    (s) => t === s || t.toUpperCase() === s.toUpperCase() || t.startsWith(`${s}\n`),
  );
}

sessionManager.onResponse = (session, response) => {
  const silent = isSilentResponse(response ?? "");
  log.info(
    "response",
    `thread=${session.threadId} len=${response?.length ?? 0}${silent ? " (suppressed)" : ""}`,
  );
  responder.deleteStatus(session.channel, session.threadId);
  if (response && !silent) {
    let toPost = response;
    // Skip vibes-lint inside the active standup kickoff thread — standup
    // drafts are inherently multi-line (*Yesterday* + *Today* blocks with
    // bullets) and the 3-line cap mangles them. C_SANDBOX is both the
    // standup channel AND a vibes channel, hence the explicit thread check.
    if (isVibesChannel(session.channel) && !isStandupThread(session.threadId)) {
      const lint = lintVibesResponse(response);
      if (lint.truncated) {
        log.warn(
          "vibes-lint",
          `thread=${session.threadId} truncated reasons=${lint.reasons.join(",")} from=${response.length} to=${lint.text.length}`,
        );
        toPost = lint.text || response.split("\n")[0] || response;
      }
    }
    responder.postResponse(session.channel, session.threadId, toPost);
    dashRecordResponse(session.threadId, toPost);
  }
  // Reflect status into the dashboard
  setThreadMeta(session.threadId, {
    status: session.status, agentType: session.agentType, pid: session.pid,
    pendingCount: session.pendingMessages.length, muted: session.muted, sessionId: session.sessionId,
    worktreePath: session.worktreePath, worktreeProvisioned: session.worktreeProvisioned,
  });
};

sessionManager.onEvent = (session, event) => {
  if (event.type === "system" && event.subtype === "init") {
    log.info("session", `thread=${session.threadId} sessionId=${session.sessionId}`);
  }
  // Always feed the live dashboard, regardless of session.verbosity.
  ensureThread(session.threadId, session.channel);
  setThreadMeta(session.threadId, {
    status: session.status, agentType: session.agentType, pid: session.pid,
    pendingCount: session.pendingMessages.length, muted: session.muted, sessionId: session.sessionId,
    worktreePath: session.worktreePath, worktreeProvisioned: session.worktreeProvisioned,
  });
  dashRecordStreamEvent(session.threadId, event);

  if (session.verbosity === "quiet") return;
  if (event.type === "assistant") {
    const thinking = extractThinkingStatus(event);
    if (thinking) {
      log.info("thinking", `thread=${session.threadId} ${thinking.slice(0, 200)}`);
    }
    const statuses = formatToolStatuses(event);
    for (const status of statuses) {
      log.info("tool", `thread=${session.threadId} ${status}`);
    }
  }
};

sessionManager.onSpawn = (session, info) => {
  ensureThread(session.threadId, session.channel);
  dashRecordSpawn(session.threadId, {
    pid: info.pid ?? -1,
    argv: info.argv,
    cwd: info.cwd,
    prompt: info.prompt,
    envKeys: info.envKeys,
    agentType: session.agentType,
    resumedSessionId: info.resumedSessionId,
    systemPromptFile: info.systemPromptFile,
    systemPromptContent: info.systemPromptContent,
  });
};

sessionManager.onMessageBuffered = (event) => {
  log.info("buffered", `thread=${event.threadId} user=${event.user}`);
  responder.addReaction(event.channel, event.ts, "eyes");
};

sessionManager.onCommandResponse = (event, response) => {
  log.info("command", `thread=${event.threadId} cmd=${event.command} response=${response.slice(0, 100)}`);
  responder.postResponse(event.channel, event.threadId, response);
};

sessionManager.onError = (session, error) => {
  log.error("error", `thread=${session.threadId} ${error ?? "Unknown error"}`);
  responder.deleteStatus(session.channel, session.threadId);
  // Detect silent-fail surface (manager.ts wraps with `_silent fail —`)
  const isSilent = typeof error === "string" && error.includes("silent fail");
  dashRecordError(session.threadId, error ?? "Unknown error", isSilent ? "silent_fail" : "error");
  responder.postResponse(
    session.channel,
    session.threadId,
    isSilent ? error! : `Error: ${error ?? "Unknown error"}`,
  );
};

registerHomeTab(app, store);

setupGracefulShutdown(sessionManager, store);

// Associative memory (engram): when recall or capture is on, keep the index
// current from memory/ on boot + every 6h. Incremental — only new/changed
// content is (re)embedded, so it's cheap even with a paid embedder. A full
// rebuild (e.g. after switching embedders) is a manual `index --fresh`.
if (engramRecallEnabled() || engramCaptureEnabled()) {
  reindexIncremental().then((ok) => log.info("engram", `boot reindex ${ok ? "ok" : "skipped"}`));
  setInterval(() => { reindexIncremental(); }, 6 * 60 * 60 * 1000);
  // Reindex promptly after any hand-written memory (agent or human), so curated
  // memories don't sit unrecallable until the next tick. Coalesced + fails soft.
  startMemoryWatch();
}

// Periodic health checks
setInterval(() => {
  checkOrphanedSessions(store).then((orphaned) => {
    if (orphaned.length > 0) {
      log.warn("health", `Found ${orphaned.length} orphaned sessions: ${orphaned.join(", ")}`);
    }
  });
}, 60_000);

setInterval(() => {
  cleanupStaleSessions(store, config.session.staleTimeoutMs).then((cleaned) => {
    if (cleaned.length > 0) {
      log.info("cleanup", `Removed ${cleaned.length} stale sessions: ${cleaned.join(", ")}`);
    }
  });

  // Disk-pressure worktree reaper: evict LRU clean worktrees once total disk
  // crosses the cap. Dirty ones are held and warned. Runs on the same cadence.
  reapWorktrees(worktreeManager, store, {
    diskCapBytes: config.worktree.diskCapBytes,
  })
    .then((r) => {
      if (r.evicted.length > 0) {
        log.info(
          "reaper",
          `Evicted ${r.evicted.length} worktree(s): ${r.evicted.map((w) => w.threadId).join(", ")}`,
        );
      }
    })
    .catch((err) => log.warn("reaper", `Worktree reap failed: ${err.message}`))
    // Refresh the dashboard's worktree picture after reaping (post-eviction).
    .finally(() => refreshWorktreeSummary());
}, config.session.cleanupIntervalMs);

/**
 * Push the current worktree disk picture (per-worktree dirty + disk, total vs
 * cap) to the live dashboard. Runs on boot and after each reap. Fails soft —
 * the dashboard just keeps the last picture if git/du hiccups.
 */
async function refreshWorktreeSummary(): Promise<void> {
  try {
    const sessions = await store.getAll();
    const activity = new Map<string, number>();
    for (const [tid, s] of sessions) activity.set(tid, s.lastActivity);
    const list = await worktreeManager.listAllWorktrees(activity);
    dashRecordWorktrees({
      list: list.map((w) => ({
        repoName: w.repoName,
        threadId: w.threadId,
        branch: w.branch,
        dirty: w.dirty,
        diskBytes: w.diskBytes,
        lastActivity: w.lastActivity,
      })),
      totalBytes: list.reduce((sum, w) => sum + w.diskBytes, 0),
      capBytes: config.worktree.diskCapBytes,
      updatedAt: Date.now(),
    });
  } catch (err) {
    log.warn("worktree", `dashboard summary refresh failed: ${(err as Error).message}`);
  }
}
// Seed the picture shortly after boot (don't block startup on git/du).
setTimeout(() => refreshWorktreeSummary(), 5_000).unref();

// Hard boot watchdog. Bolt's Socket Mode handshake can hang indefinitely
// when Slack's websocket is flaking — and the gentler Promise.race timeout
// turned out unreliable: 2026-05-13 a boot sat for 2h37m with stderr full
// of pong-timeout warnings and the timer never fired (a wedged event loop
// can starve user-space setTimeout callbacks). This watchdog is set BEFORE
// anything async runs, and uses os.kill(SIGKILL) which the kernel delivers
// regardless of event-loop state. If "Friday is running" isn't logged
// within BOOT_WATCHDOG_MS, the process dies hard and launchd respawns it.
let bootCompleted = false;
const BOOT_WATCHDOG_MS = 90_000;
const bootWatchdog = setTimeout(() => {
  if (bootCompleted) return;
  try {
    log.error("boot", `boot watchdog: still not running after ${BOOT_WATCHDOG_MS / 1000}s — SIGKILL self for launchd respawn`);
  } catch { /* logger may itself be wedged */ }
  process.kill(process.pid, "SIGKILL");
}, BOOT_WATCHDOG_MS);
// unref so a completed boot doesn't keep this timer alive past its purpose
bootWatchdog.unref();

(async () => {
  // Soft timeout race kept as the first line of defense — when it works
  // it gives us a clean exit log line and faster respawn.
  const BOOT_TIMEOUT_MS = 60_000;
  try {
    await Promise.race([
      app.start(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`app.start() timed out after ${BOOT_TIMEOUT_MS}ms`)), BOOT_TIMEOUT_MS),
      ),
    ]);
  } catch (err) {
    log.error("boot", `Slack Socket Mode handshake failed: ${err instanceof Error ? err.message : String(err)} — exiting for launchd respawn`);
    process.exit(1);
  }

  // Resolve bot identity before registering event handlers
  let selfBotId: string | undefined;
  try {
    const auth = await app.client.auth.test();
    if (auth.user_id) {
      sessionManager.botUserId = auth.user_id;
      log.info("boot", `Bot user ID: ${auth.user_id}`);
    }
    if (auth.bot_id) {
      selfBotId = auth.bot_id;
      log.info("boot", `Bot ID: ${auth.bot_id}`);
    }
  } catch (err) {
    log.warn("boot", `Failed to resolve bot identity: ${err}`);
  }

  registerEventHandlers(app, (event) => {
    log.info("event", `thread=${event.threadId} user=${event.user} cmd=${event.command ?? "-"} text=${event.text.slice(0, 100)}`);
    // Feed dashboard
    ensureThread(event.threadId, event.channel);
    dashRecordIncomingMessage(event.threadId, event.channel, event.user, event.text);
    if (event.routingHint) {
      dashRecordRouting(event.threadId, event.channel, event.routingHint, "auto");
    }
    // For auto-routed triggers (PR URL, bug report), ack immediately with 👀
    // so the sender knows Friday saw it — she may take a bit to produce output.
    if (event.routingHint === "pr-review" || event.routingHint === "bug-triage") {
      responder.addReaction(event.channel, event.ts, "eyes");
    }
    // Start the rotating-verb heartbeat so the user sees "✽ Pondering…" etc
    // immediately, and watches it tick every 1.5s until real content replaces
    // it (tool use, thinking, or the final response).
    if (!event.command) {
      responder.startHeartbeat(event.channel, event.threadId);
    }
    sessionManager.handleMessage(event);
  }, store, selfBotId, sessionManager.botUserId);

  // Unified HTTP server on config.http.port (default 3000):
  //   /         → chat/memory UI (public/index.html)
  //   /live     → live dashboard (Live/Threads/Files/Processes)
  //   /api/*    → chat, memory, sessions, dashboard state, files, processes
  //   /events   → SSE stream of dashboard updates
  if (config.http.enabled) {
    const { startHttpServer } = await import("./http/server.ts");
    startHttpServer({
      store,
      config,
      sessionManager,
      worktreeManager,
      refreshWorktrees: refreshWorktreeSummary,
    });
  }

  monitorSocketHealth(app);
  startNightlyDream({ hour: 3, minute: 0 });
  startDumpDigest(app);
  startStandupScheduler(app);

  log.info("boot", "Friday is running (Socket Mode)");
  bootCompleted = true;
  clearTimeout(bootWatchdog);

  // Graceful shutdown: SIGTERM (from launchctl kickstart -k or `launchctl stop`)
  // and SIGINT (Ctrl-C). Without this, the socket dies dirty and Slack keeps
  // tracking it — eventually triggering "too_many_websockets" on respawn.
  let shuttingDown = false;
  const cleanShutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutdown", `received ${signal} — closing Slack socket cleanly`);
    try {
      await Promise.race([
        app.stop(),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
    } catch (err) {
      log.warn("shutdown", `app.stop() failed during ${signal}: ${err}`);
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void cleanShutdown("SIGTERM"));
  process.on("SIGINT", () => void cleanShutdown("SIGINT"));
})();
