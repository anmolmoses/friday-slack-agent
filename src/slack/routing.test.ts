import { describe, it, expect } from "bun:test";
import { evaluateRouting, matchesCatchup, hintPromptFragment, inferRepoFromText } from "./routing.ts";

describe("evaluateRouting", () => {
  const PR_REVIEW_CHANNEL = "C_PR_REVIEW";
  const BUG_CHANNEL = "C_BUG";
  const OWNER = "U_OWNER";
  const TEAMMATE = "U_TEAMMATE";
  const BUG_BOT = "U_BUG_BOT";
  const STRANGER = "UZZZZZZZZZ";

  it("routes PR URL from trusted user in review channel", () => {
    const r = evaluateRouting({
      channel: PR_REVIEW_CHANNEL,
      user: OWNER,
      text: "please look at https://github.com/Example-Club/example-backend/pull/2942",
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
      user: OWNER,
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
      user: TEAMMATE,
      text: "🐞 Bug Report from staging",
      isThreadRoot: true,
      mentionsFriday: false,
    });
    expect(r.shouldRoute).toBe(true);
    expect(r.hint).toBe("bug-triage");
  });

  it("routes catchup requests in any thread with Friday mentioned", () => {
    const r = evaluateRouting({
      channel: "C_VIBES",
      user: OWNER,
      text: "hey Friday, catch me up please",
      isThreadRoot: false,
      mentionsFriday: true,
    });
    expect(r.shouldRoute).toBe(true);
    expect(r.hint).toBe("catchup");
  });

  it("routes tldr in any message without mention", () => {
    const r = evaluateRouting({
      channel: "C_VIBES",
      user: OWNER,
      text: "tldr?",
      isThreadRoot: false,
      mentionsFriday: false,
    });
    expect(r.shouldRoute).toBe(true);
    expect(r.hint).toBe("catchup");
  });

  it("auto-replies to humans in a vibes channel without a mention", () => {
    const r = evaluateRouting({
      channel: "C_VIBES",
      user: TEAMMATE,
      text: "lol that meeting was wild",
      isThreadRoot: true,
      mentionsFriday: false,
    });
    expect(r.shouldRoute).toBe(true);
    expect(r.reason).toBe("always-reply-channel");
  });

  it("does not auto-reply to senior users in a vibes channel", () => {
    const r = evaluateRouting({
      channel: "C_VIBES",
      user: "U_DEV1", // dev
      text: "team update",
      isThreadRoot: true,
      mentionsFriday: false,
    });
    expect(r.shouldRoute).toBe(false);
  });

  it("passes through normal mentions without a hint", () => {
    const r = evaluateRouting({
      channel: "C_VIBES",
      user: OWNER,
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

describe("inferRepoFromText", () => {
  const REPOS = ["example-backend", "example-web", "example-admin"];

  it("infers the repo from a GitHub PR URL", () => {
    expect(
      inferRepoFromText("review https://github.com/Example-Club/example-web/pull/5141", REPOS),
    ).toBe("example-web");
  });
  it("infers from a plain repo URL (no /pull)", () => {
    expect(
      inferRepoFromText("see github.com/Example-Club/example-backend for context", REPOS),
    ).toBe("example-backend");
  });
  it("strips a trailing .git and matches case-insensitively", () => {
    expect(
      inferRepoFromText("clone https://github.com/Example-Club/Example-Backend.git", REPOS),
    ).toBe("example-backend");
  });
  it("returns null when the repo isn't configured", () => {
    expect(
      inferRepoFromText("https://github.com/Example-Club/some-other-repo/pull/1", REPOS),
    ).toBeNull();
  });
  it("returns null when there's no GitHub URL", () => {
    expect(inferRepoFromText("review again please", REPOS)).toBeNull();
  });
  it("matches the first known repo when several URLs appear", () => {
    const text = "compare github.com/x/unknown-repo and github.com/x/example-admin/pull/9";
    expect(inferRepoFromText(text, REPOS)).toBe("example-admin");
  });
});
