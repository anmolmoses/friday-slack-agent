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
import { monitorSocketHealth } from "./slack/socket-health.ts";
import { startNightlyDream } from "./memory/scheduler.ts";
import { startDumpDigest } from "./dumps/scheduler.ts";
import { startStandupScheduler } from "./standup/scheduler.ts";
import { log } from "./logger.ts";

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
    if (isVibesChannel(session.channel)) {
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
  }
};

sessionManager.onEvent = (session, event) => {
  if (event.type === "system" && event.subtype === "init") {
    log.info("session", `thread=${session.threadId} sessionId=${session.sessionId}`);
  }
  if (session.verbosity === "quiet") return;
  if (event.type === "assistant") {
    // The Slack-facing status stays as the rotating thinking-verb heartbeat —
    // we DO NOT post per-tool ("📖 Reading X", "⚙️ git diff", "🔧 Using Y") or
    // per-thinking-snippet status updates anymore (Anmol's call: too noisy,
    // wants only the verb animation). We still log the same information for
    // operator visibility in friday-launchd.log.
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
  responder.postResponse(
    session.channel,
    session.threadId,
    `Error: ${error ?? "Unknown error"}`,
  );
};

registerHomeTab(app, store);

setupGracefulShutdown(sessionManager, store);

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
}, config.session.cleanupIntervalMs);

(async () => {
  await app.start();

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

  // Start HTTP dashboard server
  if (config.http.enabled) {
    const { startHttpServer } = await import("./http/server.ts");
    startHttpServer({ store, config });
  }

  monitorSocketHealth(app);
  startNightlyDream({ hour: 3, minute: 0 });
  startDumpDigest(app);
  startStandupScheduler(app);

  log.info("boot", "Friday is running (Socket Mode)");
})();
