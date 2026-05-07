import type { App } from "@slack/bolt";
import { log } from "../logger.ts";

/**
 * Active socket health check.
 *
 * Bolt's native autoReconnectEnabled is supposed to handle dropped websockets,
 * but in practice we've seen it leave the socket dead for 60+ minutes without
 * recovering — the ping/pong handshake gets stuck and `monitorSocketHealth`'s
 * earlier observe-only mode just escalated WARN logs while messages went
 * unreceived (events filed during the dead window are NOT replayed on reconnect,
 * they're lost). 2026-05-07: the a DM in a sandbox channel landed at 70s
 * before a manual kickstart and never reached Friday.
 *
 * This monitor now actively probes Slack via auth.test() each interval, tracks
 * websocket inactivity, and forces a process exit (KeepAlive respawns via
 * launchd) when the websocket has been silent past STALE_HARD_MS while Slack
 * itself is still reachable. We don't try to call client.disconnect()/start()
 * directly — Bolt's reconnect machinery races with that and we end in
 * inconsistent state. A clean exit + launchd respawn is bulletproof and the
 * downtime (~3s) is far less than the silent-socket failure mode.
 */
const CHECK_INTERVAL_MS = 30 * 1000;
const STALE_WARN_MS = 3 * 60 * 1000;   // start warning after 3 minutes silent
const STALE_HARD_MS = 10 * 60 * 1000;  // give up after 10 minutes; exit and let launchd respawn

interface SocketModeClientLike {
  on(event: string, fn: (...args: unknown[]) => void): void;
}

interface ReceiverLike {
  client?: SocketModeClientLike;
}

export function monitorSocketHealth(app: App): void {
  const receiver = (app as unknown as { receiver?: ReceiverLike }).receiver;
  const client = receiver?.client;

  let lastActivityAt = Date.now();

  if (client && typeof client.on === "function") {
    for (const state of [
      "connecting",
      "connected",
      "authenticated",
      "reconnecting",
      "disconnecting",
      "disconnected",
    ] as const) {
      client.on(state, () => {
        log.info("socket", `state=${state}`);
        lastActivityAt = Date.now();
      });
    }
    client.on("slack_event", () => {
      lastActivityAt = Date.now();
    });
    // CRITICAL: Slack sends keepalive pings every ~30s even when there's no
    // user activity. Without listening for them, an idle overnight window
    // looks identical to a wedged socket and we'd respawn every 3 min until
    // morning. 2026-05-08 incident: 10 launchd respawns between 01:46-06:04
    // killed today's standup kickoff timer (death by heartbeat, ironic).
    for (const heartbeat of [
      "ping",
      "pong",
      "slack_event_ack",
      "outgoing_message",
      "websocket_open",
      "websocket_close",
    ] as const) {
      client.on(heartbeat, () => {
        lastActivityAt = Date.now();
      });
    }
  } else {
    log.warn("socket", "Receiver does not expose a SocketModeClient — skipping state listeners");
  }

  const interval = setInterval(async () => {
    let slackReachable = false;
    try {
      await app.client.auth.test();
      slackReachable = true;
    } catch (err) {
      // Slack itself is unreachable (Slack outage / network split). Don't
      // exit — restarting wouldn't help and would just thrash. Just log.
      log.warn("socket", `auth.test probe failed: ${err}`);
    }
    const silentFor = Date.now() - lastActivityAt;
    if (silentFor > STALE_HARD_MS && slackReachable) {
      // Slack API works but our websocket has been silent for too long —
      // websocket is wedged. We need to respawn, but a naïve process.exit(1)
      // leaves Slack thinking our old socket is still alive — repeated
      // dirty exits trip the per-app socket limit and Slack starts rejecting
      // new connections with `{"type":"disconnect","reason":"too_many_websockets"}`.
      // 2026-05-11: 10+ dirty respawns in a row made every new boot deaf
      // because Slack wouldn't accept the new socket.
      //
      // Fix: cleanly stop the app first (sends WS close, Slack releases the
      // slot immediately), then sleep through launchd's ThrottleInterval so
      // the new instance doesn't hammer connections.open before Slack has
      // GC'd the slot.
      log.error(
        "socket",
        `websocket silent for ${Math.round(silentFor / 1000)}s while Slack API is reachable — clean-stopping and exiting for launchd respawn`,
      );
      try {
        await Promise.race([
          app.stop(),
          new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
        ]);
      } catch (err) {
        log.warn("socket", `app.stop() during clean-respawn failed: ${err}`);
      }
      // Brief cooldown so Slack's connection-tracker releases the slot
      // before launchd starts the next process and we open a new socket.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      process.exit(1);
    }
    if (silentFor > STALE_WARN_MS) {
      log.warn(
        "socket",
        `no socket activity for ${Math.round(silentFor / 1000)}s — will force respawn at ${Math.round(STALE_HARD_MS / 1000)}s if still silent`,
      );
    }
  }, CHECK_INTERVAL_MS);

  process.on("beforeExit", () => clearInterval(interval));
}
