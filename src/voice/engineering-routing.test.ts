import { describe, expect, it } from "bun:test";
import {
  buildCodexDispatchCommand,
  resolveEngineeringEngine,
  resolveVoiceRepo,
} from "./engineering-routing.ts";
import type { VoiceRepo } from "./config.ts";

const repos: VoiceRepo[] = [
  { name: "example-backend", path: "/repos/example-backend" },
  { name: "example-web", path: "/repos/example-web" },
  { name: "example-mobile", path: "/repos/example-mobile" },
  { name: "example-admin", path: "/repos/example-admin" },
  { name: "example-talent-client", path: "/repos/example-talent-client" },
  { name: "slack-lookup", path: "/repos/slack-lookup" },
  { name: "Example-Internal", path: "/repos/built" },
];

function resolve(prompt: string, repo?: string) {
  return resolveVoiceRepo({
    prompt,
    repo,
    configured: repos,
    fallbackPath: "/repos/friday",
  });
}

describe("voice engineering routing", () => {
  it("honors explicit repo names", () => {
    expect(resolve("fix the flaky flow", "example-web")).toMatchObject({
      name: "example-web",
      path: "/repos/example-web",
      reason: 'explicit repo "example-web"',
    });
  });

  it("infers repos from GitHub URLs", () => {
    expect(
      resolve("review https://github.com/Example/example-backend/pull/123"),
    ).toMatchObject({
      name: "example-backend",
      reason: "GitHub URL",
    });
  });

  it("infers repos from configured name mentions", () => {
    expect(resolve("run typecheck in example-admin")).toMatchObject({
      name: "example-admin",
      reason: 'repo name "example-admin" mentioned',
    });
  });

  it("uses keyword aliases without asking the user for common repos", () => {
    expect(resolve("fix the backend payment cron")).toMatchObject({
      name: "example-backend",
      reason: "keyword alias -> example-backend",
    });
    expect(resolve("create a new API endpoint for referrals")).toMatchObject({
      name: "example-backend",
      reason: "keyword alias -> example-backend",
    });
    expect(resolve("debug the expo android build")).toMatchObject({
      name: "example-mobile",
      reason: "keyword alias -> example-mobile",
    });
    expect(resolve("make a React Native component for onboarding")).toMatchObject({
      name: "example-mobile",
      reason: "keyword alias -> example-mobile",
    });
    expect(resolve("fix the next frontend page")).toMatchObject({
      name: "example-web",
      reason: "keyword alias -> example-web",
    });
    expect(resolve("make a React component for the frontend")).toMatchObject({
      name: "example-web",
      reason: "keyword alias -> example-web",
    });
  });

  it("keeps Friday voice work in the Friday repo", () => {
    expect(resolve("improve the voice route docs")).toMatchObject({
      name: "friday",
      path: "/repos/friday",
      reason: "keyword alias -> friday",
    });
  });

  it("falls back to Friday repo only when no target is inferred", () => {
    expect(resolve("improve the docs")).toMatchObject({
      name: "friday",
      path: "/repos/friday",
      reason: "no repo inferred; using Friday repo",
    });
  });

  it("defaults engineering engine to local Codex unless Claude is explicit", () => {
    expect(resolveEngineeringEngine()).toBe("codex");
    expect(resolveEngineeringEngine("auto")).toBe("codex");
    expect(resolveEngineeringEngine("codex")).toBe("codex");
    expect(resolveEngineeringEngine("slack")).toBe("codex");
    expect(resolveEngineeringEngine("claude")).toBe("claude");
    expect(resolveEngineeringEngine("Claude")).toBe("claude");
  });

  it("builds Codex dispatch with approval/search before exec", () => {
    const command = buildCodexDispatchCommand({
      repoPath: "/repos/example-backend",
      promptPath: "/tmp/friday-voice/dispatch/task.prompt.md",
    });
    expect(command).toContain("codex --ask-for-approval never --search exec");
    expect(command).toContain("exec --sandbox danger-full-access");
    expect(command).toContain("--cd '/repos/example-backend' - < '/tmp/friday-voice/dispatch/task.prompt.md'");
    expect(command).not.toContain("codex exec --ask-for-approval");
    expect(command).not.toContain("codex exec --search");
  });
});
