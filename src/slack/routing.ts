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
  | null;

export interface ChannelScope {
  prReview?: Set<string>; // channel IDs where auto PR review fires
  bugTriage?: Set<string>; // channel IDs where bug triage fires
}

// Channels for testing any of the routing behaviors — added to every trigger
// scope so Anmol can exercise PR review / bug triage / catchup in one place.
const TEST_CHANNELS = new Set<string>([
  "C0AUYJHK6UW", // Anmol's Friday sandbox
]);

// Channels where Friday replies to EVERY human message, no @mention required.
// Use sparingly — sandbox / vibes channels only.
const ALWAYS_REPLY_CHANNELS = new Set<string>([
  "C0AUYJHK6UW", // #fridaytest — Anmol's Friday sandbox
  "C0257TR1CD7", // #cafeteria — vibes channel, full send
]);

// Users Friday should never auto-reply to in always-reply channels (bosses).
// Source of truth: memory/people/slack-users.json `NO_REPLY: true`.
const NO_REPLY_USERS = new Set<string>([
  "U01AG6F9W69", // UD
  "U01AREQFVMJ", // AP
]);

// Friday's current active channels. These are easy to adjust later.
const PR_REVIEW_CHANNELS = new Set<string>([
  "C0AKQ2BFN9F", // #tech-pr-reviews
  ...TEST_CHANNELS,
]);

const BUG_TRIAGE_CHANNELS = new Set<string>([
  "C05557KKV37", // #bugs-backlog
  ...TEST_CHANNELS,
]);

// Users whose PR links Friday will auto-review. Bots are explicitly excluded.
const PR_REVIEW_TRUSTED_USERS = new Set<string>([
  "U09SZ4DM8TH", // Anmol
  "U03PNSJ33S5", // Pranav
  "U04U7RS55PS", // Alok
]);

// Bug report bot — always triage its posts
const BUG_REPORT_BOT_USER = "U0ANDM5M62Z";

const GITHUB_PR_RE = /https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/;

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
  // Skip bosses (UD/AP) — react-only territory, no auto-reply.
  if (ALWAYS_REPLY_CHANNELS.has(channel) && !NO_REPLY_USERS.has(user)) {
    if (matchesCatchup(text)) {
      return { shouldRoute: true, hint: "catchup", reason: "catchup-in-sandbox" };
    }
    return { shouldRoute: true, hint: null, reason: "always-reply-channel" };
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

  return null;
}
