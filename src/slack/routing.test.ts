import { describe, it, expect } from "bun:test";
import { evaluateRouting, matchesCatchup, hintPromptFragment } from "./routing.ts";

describe("evaluateRouting", () => {
  const PR_REVIEW_CHANNEL = "C0AKQ2BFN9F";
  const BUG_CHANNEL = "C05557KKV37";
  const ANMOL = "U09SZ4DM8TH";
  const PRANAV = "U03PNSJ33S5";
  const BUG_BOT = "U0ANDM5M62Z";
  const STRANGER = "UZZZZZZZZZ";

  it("routes PR URL from trusted user in review channel", () => {
    const r = evaluateRouting({
      channel: PR_REVIEW_CHANNEL,
      user: ANMOL,
      text: "please look at https://github.com/GrowthX-Club/gx-backend/pull/2942",
      isThreadRoot: true,
      mentionsFriday: false,
    });
    expect(r.shouldRoute).toBe(true);
    expect(r.hint).toBe("pr-review");
  });

  it("does not auto-route PR URL from strangers", () => {
    const r = evaluateRouting({
      channel: PR_REVIEW_CHANNEL,
      user: STRANGER,
      text: "https://github.com/foo/bar/pull/1",
      isThreadRoot: true,
      mentionsFriday: false,
    });
    expect(r.shouldRoute).toBe(false);
    expect(r.hint).toBe(null);
  });

  it("does not auto-route PR URL in unrelated channel", () => {
    const r = evaluateRouting({
      channel: "CXXXNOROUTE0",
      user: ANMOL,
      text: "https://github.com/foo/bar/pull/1",
      isThreadRoot: true,
      mentionsFriday: false,
    });
    expect(r.shouldRoute).toBe(false);
  });

  it("routes bug reports from the bug bot", () => {
    const r = evaluateRouting({
      channel: BUG_CHANNEL,
      user: BUG_BOT,
      text: ":bug: *Bug Report* — Other *From:* foo@bar.com",
      isThreadRoot: true,
      mentionsFriday: false,
    });
    expect(r.shouldRoute).toBe(true);
    expect(r.hint).toBe("bug-triage");
  });

  it("routes bug-report-looking messages from humans in the bug channel", () => {
    const r = evaluateRouting({
      channel: BUG_CHANNEL,
      user: PRANAV,
      text: "🐞 Bug Report from staging",
      isThreadRoot: true,
      mentionsFriday: false,
    });
    expect(r.shouldRoute).toBe(true);
    expect(r.hint).toBe("bug-triage");
  });

  it("routes catchup requests in any thread with Friday mentioned", () => {
    const r = evaluateRouting({
      channel: "C0257TR1CD7",
      user: ANMOL,
      text: "hey Friday, catch me up please",
      isThreadRoot: false,
      mentionsFriday: true,
    });
    expect(r.shouldRoute).toBe(true);
    expect(r.hint).toBe("catchup");
  });

  it("routes tldr in any message without mention", () => {
    const r = evaluateRouting({
      channel: "C0257TR1CD7",
      user: ANMOL,
      text: "tldr?",
      isThreadRoot: false,
      mentionsFriday: false,
    });
    expect(r.shouldRoute).toBe(true);
    expect(r.hint).toBe("catchup");
  });

  it("auto-replies to humans in cafeteria without a mention", () => {
    const r = evaluateRouting({
      channel: "C0257TR1CD7",
      user: PRANAV,
      text: "lol that meeting was wild",
      isThreadRoot: true,
      mentionsFriday: false,
    });
    expect(r.shouldRoute).toBe(true);
    expect(r.reason).toBe("always-reply-channel");
  });

  it("does not auto-reply to UD/AP in cafeteria", () => {
    const r = evaluateRouting({
      channel: "C0257TR1CD7",
      user: "U01AG6F9W69", // UD
      text: "team update",
      isThreadRoot: true,
      mentionsFriday: false,
    });
    expect(r.shouldRoute).toBe(false);
  });

  it("passes through normal mentions without a hint", () => {
    const r = evaluateRouting({
      channel: "C0257TR1CD7",
      user: ANMOL,
      text: "hey friday",
      isThreadRoot: false,
      mentionsFriday: true,
    });
    expect(r.shouldRoute).toBe(true);
    expect(r.hint).toBe(null);
  });
});

describe("matchesCatchup", () => {
  it("catches common phrasings", () => {
    expect(matchesCatchup("catch me up pls")).toBe(true);
    expect(matchesCatchup("TLDR")).toBe(true);
    expect(matchesCatchup("give me a summary")).toBe(true);
    expect(matchesCatchup("summarize this thread")).toBe(true);
    expect(matchesCatchup("where are we")).toBe(true);
    expect(matchesCatchup("what's going on")).toBe(true);
  });
  it("ignores unrelated phrasings", () => {
    expect(matchesCatchup("normal message")).toBe(false);
    expect(matchesCatchup("summary judgment")).toBe(false);
  });
});

describe("hintPromptFragment", () => {
  it("includes the PR URL when pr-review hint fires", () => {
    const frag = hintPromptFragment("pr-review", "see https://github.com/a/b/pull/7");
    expect(frag).toContain("github.com/a/b/pull/7");
    expect(frag).toContain("review-pr skill");
  });
  it("returns null for no hint", () => {
    expect(hintPromptFragment(null, "hi")).toBe(null);
  });
});
