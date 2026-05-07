#!/usr/bin/env bun
// One-off: fire the standup kickoff right now (out-of-band of the cron).
// Posts the question in #friday-test and persists state so the running
// Friday process recognizes the thread as the in-flight standup.

import { App } from "@slack/bolt";
import { kickoffStandup } from "../src/standup/scheduler.ts";

const token = process.env.SLACK_BOT_TOKEN;
if (!token) {
  console.error("SLACK_BOT_TOKEN missing — load .env first.");
  process.exit(1);
}

const app = new App({
  token,
  signingSecret: process.env.SLACK_SIGNING_SECRET ?? "",
});

const result = await kickoffStandup(app);
console.log("kickoff result:", result);
process.exit(0);
