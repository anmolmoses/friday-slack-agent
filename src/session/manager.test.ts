import { describe, it, expect, beforeEach, mock } from "bun:test";
import type {
  SpawnHandle,
  SpawnResult,
  StreamEvent,
} from "../claude/types.ts";

// Pin engram live-recall AND auto-capture OFF for these tests: bun auto-loads
// .env (where these may be =1 in dev), and their shell-outs / file writes around
// the spawn would break the mocked-spawn timing assertions. Tests exercise the
// default path.
process.env.ENGRAM_RECALL = "0";
process.env.ENGRAM_CAPTURE = "0";
import type { SlackMessageEvent } from "../slack/events.ts";
import type { Config } from "../config.ts";

// --- Mock setup ---

interface MockHandle extends SpawnHandle {
  _complete: (response?: string, sessionId?: string) => void;
  _error: (errorMsg: string) => void;
}

function createMockHandle(
  response: string = "ok",
  sessionId: string = "test-session",
): MockHandle {
  const listeners: Array<(event: StreamEvent) => void> = [];
  let resolveResult!: (result: SpawnResult) => void;
  const result = new Promise<SpawnResult>((res) => {
    resolveResult = res;
  });

  return {
    result,
    onEvent: (cb) => listeners.push(cb),
    kill: mock(() => {}),
    pid: 12345,
    spawnInfo: {
      pid: 12345,
      argv: ["claude", "-p", "mock"],
      cwd: "/tmp",
      prompt: "mock prompt",
      envKeys: [],
      resumedSessionId: null,
      systemPromptFile: null,
      systemPromptContent: null,
    },
    _complete: (resp?: string, sid?: string) => {
      const finalResponse = resp ?? response;
      const finalSessionId = sid ?? sessionId;
      for (const l of listeners)
        l({
          type: "system",
          subtype: "init",
          session_id: finalSessionId,
        });
      for (const l of listeners)
        l({ type: "result", subtype: "success", text: finalResponse });
      resolveResult({
        sessionId: finalSessionId,
        response: finalResponse,
        events: [],
        exitCode: 0,
        error: null,
      });
    },
    _error: (errorMsg: string) => {
      resolveResult({
        sessionId: null,
        response: "",
        events: [],
        exitCode: 1,
        error: errorMsg,
      });
    },
  };
}

let mockSpawnFn: ReturnType<typeof mock<(session: unknown, prompt: unknown, config: unknown, targetRepoCwd?: unknown, botToken?: unknown, agentDef?: unknown) => MockHandle>> = mock(
  (_session: unknown, _prompt: unknown, _config: unknown, _targetRepoCwd?: unknown, _botToken?: unknown, _agentDef?: unknown) => createMockHandle(),
);

// Mock spawnClaude — signature must match real: (session, prompt, config, targetRepoCwd?, botToken?, agentDef?)
mock.module("../claude/spawner.ts", () => ({
  spawnClaude: (session: unknown, prompt: unknown, config: unknown, targetRepoCwd?: unknown, botToken?: unknown, agentDef?: unknown) =>
    mockSpawnFn(session, prompt, config, targetRepoCwd, botToken, agentDef),
}));

// Mock withTimeout to pass through the handle as-is (no real timeout)
mock.module("../lifecycle/timeout.ts", () => ({
  withTimeout: (handle: SpawnHandle, _timeoutMs: number, _onTimeout?: () => void) => handle,
}));

// Mock MCP config generation to avoid filesystem writes
mock.module("../claude/mcp-config.ts", () => ({
  generateMcpConfig: (_threadId: string) => `/tmp/friday-mcp/mock.json`,
}));

// Import after mocking
const { SessionManager } = await import("./manager.ts");
import { InMemorySessionStore } from "./store/memory.ts";

// --- Helpers ---

const testConfig: Config = {
  slack: { botToken: "xoxb-test", appToken: "xapp-test", signingSecret: "s" },
  claude: { maxTurns: 25, timeoutMs: 300000, maxTimeoutMs: 1800000, permissionMode: "bypassPermissions" },
  brain: { engine: "claude", codexModel: "gpt-5.5", codexReasoning: "medium" },
  http: { port: 3000, enabled: false },
  repos: [
    { name: "friday", path: "/tmp/friday", defaultBase: "main" },
    { name: "frontend", path: "/tmp/frontend", defaultBase: "main" },
  ],
  session: { staleTimeoutMs: 86400000, cleanupIntervalMs: 900000 },
  worktree: { diskCapBytes: 20 * 1024 * 1024 * 1024 },
};

let tsCounter = 0;
function makeEvent(overrides: Partial<SlackMessageEvent> = {}): SlackMessageEvent {
  tsCounter++;
  return {
    threadId: "thread-1",
    channel: "C123",
    user: "U123",
    text: "Hello Claude",
    ts: `1234567890.${String(tsCounter).padStart(6, "0")}`,
    command: null,
    ...overrides,
  };
}

describe("SessionManager", () => {
  let store: InMemorySessionStore;
  let manager: InstanceType<typeof SessionManager>;
  let currentHandle: MockHandle;

  beforeEach(() => {
    store = new InMemorySessionStore();
    manager = new SessionManager(store, testConfig);

    currentHandle = createMockHandle();
    mockSpawnFn = mock(() => currentHandle);
  });

  // --- Session creation and basic flow ---

  it("creates a session for a new thread", async () => {
    const event = makeEvent();
    await manager.handleMessage(event);

    const session = await store.get("thread-1");
    expect(session).toBeDefined();
    expect(session!.threadId).toBe("thread-1");
    expect(session!.channel).toBe("C123");
    expect(session!.status).toBe("busy");
  });

  it("sets status to busy on idle thread", async () => {
    const event = makeEvent();
    await manager.handleMessage(event);

    const session = await store.get("thread-1");
    expect(session!.status).toBe("busy");
  });

  it("calls spawnClaude with the prompt text", async () => {
    const event = makeEvent({ text: "Build me a feature" });
    await manager.handleMessage(event);

    expect(mockSpawnFn).toHaveBeenCalledTimes(1);
    const callArgs = mockSpawnFn.mock.calls[0];
    // Second arg is the prompt
    expect(callArgs[1]).toBe("Build me a feature");
  });

  // --- Message buffering ---

  it("buffers message when thread is busy", async () => {
    const onBuffered = mock(() => {});
    manager.onMessageBuffered = onBuffered;

    // First message makes it busy
    await manager.handleMessage(makeEvent({ text: "First message" }));
    expect((await store.get("thread-1"))!.status).toBe("busy");

    // Second message while busy -> buffered
    const event2 = makeEvent({ text: "Second message", ts: "ts-2" });
    await manager.handleMessage(event2);

    const session = await store.get("thread-1");
    expect(session!.pendingMessages.length).toBe(1);
    expect(session!.pendingMessages[0].text).toBe("Second message");
    expect(onBuffered).toHaveBeenCalledTimes(1);
  });

  // --- Completion and response ---

  it("fires onResponse and sets status to idle after Claude completes", async () => {
    const responses: string[] = [];
    manager.onResponse = (_session, response) => responses.push(response);

    await manager.handleMessage(makeEvent({ text: "Do something" }));
    currentHandle._complete("Here is the answer");

    // Let microtasks flush
    await new Promise((r) => setTimeout(r, 10));

    const session = await store.get("thread-1");
    expect(session!.status).toBe("idle");
    expect(responses).toEqual(["Here is the answer"]);
  });

  it("captures sessionId from init event", async () => {
    await manager.handleMessage(makeEvent());
    currentHandle._complete("response", "claude-session-42");

    await new Promise((r) => setTimeout(r, 10));

    const session = await store.get("thread-1");
    expect(session!.sessionId).toBe("claude-session-42");
  });

  // --- Buffer drain ---

  it("drains buffered messages after Claude completes", async () => {
    // First message -> busy
    await manager.handleMessage(makeEvent({ text: "First" }));

    // Buffer a second message
    await manager.handleMessage(
      makeEvent({ text: "Second", ts: "ts-2", user: "U456" }),
    );
    expect((await store.get("thread-1"))!.pendingMessages.length).toBe(1);

    // Prepare a new handle for the drain turn
    const drainHandle = createMockHandle();
    mockSpawnFn = mock(() => drainHandle);

    // Complete the first run
    currentHandle._complete("First response");
    await new Promise((r) => setTimeout(r, 10));

    // spawnClaude should have been called again for the buffered message
    expect(mockSpawnFn).toHaveBeenCalledTimes(1);
    const drainPrompt = mockSpawnFn.mock.calls[0][1] as string;
    expect(drainPrompt).toContain("[U456]: Second");

    // Session should be in draining/busy
    const session = await store.get("thread-1");
    expect(session!.pendingMessages.length).toBe(0);
  });

  // --- Commands ---

  describe("!reset", () => {
    it("kills running process and deletes session", async () => {
      const onCmd = mock((_e: SlackMessageEvent, _r: string) => {});
      manager.onCommandResponse = onCmd;

      // Start a session
      await manager.handleMessage(makeEvent({ text: "Work on this" }));

      // Now reset
      const resetEvent = makeEvent({ command: "reset", text: "" });
      await manager.handleMessage(resetEvent);

      // Session should be deleted
      const session = await store.get("thread-1");
      expect(session).toBeUndefined();

      // kill should have been called on the handle
      expect(currentHandle.kill).toHaveBeenCalled();

      // Command response should fire
      expect(onCmd).toHaveBeenCalledTimes(1);
      expect(onCmd.mock.calls[0][1]).toBe("Session reset.");
    });
  });

  describe("killThread", () => {
    it("kills the run, mutes, clears pending, and keeps the session row", async () => {
      const onResponse = mock(() => {});
      const onError = mock(() => {});
      manager.onResponse = onResponse;
      manager.onError = onError;

      // Start a run, then buffer a second message while busy.
      await manager.handleMessage(makeEvent({ text: "Work on this" }));
      await manager.handleMessage(makeEvent({ text: "and this too" }));
      await new Promise((r) => setTimeout(r, 5)); // let the spawn settle

      let session = await store.get("thread-1");
      expect(session?.status).toBe("busy");
      expect(session?.pendingMessages.length).toBe(1);

      const result = await manager.killThread("thread-1");
      expect(result).toEqual({ found: true, killedRun: true, muted: true });
      expect(currentHandle.kill).toHaveBeenCalled();

      // Simulate the terminated process's result landing — must be swallowed
      // (no error post, no drain, session stays muted/idle).
      currentHandle._error("terminated by signal");
      await new Promise((r) => setTimeout(r, 5));

      session = await store.get("thread-1");
      expect(session).toBeDefined(); // row kept, unlike !reset
      expect(session?.muted).toBe(true);
      expect(session?.status).toBe("idle");
      expect(session?.pendingMessages.length).toBe(0);
      expect(onError).not.toHaveBeenCalled();
      expect(onResponse).not.toHaveBeenCalled();
    });

    it("mutes an idle thread that has no running process", async () => {
      await manager.handleMessage(makeEvent({ text: "hi" }));
      currentHandle._complete("done");
      await new Promise((r) => setTimeout(r, 5));

      const result = await manager.killThread("thread-1");
      expect(result.killedRun).toBe(false);
      expect(result.muted).toBe(true);
      expect((await store.get("thread-1"))?.muted).toBe(true);
    });

    it("returns found=false for an unknown thread", async () => {
      expect(await manager.killThread("nope")).toEqual({
        found: false,
        killedRun: false,
        muted: false,
      });
    });
  });

  describe("setMuted", () => {
    it("toggles muted without killing the process", async () => {
      await manager.handleMessage(makeEvent({ text: "hi" }));
      currentHandle._complete("done");
      await new Promise((r) => setTimeout(r, 5));

      expect(await manager.setMuted("thread-1", true)).toEqual({ found: true, muted: true });
      expect((await store.get("thread-1"))?.muted).toBe(true);

      expect(await manager.setMuted("thread-1", false)).toEqual({ found: true, muted: false });
      expect((await store.get("thread-1"))?.muted).toBe(false);

      expect(currentHandle.kill).not.toHaveBeenCalled();
    });

    it("returns found=false for an unknown thread", async () => {
      expect(await manager.setMuted("nope", true)).toEqual({ found: false, muted: false });
    });
  });

  describe("!status", () => {
    it("returns session info via onCommandResponse", async () => {
      const onCmd = mock((_e: SlackMessageEvent, _r: string) => {});
      manager.onCommandResponse = onCmd;

      // Create a session
      await manager.handleMessage(makeEvent({ text: "Start" }));

      // Check status
      const statusEvent = makeEvent({ command: "status", text: "" });
      await manager.handleMessage(statusEvent);

      expect(onCmd).toHaveBeenCalledTimes(1);
      const response = onCmd.mock.calls[0][1] as string;
      expect(response).toContain("*Status:*");
      expect(response).toContain("*Agent:*");
      expect(response).toContain("*Pending messages:*");
    });
  });

  describe("!build", () => {
    it("sets agentType and continues to Claude", async () => {
      const event = makeEvent({ command: "build", text: "Build a feature" });
      await manager.handleMessage(event);

      const session = await store.get("thread-1");
      expect(session!.agentType).toBe("build");
      // Should still proceed to spawn (command returns false -> not fully handled)
      expect(session!.status).toBe("busy");
      expect(mockSpawnFn).toHaveBeenCalled();
    });
  });

  describe("!frontend", () => {
    it("sets agentType to frontend and continues to Claude", async () => {
      const event = makeEvent({ command: "frontend", text: "Style the page" });
      await manager.handleMessage(event);

      const session = await store.get("thread-1");
      expect(session!.agentType).toBe("frontend");
      expect(session!.status).toBe("busy");
    });
  });

  describe("!review", () => {
    it("sets agentType to review and continues to Claude", async () => {
      const event = makeEvent({ command: "review", text: "Review this PR" });
      await manager.handleMessage(event);

      const session = await store.get("thread-1");
      expect(session!.agentType).toBe("review");
    });
  });

  describe("!architect", () => {
    it("sets agentType to architect and continues to Claude", async () => {
      const event = makeEvent({ command: "architect", text: "Design the system" });
      await manager.handleMessage(event);

      const session = await store.get("thread-1");
      expect(session!.agentType).toBe("architect");
    });
  });

  describe("verbosity commands", () => {
    it("!quiet sets verbosity to quiet", async () => {
      const onCmd = mock((_e: SlackMessageEvent, _r: string) => {});
      manager.onCommandResponse = onCmd;

      // Create session first
      await manager.handleMessage(makeEvent({ text: "hi" }));
      currentHandle._complete();
      await new Promise((r) => setTimeout(r, 10));

      await manager.handleMessage(
        makeEvent({ command: "quiet", text: "" }),
      );

      const session = await store.get("thread-1");
      expect(session!.verbosity).toBe("quiet");
      expect(onCmd).toHaveBeenCalledWith(
        expect.anything(),
        "Quiet mode.",
      );
    });

    it("!verbose sets verbosity to verbose", async () => {
      const onCmd = mock((_e: SlackMessageEvent, _r: string) => {});
      manager.onCommandResponse = onCmd;

      await manager.handleMessage(makeEvent({ text: "hi" }));
      currentHandle._complete();
      await new Promise((r) => setTimeout(r, 10));

      await manager.handleMessage(
        makeEvent({ command: "verbose", text: "" }),
      );

      const session = await store.get("thread-1");
      expect(session!.verbosity).toBe("verbose");
      expect(onCmd).toHaveBeenCalledWith(
        expect.anything(),
        "Verbose mode.",
      );
    });

    it("!normal sets verbosity to normal", async () => {
      const onCmd = mock((_e: SlackMessageEvent, _r: string) => {});
      manager.onCommandResponse = onCmd;

      await manager.handleMessage(makeEvent({ text: "hi" }));
      currentHandle._complete();
      await new Promise((r) => setTimeout(r, 10));

      // Set to quiet first, then back to normal
      await manager.handleMessage(
        makeEvent({ command: "quiet", text: "" }),
      );
      await manager.handleMessage(
        makeEvent({ command: "normal", text: "" }),
      );

      const session = await store.get("thread-1");
      expect(session!.verbosity).toBe("normal");
    });
  });

  describe("!repo", () => {
    it("sets targetRepo when valid", async () => {
      const onCmd = mock((_e: SlackMessageEvent, _r: string) => {});
      manager.onCommandResponse = onCmd;

      // Create session
      await manager.handleMessage(makeEvent({ text: "hi" }));
      currentHandle._complete();
      await new Promise((r) => setTimeout(r, 10));

      await manager.handleMessage(
        makeEvent({ command: "repo", text: "friday" }),
      );

      const session = await store.get("thread-1");
      expect(session!.targetRepo).toBe("friday");
      expect(onCmd.mock.calls[0][1]).toContain("friday");
    });

    it("reports error for invalid repo", async () => {
      const onCmd = mock((_e: SlackMessageEvent, _r: string) => {});
      manager.onCommandResponse = onCmd;

      await manager.handleMessage(makeEvent({ text: "hi" }));
      currentHandle._complete();
      await new Promise((r) => setTimeout(r, 10));

      await manager.handleMessage(
        makeEvent({ command: "repo", text: "nonexistent-repo" }),
      );

      const response = onCmd.mock.calls[0][1] as string;
      expect(response).toContain("Unknown repo");
      expect(response).toContain("friday");
      expect(response).toContain("frontend");
    });
  });

  describe("!branch", () => {
    it("sets baseRef on the session", async () => {
      const onCmd = mock((_e: SlackMessageEvent, _r: string) => {});
      manager.onCommandResponse = onCmd;

      await manager.handleMessage(makeEvent({ text: "hi" }));
      currentHandle._complete();
      await new Promise((r) => setTimeout(r, 10));

      await manager.handleMessage(
        makeEvent({ command: "branch", text: "feature/new-thing" }),
      );

      const session = await store.get("thread-1");
      expect(session!.baseRef).toBe("feature/new-thing");
      expect(onCmd.mock.calls[0][1]).toContain("feature/new-thing");
    });
  });

  describe("!help", () => {
    it("returns help text", async () => {
      const onCmd = mock((_e: SlackMessageEvent, _r: string) => {});
      manager.onCommandResponse = onCmd;

      await manager.handleMessage(makeEvent({ text: "hi" }));
      currentHandle._complete();
      await new Promise((r) => setTimeout(r, 10));

      await manager.handleMessage(
        makeEvent({ command: "help", text: "" }),
      );

      expect(onCmd).toHaveBeenCalled();
      const response = onCmd.mock.calls[0][1] as string;
      expect(response).toContain("!build");
      expect(response).toContain("!reset");
      expect(response).toContain("!status");
    });
  });

  // --- Error handling ---

  it("fires onError and sets session idle when spawn returns an error", async () => {
    const errors: string[] = [];
    manager.onError = (_session, error) => {
      if (error) errors.push(error);
    };

    await manager.handleMessage(makeEvent({ text: "Do something" }));
    currentHandle._error("Claude crashed");

    await new Promise((r) => setTimeout(r, 10));

    const session = await store.get("thread-1");
    expect(session!.status).toBe("idle");
    expect(session!.lastError).not.toBeNull();
    expect(session!.lastError!.message).toBe("Claude crashed");
    expect(errors).toEqual(["Claude crashed"]);
  });

  // --- onEvent forwarding ---

  it("forwards stream events via onEvent", async () => {
    const events: StreamEvent[] = [];
    manager.onEvent = (_session, event) => events.push(event);

    await manager.handleMessage(makeEvent({ text: "Go" }));
    currentHandle._complete("Done");

    await new Promise((r) => setTimeout(r, 10));

    // Should have received init + result events
    expect(events.length).toBe(2);
    expect(events[0].type).toBe("system");
    expect(events[1].type).toBe("result");
  });

  // --- getSession ---

  it("getSession returns existing session", async () => {
    await manager.handleMessage(makeEvent());

    const session = await manager.getSession("thread-1");
    expect(session).toBeDefined();
    expect(session!.threadId).toBe("thread-1");
  });

  it("getSession returns undefined for unknown thread", async () => {
    const session = await manager.getSession("unknown");
    expect(session).toBeUndefined();
  });
});
