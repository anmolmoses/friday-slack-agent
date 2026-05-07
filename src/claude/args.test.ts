import { describe, it, expect } from "bun:test";
import { buildClaudeArgs } from "./args.ts";
import type { ThreadSession } from "../session/types.ts";
import type { AgentDefinition } from "../agents/loader.ts";
import type { Config } from "../config.ts";

function makeSession(overrides: Partial<ThreadSession> = {}): ThreadSession {
  return {
    threadId: "t1",
    channel: "C01",
    sessionId: null,
    worktreePath: null,
    worktreeProvisioned: false,
    targetRepo: null,
    baseRef: null,
    agentType: null,
    systemPrompt: null,
    mcpConfigPath: null,
    status: "idle",
    pendingMessages: [],
    verbosity: "normal",
    pid: null,
    lastActivity: Date.now(),
    lastError: null,
    createdAt: Date.now(),
    spiralScore: 0,
    recentJabs: [],
    muted: false,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<Config["claude"]> = {}): Config["claude"] {
  return {
    maxTurns: 25,
    timeoutMs: 300000,
    maxTimeoutMs: 1800000,
    permissionMode: "bypassPermissions",
    ...overrides,
  };
}

describe("buildClaudeArgs", () => {
  it("includes basic required args", () => {
    const args = buildClaudeArgs(makeSession(), "do something", makeConfig());
    expect(args).toContain("-p");
    expect(args).toContain("do something");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--max-turns");
    expect(args).toContain("25");
    expect(args).toContain("--permission-mode");
    expect(args).toContain("bypassPermissions");
  });

  it("includes --resume when sessionId is present", () => {
    const session = makeSession({ sessionId: "sess-abc" });
    const args = buildClaudeArgs(session, "continue", makeConfig());
    expect(args).toContain("--resume");
    expect(args).toContain("sess-abc");
  });

  it("does not include --resume when sessionId is null", () => {
    const session = makeSession({ sessionId: null });
    const args = buildClaudeArgs(session, "start fresh", makeConfig());
    expect(args).not.toContain("--resume");
  });

  it("includes --append-system-prompt-file when systemPrompt is set", () => {
    const session = makeSession({ systemPrompt: "You are a build agent." });
    const args = buildClaudeArgs(session, "build it", makeConfig());
    expect(args).toContain("--append-system-prompt-file");
    // System prompt is written to a temp file, not passed inline
    expect(args).not.toContain("--append-system-prompt");
  });

  it("includes --append-system-prompt-file even when systemPrompt is null (memory instructions)", () => {
    const session = makeSession({ systemPrompt: null });
    const args = buildClaudeArgs(session, "do it", makeConfig());
    // Memory instructions.md still gets included
    expect(args).toContain("--append-system-prompt-file");
  });

  it("uses maxTurns from config", () => {
    const config = makeConfig({ maxTurns: 10 });
    const args = buildClaudeArgs(makeSession(), "test", config);
    expect(args).toContain("--max-turns");
    expect(args).toContain("10");
  });

  it("uses permissionMode from config", () => {
    const config = makeConfig({ permissionMode: "default" });
    const args = buildClaudeArgs(makeSession(), "test", config);
    expect(args).toContain("--permission-mode");
    expect(args).toContain("default");
  });

  it("includes both --resume and --append-system-prompt when both are set", () => {
    const session = makeSession({
      sessionId: "sess-xyz",
      systemPrompt: "Be concise.",
    });
    const args = buildClaudeArgs(session, "go", makeConfig());
    expect(args).toContain("--resume");
    expect(args).toContain("sess-xyz");
    expect(args).toContain("--append-system-prompt-file");
  });

  it("places prompt immediately after -p", () => {
    const args = buildClaudeArgs(makeSession(), "my prompt", makeConfig());
    const pIdx = args.indexOf("-p");
    expect(pIdx).toBeGreaterThanOrEqual(0);
    expect(args[pIdx + 1]).toBe("my prompt");
  });

  it("includes memory system flags", () => {
    const args = buildClaudeArgs(makeSession(), "test", makeConfig());
    expect(args).toContain("--add-dir");
    expect(args).toContain("--append-system-prompt-file");
    expect(args).toContain("--exclude-dynamic-system-prompt-sections");
  });

  it("includes --mcp-config when session has mcpConfigPath", () => {
    const session = makeSession({ mcpConfigPath: "/tmp/friday-mcp/t1.json" });
    const args = buildClaudeArgs(session, "test", makeConfig());
    expect(args).toContain("--mcp-config");
    expect(args).toContain("/tmp/friday-mcp/t1.json");
  });

  it("does not include --mcp-config when mcpConfigPath is null", () => {
    const session = makeSession({ mcpConfigPath: null });
    const args = buildClaudeArgs(session, "test", makeConfig());
    expect(args).not.toContain("--mcp-config");
  });

  describe("agentDef flags", () => {
    function makeAgentDef(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
      return {
        name: "test-agent",
        description: "test",
        tools: null,
        model: null,
        effort: null,
        allowedTools: null,
        disallowedTools: null,
        prompt: "test prompt",
        ...overrides,
      };
    }

    it("includes --model when agentDef has model", () => {
      const agentDef = makeAgentDef({ model: "opus" });
      const args = buildClaudeArgs(makeSession(), "test", makeConfig(), agentDef);
      expect(args).toContain("--model");
      expect(args).toContain("claude-opus-4-6");
    });

    it("resolves sonnet model alias", () => {
      const agentDef = makeAgentDef({ model: "sonnet" });
      const args = buildClaudeArgs(makeSession(), "test", makeConfig(), agentDef);
      expect(args).toContain("claude-sonnet-4-6");
    });

    it("passes full model name through unchanged", () => {
      const agentDef = makeAgentDef({ model: "claude-opus-4-6" });
      const args = buildClaudeArgs(makeSession(), "test", makeConfig(), agentDef);
      expect(args).toContain("claude-opus-4-6");
    });

    it("includes --effort when agentDef has effort", () => {
      const agentDef = makeAgentDef({ effort: "max" });
      const args = buildClaudeArgs(makeSession(), "test", makeConfig(), agentDef);
      expect(args).toContain("--effort");
      expect(args).toContain("max");
    });

    it("includes --allowedTools for each tool", () => {
      const agentDef = makeAgentDef({ allowedTools: ["Read", "Bash(git *)"] });
      const args = buildClaudeArgs(makeSession(), "test", makeConfig(), agentDef);
      const allowedIdxs = args.reduce<number[]>((acc, v, i) => {
        if (v === "--allowedTools") acc.push(i);
        return acc;
      }, []);
      expect(allowedIdxs.length).toBe(2);
      expect(args[allowedIdxs[0] + 1]).toBe("Read");
      expect(args[allowedIdxs[1] + 1]).toBe("Bash(git *)");
    });

    it("includes --disallowedTools for each tool", () => {
      const agentDef = makeAgentDef({ disallowedTools: ["Edit", "Write"] });
      const args = buildClaudeArgs(makeSession(), "test", makeConfig(), agentDef);
      const disallowedIdxs = args.reduce<number[]>((acc, v, i) => {
        if (v === "--disallowedTools") acc.push(i);
        return acc;
      }, []);
      expect(disallowedIdxs.length).toBe(2);
      expect(args[disallowedIdxs[0] + 1]).toBe("Edit");
      expect(args[disallowedIdxs[1] + 1]).toBe("Write");
    });

    it("omits agent flags when agentDef is null", () => {
      const args = buildClaudeArgs(makeSession(), "test", makeConfig(), null);
      expect(args).not.toContain("--model");
      expect(args).not.toContain("--allowedTools");
      expect(args).not.toContain("--disallowedTools");
      // Default --effort medium so extended thinking streams are emitted.
      const idx = args.indexOf("--effort");
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe("medium");
    });

    it("defaults to --effort medium unless agentDef overrides", () => {
      const agentDef = makeAgentDef();
      const args = buildClaudeArgs(makeSession(), "test", makeConfig(), agentDef);
      expect(args).not.toContain("--model");
      expect(args).not.toContain("--allowedTools");
      expect(args).not.toContain("--disallowedTools");
      const idx = args.indexOf("--effort");
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe("medium");
    });
  });
});
