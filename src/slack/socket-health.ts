import type { App } from "@slack/bolt";
import { log } from "../logger.ts";

/**
 * Observe-only health monitor. We log socket state transitions and track
 * time since last event so we can warn if Slack goes silent. Reconnection
 * is left to Bolt's native autoReconnectEnabled — forcing reconnects from
 * here races with Bolt and ends in a loop, so we don't.
 */
const STALE_WARN_MS = 5 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 1000;

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
  } else {
    log.warn("socket", "Receiver does not expose a SocketModeClient — skipping state listeners");
  }

  const interval = setInterval(async () => {
    try {
      await app.client.auth.test();
    } catch (err) {
      log.warn("socket", `auth.test probe failed: ${err}`);
      return;
    }
    const silentFor = Date.now() - lastActivityAt;
    if (silentFor > STALE_WARN_MS) {
      log.warn(
        "socket",
        `no socket activity for ${Math.round(silentFor / 1000)}s — Bolt will auto-reconnect if the ping timeout trips`,
      );
    }
  }, CHECK_INTERVAL_MS);

  process.on("beforeExit", () => clearInterval(interval));
}
