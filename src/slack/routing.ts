/**
 * Pattern-based Slack event routing. Decides whether a message that wouldn't
 * otherwise trigger Friday (no @mention, no existing session) should still
 * route to her because it matches a known pattern — and tags the event with
 * a `routingHint` the prompt builder uses to give Friday clear instructions.
 */

export type RoutingHint =
  | "pr-review"
  | "bug-triage"
  | "catchup"
  | "vibes"
  | null;

export interface ChannelScope {
  prReview?: Set<string>; // channel IDs where auto PR review fires
  bugTriage?: Set<string>; // channel IDs where bug triage fires
}

// Channels for testing any of the routing behaviors — added to every trigger
// scope so the user can exercise PR review / bug triage / catchup in one place.
const TEST_CHANNELS = new Set<string>([
  "C_SANDBOX", // the user's Friday sandbox
]);

// Channels where Friday replies to EVERY human message, no @mention required.
// Use sparingly — sandbox / vibes channels only.
const ALWAYS_REPLY_CHANNELS = new Set<string>([
  "C_SANDBOX", // a sandbox channel — the user's Friday sandbox
  "C_VIBES", // a vibes channel — vibes channel, full send
]);

/**
 * True when the channel is a vibes/sandbox channel — short replies, no
 * essays, hard message cap. Used by the post-path lint and spiral detector.
 */
export function isVibesChannel(channel: string): boolean {
  return ALWAYS_REPLY_CHANNELS.has(channel);
}

// Users Friday should never auto-reply to in always-reply channels (bosses).
// Source of truth: memory/people/slack-users.json `NO_REPLY: true`.
const NO_REPLY_USERS = new Set<string>([
  "U_DEV1", // dev
  "U_DEV2", // dev
]);

// Friday's current active channels. These are easy to adjust later.
const PR_REVIEW_CHANNELS = new Set<string>([
  "C_PR_REVIEW", // #tech-pr-reviews
  ...TEST_CHANNELS,
]);

const BUG_TRIAGE_CHANNELS = new Set<string>([
  "C_BUG", // #bugs-backlog
  ...TEST_CHANNELS,
]);

// Users whose PR links Friday will auto-review. Bots are explicitly excluded.
const PR_REVIEW_TRUSTED_USERS = new Set<string>([
  "U_OWNER", // the user
  "U_TEAMMATE", // a teammate
  "U_DEV3", // dev
]);

// Bug report bot — always triage its posts
const BUG_REPORT_BOT_USER = "U_BUG_BOT";

const GITHUB_PR_RE = /https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/;

// Any github.com/<owner>/<repo> reference — used to infer which configured
// repo a thread is about (so natural-language "review <PR-url>" gets the same
// worktree isolation as an explicit !repo).
const GITHUB_REPO_RE = /github\.com\/[^/\s]+\/([^/\s#?)\]]+)/gi;

/**
 * Find the first GitHub repo named in `text` that matches one of `knownRepos`
 * (case-insensitive, `.git` stripped). Returns the canonical configured name,
 * or null when nothing matches.
 */
export function inferRepoFromText(
  text: string,
  knownRepos: string[],
): string | null {
  if (!text) return null;
  const byLower = new Map(knownRepos.map((r) => [r.toLowerCase(), r]));
  for (const m of text.matchAll(GITHUB_REPO_RE)) {
    const repo = m[1]?.replace(/\.git$/, "").toLowerCase();
    if (repo && byLower.has(repo)) return byLower.get(repo)!;
  }
  return null;
}

const CATCHUP_PATTERNS: RegExp[] = [
  /\bcatch\s*me\s*up\b/i,
  /\bcatch\s*up\b/i,
  /\btl;?dr\b/i,
  /\bsummari[sz]e\s+(?:this\s+|the\s+)?(?:thread|convo|conversation)\b/i,
  /\bgive (me )?(a )?summary\b/i,
  /\bwhat['’]s going on\b/i,
  /\bwhere are we\b/i,
];

export interface RoutingDecision {
  shouldRoute: boolean;
  hint: RoutingHint;
  reason: string;
}

export interface RoutingInput {
  channel: string;
  user: string;
  text: string;
  isThreadRoot: boolean; // true when this is the parent (not a reply)
  mentionsFriday: boolean;
}

/**
 * Evaluate a message and decide whether Friday should handle it proactively,
 * even when she wasn't @mentioned.
 */
export function evaluateRouting(input: RoutingInput): RoutingDecision {
  const { channel, user, text, mentionsFriday } = input;

  if (mentionsFriday) {
    // Explicit @ Friday — the handler already routes. But if the mention
    // looks like a catchup, tag it so the prompt builder can emphasize.
    if (matchesCatchup(text)) {
      return { shouldRoute: true, hint: "catchup", reason: "catchup-mention" };
    }
    return { shouldRoute: true, hint: null, reason: "explicit-mention" };
  }

  // Sandbox/vibes channels — always engage, no @mention needed.
  // Skip bosses (senior users) — react-only territory, no auto-reply.
  if (ALWAYS_REPLY_CHANNELS.has(channel) && !NO_REPLY_USERS.has(user)) {
    if (matchesCatchup(text)) {
      return { shouldRoute: true, hint: "catchup", reason: "catchup-in-sandbox" };
    }
    return { shouldRoute: true, hint: "vibes", reason: "always-reply-channel" };
  }

  // Auto PR review in the review channel
  if (PR_REVIEW_CHANNELS.has(channel) && PR_REVIEW_TRUSTED_USERS.has(user)) {
    if (GITHUB_PR_RE.test(text)) {
      return { shouldRoute: true, hint: "pr-review", reason: "pr-url-in-review-channel" };
    }
  }

  // Auto bug triage in bug channel. Match the bug bot by user, OR a message
  // that LOOKS like a structured bug report — must START with the bug glyph
  // so casual mentions of "bug report" in chat don't trigger.
  if (BUG_TRIAGE_CHANNELS.has(channel)) {
    const looksStructured = /^[\s>*_]*(:bug:|🐞)/.test(text)
      || /^[\s>*_]*\*?Bug Report\*?\b/i.test(text);
    if (user === BUG_REPORT_BOT_USER || looksStructured) {
      return { shouldRoute: true, hint: "bug-triage", reason: "bug-report-detected" };
    }
  }

  // Universal catchup: if the message explicitly asks for one
  if (matchesCatchup(text)) {
    return { shouldRoute: true, hint: "catchup", reason: "catchup-phrase" };
  }

  return { shouldRoute: false, hint: null, reason: "no-match" };
}

export function matchesCatchup(text: string): boolean {
  return CATCHUP_PATTERNS.some((re) => re.test(text));
}

/**
 * Return a system-prompt fragment tailored to the routing hint. Injected into
 * Friday's prompt when the event is auto-routed so she knows what she's being
 * asked to do.
 */
export function hintPromptFragment(hint: RoutingHint, text: string): string | null {
  if (!hint) return null;

  if (hint === "pr-review") {
    const url = text.match(GITHUB_PR_RE)?.[0];
    return [
      "## AUTO TRIGGER: PR REVIEW",
      "This message was auto-routed because a GitHub PR URL appeared in #tech-pr-reviews.",
      url ? `PR URL: ${url}` : "",
      "Behaviour:",
      "- React with 👀 in the channel so the sender knows you saw it.",
      "- Use the review-pr skill (or equivalent) to run the review.",
      "- Post inline comments on the PR itself, not a wall of text in Slack.",
      "- When done, post a ≤4-line verdict summary in the thread: overall stance + top issues.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (hint === "bug-triage") {
    return [
      "## AUTO TRIGGER: BUG TRIAGE",
      "This message was auto-routed because a bug report landed in #bugs-backlog.",
      "Behaviour:",
      "- React with 👀 on the top-level bug message.",
      "- Reply in the THREAD (not the channel) with a compact triage:",
      "  1. Parsed **area** (extract from the bug body or infer from the URL).",
      "  2. **Severity guess** (P0/P1/P2/P3) with one-line justification.",
      "  3. **Possible duplicates**: use bin/memory-search or grep memory/daily for prior similar bugs; cite at most 2 with date + one-line summary.",
      "  4. **Suggested owner** based on area (backend / frontend / admin / payments).",
      "- DO NOT file anything to GitHub or close the bug. Humans still drive action.",
      "- Keep the triage ≤ 10 lines. One post, no back-and-forth.",
    ].join("\n");
  }

  if (hint === "catchup") {
    return [
      "## AUTO TRIGGER: THREAD CATCHUP",
      "You were asked to summarize this thread / catch someone up.",
      "Behaviour:",
      "- Read the full thread history that was included in the prompt preamble.",
      "- Produce a ≤ 8-bullet summary structured as:",
      "  * **What happened** (≤ 4 bullets, chronological)",
      "  * **Open questions** (unanswered asks)",
      "  * **Pending on**: person → thing they owe",
      "- Keep the tone neutral and factual. No roasting, no filler.",
      "- One message, no follow-ups unless asked.",
    ].join("\n");
  }

  if (hint === "vibes") {
    // Operational signals only — tone, length, emoji, voice all live in
    // friday-personal/SOUL.md (the personality dial, the casual-check-in
    // table row, the emoji-as-punctuation rule). Don't re-prescribe them
    // here or this fragment will fight SOUL.md.
    return [
      "## AUTO TRIGGER: VIBES CHANNEL",
      "This is a vibes / sandbox channel where you chime in by default (e.g. a vibes channel, a sandbox channel). You were NOT @mentioned — you're auto-routed because that's the channel norm.",
      "Operational rules (your voice/tone is already defined in SOUL.md — use it):",
      "- **Exactly ONE Slack message per turn.** No double-posts. No follow-up `[6:45 PM]`-style appendices, fake timestamps, or simulated continuations. The post path will truncate anything that looks like multiple messages.",
      "- **Hard cap: 3 lines.** If your draft is longer, cut it. Anything past 3 lines gets truncated server-side — spend the budget on the punchline, not the windup.",
      "- Do NOT use the `NO_SLACK_MESSAGE` sentinel here. In a vibes channel, staying silent IS the failure mode — engagement is the whole point.",
      "- Do NOT dispatch sub-Claudes, open worktrees, run lint/tests, or write to memory. This is small-talk, not a task. One reply, ship it.",
      "- Do NOT repeat yourself. If you already replied upthread, only chime in again if a new message clearly opens a door.",
      "- A real spiral incident is the canonical scar: ~20 self-deprecating posts chasing a teammate's bait. Don't replay it. The spiral IS the bait — engagement = points scored on you.",
    ].join("\n");
  }

  return null;
}
