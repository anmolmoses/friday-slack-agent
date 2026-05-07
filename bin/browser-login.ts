#!/usr/bin/env bun
/**
 * One-time (and occasional re-)login for Friday's persistent browser profile.
 *
 * Friday's Playwright MCP runs HEADLESS against a persistent profile at
 * ~/.friday/browser-profile (see src/claude/mcp-config.ts). A headless browser
 * can't do an interactive SSO login, so this opens that SAME profile in a
 * HEADED window. Log into whatever Friday needs to reach — GX Team SSO, Notion,
 * Google — across the tabs that open, then just close the browser. The cookies
 * persist in the profile, so every subsequent headless MCP run is already
 * authenticated and can open gated pages.
 *
 * Re-run whenever a session expires and Friday starts hitting login walls:
 *   bun bin/browser-login.ts
 *
 * IMPORTANT: a profile dir can only be opened by one Chromium at a time. Don't
 * run this while the bot is mid-browse — stop the bot (or ensure no thread is
 * driving the browser), log in, close the window, then restart.
 */
import os from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const PROFILE_DIR = path.join(os.homedir(), ".friday", "browser-profile");

// Sign into these in one sitting. Add your own GX/internal URLs.
const START_URLS = [
  "https://www.notion.so/login",
  "https://accounts.google.com",
];

mkdirSync(PROFILE_DIR, { recursive: true });

console.log(`Opening Friday's persistent browser profile (headed):\n  ${PROFILE_DIR}\n`);
console.log("Log into GX Team SSO / Notion / Google in the tabs that open,");
console.log("then CLOSE the browser window. Friday reuses the session from here on.\n");

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  viewport: null,
});

for (const url of START_URLS) {
  const page = await context.newPage();
  await page.goto(url).catch((e) => console.warn(`  (couldn't open ${url}: ${e.message})`));
}
// launchPersistentContext opens one blank page too; close it so only logins show.
const [blank] = context.pages();
if (blank && blank.url() === "about:blank") await blank.close().catch(() => {});

// Stay alive until the user closes the browser.
await new Promise<void>((resolve) => context.on("close", () => resolve()));
console.log("\nBrowser closed. Session saved to the profile. ✅");
process.exit(0);
