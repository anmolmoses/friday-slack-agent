#!/usr/bin/env bun
// One-off: re-render today's already-posted standup with the sanitizer fix.

import { App } from "@slack/bolt";
import { getState } from "../src/standup/state.ts";
import { sanitizeDraft } from "../src/standup/handler.ts";

const token = process.env.SLACK_BOT_TOKEN;
if (!token) {
  console.error("SLACK_BOT_TOKEN missing.");
  process.exit(1);
}

const app = new App({
  token,
  signingSecret: process.env.SLACK_SIGNING_SECRET ?? "",
});

const state = getState();
const today = Object.keys(state.history).sort().pop();
if (!today) {
  console.error("no history");
  process.exit(1);
}
const entry = state.history[today];
if (!entry.postedTo) {
  console.error("no postedTo");
  process.exit(1);
}

const fixed = sanitizeDraft(entry.finalText);
console.log("BEFORE:", JSON.stringify(entry.finalText));
console.log("AFTER:", JSON.stringify(fixed));

try {
  const upd = await app.client.chat.update({
    channel: entry.postedTo.channel,
    ts: entry.postedTo.ts,
    text: fixed,
  });
  console.log("update result:", upd.ok, upd.error ?? "");
  process.exit(0);
} catch (err) {
  console.log("update failed, trying delete + repost:", String(err).slice(0, 120));
}

try {
  const del = await app.client.chat.delete({
    channel: entry.postedTo.channel,
    ts: entry.postedTo.ts,
  });
  console.log("delete result:", del.ok, del.error ?? "");
} catch (err) {
  console.log("delete failed:", String(err).slice(0, 200));
  process.exit(1);
}

// Look up the focus-bot thread root (we have it in state if focus bot fired)
const focusTs = "1778133813.367419"; // best-effort; adjust if needed
const repost = await app.client.chat.postMessage({
  channel: entry.postedTo.channel,
  thread_ts: focusTs,
  text: fixed,
});
console.log("repost result:", repost.ok, repost.error ?? "", "ts=", repost.ts);
process.exit(0);
