import { describe, expect, it } from "bun:test";
import {
  buildCodexDispatchCommand,
  resolveEngineeringEngine,
  resolveVoiceRepo,
} from "./engineering-routing.ts";
import type { VoiceRepo } from "./config.ts";

const repos: VoiceRepo[] = [
  { name: "gx-backend", path: "/repos/gx-backend" },
  { name: "gx-client-next", path: "/repos/gx-client-next" },
  { name: "gx-client-expo", path: "/repos/gx-client-expo" },
  { name: "gx-admin-client", path: "/repos/gx-admin-client" },
  { name: "gx-talent-client", path: "/repos/gx-talent-client" },
  { name: "slack-lookup", path: "/repos/slack-lookup" },
  { name: "Built-at-GrowthX", path: "/repos/built" },
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
    expect(resolve("fix the flaky flow", "gx-client-next")).toMatchObject({
      name: "gx-client-next",
      path: "/repos/gx-client-next",
      reason: 'explicit repo "gx-client-next"',
    });
  });

  it("infers repos from GitHub URLs", () => {
    expect(
      resolve("review https://github.com/GrowthX/gx-backend/pull/123"),
    ).toMatchObject({
      name: "gx-backend",
      reason: "GitHub URL",
    });
  });

  it("infers repos from configured name mentions", () => {
    expect(resolve("run typecheck in gx-admin-client")).toMatchObject({
      name: "gx-admin-client",
      reason: 'repo name "gx-admin-client" mentioned',
    });
  });

  it("uses keyword aliases without asking Anmol for common repos", () => {
    expect(resolve("fix the backend payment cron")).toMatchObject({
      name: "gx-backend",
      reason: "keyword alias -> gx-backend",
    });
    expect(resolve("create a new API endpoint for referrals")).toMatchObject({
      name: "gx-backend",
      reason: "keyword alias -> gx-backend",
    });
    expect(resolve("debug the expo android build")).toMatchObject({
      name: "gx-client-expo",
      reason: "keyword alias -> gx-client-expo",
    });
    expect(resolve("make a React Native component for onboarding")).toMatchObject({
      name: "gx-client-expo",
      reason: "keyword alias -> gx-client-expo",
    });
    expect(resolve("fix the next frontend page")).toMatchObject({
      name: "gx-client-next",
      reason: "keyword alias -> gx-client-next",
    });
    expect(resolve("make a React component for the frontend")).toMatchObject({
      name: "gx-client-next",
      reason: "keyword alias -> gx-client-next",
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
      repoPath: "/repos/gx-backend",
      promptPath: "/tmp/friday-voice/dispatch/task.prompt.md",
    });
    expect(command).toContain("codex --ask-for-approval never --search exec");
    expect(command).toContain("exec --sandbox danger-full-access");
    expect(command).toContain("--cd '/repos/gx-backend' - < '/tmp/friday-voice/dispatch/task.prompt.md'");
    expect(command).not.toContain("codex exec --ask-for-approval");
    expect(command).not.toContain("codex exec --search");
  });
});
