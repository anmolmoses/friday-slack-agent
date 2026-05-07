import type { App } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { log } from "../logger.ts";
import { istDate } from "../dumps/store.ts";
import {
  FOCUS_BOT_ID,
  FRIDAY_TEST_CHANNEL,
  STANDUP_CHANNEL,
} from "./types.ts";
import {
  archive,
  getMostRecentPrior,
  getPending,
  setPending,
  updatePending,
} from "./state.ts";
import { parseStandup } from "./formatter.ts";

// Phrases that approve the current standup draft and trigger the actual
// post into the focus-bot thread (as the user via SLACK_USER_TOKEN). We've
// lost standups because the user said "send this to the standup bot as me"
// and the older list only matched the literal "ship/post it/approve" set.
// 2026-05-08 incident: the user's natural-language approval got treated as a
// regular message and Friday just echoed the draft instead of posting it.
const APPROVAL_PHRASES = [
  /\bapproved?\b/i,                               // approve / approved
  /\bpost (it|this|that|as me|on my behalf)\b/i,  // post it / post as me
  /\bsend (it|this|that|to (the )?standup|as me|on my behalf)\b/i,
  /\bship (it|this|that)?\b/i,
  /\bgo (ahead|for it)\b/i,
  /\bdo it\b/i,
  /\blgtm\b/i,
  /\b(looks |is )?good\b/i,
  /^\s*(yes|yep|yup|sure|ok|okay|aight)\s*[.!]?\s*$/i, // bare affirmation
  /^\s*👍\s*$/,
  /^\s*✅\s*$/,
];

export function isApproval(text: string): boolean {
  if (!text) return false;
  return APPROVAL_PHRASES.some((re) => re.test(text));
}

/**
 * True when `threadId` is the active standup kickoff thread (the one Friday
 * posted "Focus for the day…" in). Standup channel C_SANDBOX is also a
 * vibes channel, so without this check the vibes-lint 3-line cap would
 * truncate Friday's multi-line standup draft (the *Yesterday* / *Today*
 * blocks are inherently multi-line). Used by index.ts onResponse to skip
 * vibes-lint inside the standup thread.
 */
export function isStandupThread(threadId: string): boolean {
  if (!threadId) return false;
  const pending = getPending();
  if (!pending) return false;
  return pending.fridayTestThreadTs === threadId;
}

/**
 * If the message is from the focus bot in the standup channel, capture the
 * thread ts. If a draft has already been approved, post it immediately.
 * Returns true if we handled the event (caller should stop further routing).
 */
export async function handleFocusBotMessage(
  app: App,
  event: {
    channel: string;
    ts: string;
    thread_ts?: string;
    bot_id?: string;
    botId?: string;
  },
): Promise<boolean> {
  if (event.channel !== STANDUP_CHANNEL) return false;
  const botId = event.bot_id ?? event.botId;
  if (botId !== FOCUS_BOT_ID) return false;
  // Only the thread root counts — replies to an existing standup thread
  // shouldn't reset our captured ts.
  if (event.thread_ts && event.thread_ts !== event.ts) return false;

  const pending = getPending();
  if (!pending || pending.date !== istDate()) {
    log.info(
      "standup/handler",
      `focus bot posted but no pending standup (status=${pending?.status ?? "none"}) — NOT inventing one`,
    );
    // Do NOT create a phantom "awaiting-input" pending state. The previous
    // behavior here did exactly that, which then made the scheduler skip
    // the next day's kickoff with "already in flight". 2026-05-08:
    // a missed kickoff (heartbeat-respawn loop killed today's timer) plus
    // a focus-bot post created phantom state that would've blocked Mon
    // too. If there's no pending standup, the focus-bot's thread ts is
    // not useful — there's nothing to post into it. Just log and bail.
    if (pending && pending.date !== istDate()) {
      // Stale prior-day pending — clear it so tomorrow can fire cleanly.
      log.info(
        "standup/handler",
        `clearing stale prior-day pending standup (date=${pending.date} status=${pending.status})`,
      );
      setPending(undefined);
    }
    return true;
  }

  updatePending((p) => ({ ...p, focusBotThreadTs: event.ts }));
  log.info("standup/handler", `captured focus bot thread ts=${event.ts}`);

  if (pending.status === "approved") {
    await postApprovedToStandup(app, event.ts);
  }
  return true;
}

/**
 * Detect approval in a friday-test message inside the standup kickoff thread.
 * If approved, mark state, fetch the latest Friday draft from the thread,
 * and (if the focus bot thread is known) post it.
 *
 * Returns true if Friday should NOT spawn a normal Claude turn for this
 * message (because we handled it as approval).
 */
export async function handleFridayTestMessage(
  app: App,
  event: {
    channel: string;
    user: string;
    text: string;
    ts: string;
    thread_ts?: string;
  },
  selfBotId: string | undefined,
): Promise<boolean> {
  if (event.channel !== FRIDAY_TEST_CHANNEL) return false;
  if (!event.thread_ts) return false;

  const pending = getPending();
  if (!pending || pending.fridayTestThreadTs !== event.thread_ts) return false;
  if (!isApproval(event.text)) return false;

  const draft = await fetchLatestFridayDraft(
    app,
    event.channel,
    event.thread_ts,
    selfBotId,
  );

  if (!draft) {
    await app.client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.thread_ts,
      text: `I don't have a draft yet — give me your update first and I'll format it.`,
    });
    return true;
  }

  updatePending((p) => ({
    ...p,
    status: "approved",
    approvedAt: new Date().toISOString(),
    finalText: draft,
  }));
  log.info("standup/handler", `approved (draft len=${draft.length})`);

  const refreshed = getPending();
  if (refreshed?.focusBotThreadTs) {
    await postApprovedToStandup(app, refreshed.focusBotThreadTs);
  } else {
    await app.client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.thread_ts,
      text: `Approved. Holding the post until the focus bot posts in <#${STANDUP_CHANNEL}> — I'll drop it in there as soon as it shows up.`,
    });
  }
  return true;
}

/**
 * Returns a WebClient that posts AS the user (user token) when SLACK_USER_TOKEN
 * is present, falling back to the bot client. Used only for the final
 * standup-channel post — everything else stays as Friday.
 */
function userClient(app: App): WebClient {
  const userToken = process.env.SLACK_USER_TOKEN;
  if (!userToken) return app.client;
  return new WebClient(userToken);
}

async function postApprovedToStandup(
  app: App,
  focusBotThreadTs: string,
): Promise<void> {
  const pending = getPending();
  if (!pending?.finalText) return;
  if (pending.status === "posted") return;

  const finalText = sanitizeDraft(pending.finalText);
  const usingUserToken = !!process.env.SLACK_USER_TOKEN;

  try {
    const resp = await userClient(app).chat.postMessage({
      channel: STANDUP_CHANNEL,
      thread_ts: focusBotThreadTs,
      text: finalText,
    });
    if (!resp.ok) {
      log.error("standup/handler", `post to standup failed: ${resp.error}`);
      return;
    }
    log.info(
      "standup/handler",
      `posted to standup channel=${STANDUP_CHANNEL} thread=${focusBotThreadTs} as=${usingUserToken ? "user" : "bot"}`,
    );

    archive({
      date: pending.date,
      sections: parseStandup(finalText),
      finalText,
      postedTo: { channel: STANDUP_CHANNEL, ts: resp.ts ?? "" },
      postedAt: new Date().toISOString(),
    });

    if (pending.fridayTestThreadTs) {
      const note = usingUserToken
        ? `✅ Posted to <#${STANDUP_CHANNEL}> (as you).`
        : `✅ Posted to <#${STANDUP_CHANNEL}>.`;
      await app.client.chat.postMessage({
        channel: FRIDAY_TEST_CHANNEL,
        thread_ts: pending.fridayTestThreadTs,
        text: note,
      });
    }
  } catch (err) {
    log.error("standup/handler", `post failed: ${err}`);
  }
}

/** Fetch the most recent message Friday posted in the given thread. */
async function fetchLatestFridayDraft(
  app: App,
  channel: string,
  threadTs: string,
  selfBotId: string | undefined,
): Promise<string | null> {
  try {
    const resp = await app.client.conversations.replies({
      channel,
      ts: threadTs,
      limit: 100,
    });
    const messages = (resp.messages ?? []) as Array<{
      bot_id?: string;
      text?: string;
      ts?: string;
    }>;
    const fridayMsgs = messages.filter(
      (m) => m.bot_id && (!selfBotId || m.bot_id === selfBotId) && m.text,
    );
    if (fridayMsgs.length === 0) return null;
    // Skip the kickoff (always the first message Friday posted, the
    // "Focus for the day …" prompt) and "Approved/Holding" status pings —
    // we want her actual draft.
    const drafts = fridayMsgs.filter(
      (m) =>
        m.text &&
        !/^\*Focus for the day/.test(m.text) &&
        !/^✅ Posted to/.test(m.text) &&
        !/^Approved\. Holding/.test(m.text) &&
        !/I don't have a draft yet/.test(m.text),
    );
    if (drafts.length === 0) return null;
    const raw = drafts[drafts.length - 1].text ?? null;
    return raw ? sanitizeDraft(raw) : null;
  } catch (err) {
    log.warn("standup/handler", `replies fetch failed: ${err}`);
    return null;
  }
}

/**
 * If Claude wrapped the entire draft in a code fence, unwrap it so Slack
 * renders bold/blockquote instead of showing raw asterisks. Also strips
 * common preambles like "Here's the standup:".
 */
export function sanitizeDraft(text: string): string {
  let out = text.trim();

  // Slack's conversations.replies returns text with HTML entities escaped
  // (`&gt;`, `&lt;`, `&amp;`). Decode so we re-post raw mrkdwn that Slack will
  // render (otherwise blockquotes break).
  out = out
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");

  // Unwrap a single enclosing fenced block FIRST (before prose stripping):
  // ```\n...\n``` with optional language tag.
  const fenced = /^```(?:[a-zA-Z]+)?\s*\n([\s\S]*?)\n```\s*$/.exec(out);
  if (fenced) out = fenced[1].trim();

  // Strip a leading prose intro ("Here's the standup:" etc) before the first
  // *Yesterday* / *Today* heading.
  const firstSection = out.search(/^\s*\*(Yesterday|Today)\*/m);
  if (firstSection > 0) {
    out = out.slice(firstSection);
  }

  // Strip a trailing fence remnant if one slipped through.
  out = out.replace(/\n?```\s*$/, "");

  return out.trim();
}

/**
 * If the message lands in the in-flight standup thread, return a preamble
 * to prepend to Friday's prompt so she knows the workflow + format. Returns
 * null when not applicable.
 */
export function buildStandupPreamble(
  channel: string,
  threadId: string,
): string | null {
  if (channel !== FRIDAY_TEST_CHANNEL) return null;
  const pending = getPending();
  if (!pending || pending.fridayTestThreadTs !== threadId) return null;
  if (pending.status === "posted" || pending.status === "skipped") return null;

  const prior = getMostRecentPrior(pending.date);
  const priorBlock = prior
    ? `\nYesterday's standup (${prior.date}) — carry items forward, marking each task '✅' if the user says it's done:\n\`\`\`\n${prior.finalText}\n\`\`\`\n`
    : "";

  const directory = loadPeopleDirectory();
  const directoryBlock = directory
    ? `\n### Slack user directory — when the user writes "@Name", convert to the Slack mention syntax \`<@USERID>\` so it renders as a real @mention:\n${directory}\n\nIf he names someone NOT in this list, leave the literal "@Name" — don't invent a user ID.\n`
    : "";

  return [
    `## STANDUP WORKFLOW`,
    ``,
    `You are in the daily standup workflow with the user in <#${FRIDAY_TEST_CHANNEL}>. Your single job here is to draft a standup post in the exact format below, iterate based on his feedback, and wait for him to say "approved" / "post it" / "ship it" — I (the orchestrator) will handle the actual cross-channel post; you do NOT post to the standup channel yourself.`,
    ``,
    `### Format (Slack mrkdwn — match exactly):`,
    `The example below is delimited by ===EXAMPLE-START=== and ===EXAMPLE-END===.`,
    `Output the BODY of the example only — do NOT include the delimiter lines, do NOT wrap your output in triple backticks, do NOT wrap it in a code fence, do NOT prefix with "Here's the standup:". Emit the raw Slack mrkdwn directly so Slack renders the bold/blockquote.`,
    ``,
    `===EXAMPLE-START===`,
    `*Yesterday*`,
    `> *Topic A* ✅`,
    `• task one ✅`,
    `• task two ✅`,
    ``,
    `> *Topic B* ✅`,
    `• task three ✅`,
    ``,
    `*Today*`,
    `> *Topic C*`,
    `• task four`,
    `• task five`,
    `===EXAMPLE-END===`,
    ``,
    `Rules:`,
    `- Two sections, in this order: \`*Yesterday*\` then \`*Today*\`. Each is a bold heading on its own line.`,
    `- Under each section, group tasks into topics. Topic line: \`> *Title*\` (bold inside a blockquote). Topics are short (2–4 words).`,
    `- Each task: \`• <text>\`.`,
    `- ✅ rules:`,
    `  - *Yesterday* contains ONLY completed items. Every task gets a \` ✅\`. Every topic in Yesterday gets \` ✅\` after the title.`,
    `  - If the user started something yesterday but didn't finish it, that work-in-progress task goes in *Today* as a planned task — NOT in Yesterday.`,
    `  - *Today* never has ✅ (those are plans, not done yet).`,
    `- One blank line between topics; one blank line between the *Yesterday* and *Today* sections.`,
    `- the user may give vague input — infer reasonable topic names from the work he describes.`,
    `- If it's unclear whether something is done or still in-progress, ask one short clarifying question OR make a best guess and let him correct on review.`,
    `- @mentions are fine (\`<@USERID>\` or \`@Name\`).`,
    `- Keep it tight — section headings + topics + tasks only. No preamble, no commentary, no signoff.`,
    priorBlock,
    directoryBlock,
    `### What to output`,
    `- On the user's first content message in this thread: produce ONLY the formatted standup with both sections. No surrounding text. No "Here's a draft:".`,
    `- On follow-up edit feedback: produce ONLY the revised standup.`,
    `- If he says "approved" / "post it" / "ship it" — handled by the orchestrator before you run; you won't see it.`,
    `- If he's missing critical info (no clue what to write), ask exactly one short clarifying question instead of producing a draft.`,
    `- If the user says he didn't work on anything / wants to skip, output the literal sentinel \`NO_REPLY\` (Friday's silence marker) — orchestrator will not post anything anywhere.`,
    ``,
    `### Repos available for context (only inspect if his input is genuinely insufficient):`,
    `- Listed via the regular tooling. Prefer his words; only check git activity as a tiebreaker.`,
    ``,
    `Now respond to the user's latest message.`,
  ].join("\n");
}

interface SlackUser {
  name: string;
  type?: string;
  role?: string;
  NO_REPLY?: boolean;
}

/**
 * Load the Slack user directory so Friday can convert "@Arjan" → `<@U…>` in
 * the standup. Returns "" when the file is missing (don't break the flow).
 */
function loadPeopleDirectory(): string {
  const file = path.resolve(
    import.meta.dir,
    "..",
    "..",
    "memory",
    "people",
    "slack-users.json",
  );
  if (!existsSync(file)) return "";
  try {
    const data = JSON.parse(readFileSync(file, "utf-8")) as Record<string, SlackUser>;
    const lines: string[] = [];
    for (const [id, user] of Object.entries(data)) {
      if (user.NO_REPLY) continue;
      lines.push(`- ${user.name} → \`<@${id}>\``);
    }
    return lines.join("\n");
  } catch (err) {
    log.warn("standup/handler", `loadPeopleDirectory failed: ${err}`);
    return "";
  }
}

/** Mark current standup as draft-in-progress when a non-approval message arrives. */
export function noteDrafting(channel: string, threadId: string): void {
  if (channel !== FRIDAY_TEST_CHANNEL) return;
  const pending = getPending();
  if (!pending || pending.fridayTestThreadTs !== threadId) return;
  if (pending.status === "awaiting-input") {
    updatePending((p) => ({ ...p, status: "drafting" }));
  }
}
