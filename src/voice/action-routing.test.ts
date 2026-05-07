import { describe, expect, it } from "bun:test";
import {
  deterministicAction,
  favoriteSongAppAction,
  likelyNeedsMemoryRecall,
  likelyNeedsPostToolContinuation,
  likelyNeedsPostVisionAction,
  likelyNeedsTool,
  preferredToolForAction,
} from "./action-routing.ts";

describe("voice action routing", () => {
  it("detects action-like prompts", () => {
    expect(likelyNeedsTool("open chrome")).toBe(true);
    expect(likelyNeedsTool("please review this repo")).toBe(true);
    expect(likelyNeedsTool("look up latest OpenAI realtime docs on the web")).toBe(true);
    expect(likelyNeedsTool("Can you check my laptop's temperature?")).toBe(true);
    expect(likelyNeedsTool("I think the audio needs to pick up a little faster.")).toBe(true);
    expect(likelyNeedsTool("create a new API endpoint in the backend")).toBe(true);
    expect(likelyNeedsTool("hello friday")).toBe(false);
    expect(likelyNeedsTool("Hey.")).toBe(false);
    expect(likelyNeedsTool("make me laugh")).toBe(false);
    expect(likelyNeedsTool("Hey Friday, what can you do for me?")).toBe(false);
    expect(likelyNeedsTool("Can you change your own code?")).toBe(false);
  });

  it("detects memory-sensitive preference language without treating it all as action", () => {
    expect(likelyNeedsMemoryRecall("What is my favorite song?")).toBe(true);
    expect(likelyNeedsMemoryRecall("open Music and play my favorite song")).toBe(
      true,
    );
    expect(likelyNeedsMemoryRecall("Hey.")).toBe(false);
    expect(likelyNeedsTool("What is my favorite song?")).toBe(false);
  });

  it("fast-paths simple one-step URL and app opens", () => {
    expect(deterministicAction("open https://example.com")).toEqual({
      name: "browser_open_url",
      args: { url: "https://example.com", app: "Google Chrome" },
    });
    expect(deterministicAction("launch Safari")).toEqual({
      name: "open_app",
      args: { name: "Safari" },
    });
    expect(deterministicAction("open Linear")).toEqual({
      name: "open_app",
      args: { name: "Linear" },
    });
    expect(deterministicAction("please launch calculator app")).toEqual({
      name: "open_app",
      args: { name: "Calculator" },
    });
  });

  it("fast-paths known browser search surfaces without coordinate clicks", () => {
    expect(
      deterministicAction(
        "Open Google Chrome, go to chatgpt.com, and use the ChatGPT search bar to search for OpenAI Realtime API docs. Tell me when the search results are visible.",
      ),
    ).toEqual({
      name: "browser_submit_text",
      args: {
        url: "chatgpt.com",
        text: "OpenAI Realtime API docs",
        app: "Google Chrome",
        submit: true,
        verify: true,
      },
    });
    expect(
      deterministicAction(
        "Open Google Chrome, go to chatgpt.com, and search for OpenAI Realtime API docs.",
      ),
    ).toEqual({
      name: "browser_submit_text",
      args: {
        url: "chatgpt.com",
        text: "OpenAI Realtime API docs",
        app: "Google Chrome",
        submit: true,
        verify: false,
      },
    });
    expect(
      deterministicAction(
        "Open Chrome, go to ChatGPT, and search for OpenAI realtime docs in the ChatGPT search bar.",
      ),
    ).toEqual({
      name: "browser_submit_text",
      args: {
        url: "chatgpt.com",
        text: "OpenAI realtime docs",
        app: "Google Chrome",
        submit: true,
        verify: false,
      },
    });
    expect(
      deterministicAction("go to google.com and search for bun test docs"),
    ).toEqual({
      name: "browser_submit_text",
      args: {
        url: "google.com",
        text: "bun test docs",
        app: "Google Chrome",
        submit: true,
        verify: false,
      },
    });
  });

  it("fast-paths safe Slack navigation through the visible app", () => {
    expect(
      deterministicAction("open Slack and go to channel agent-test"),
    ).toEqual({
      name: "app_quick_switch",
      args: {
        app: "Slack",
        query: "agent-test",
        shortcut: "cmd+k",
      },
    });
    expect(
      deterministicAction("switch to #tech-support in Slack"),
    ).toEqual({
      name: "app_quick_switch",
      args: {
        app: "Slack",
        query: "tech-support",
        shortcut: "cmd+k",
      },
    });
  });

  it("fast-paths explicit Slack message sends through the visible app", () => {
    expect(
      deterministicAction("send \"hello from friday\" to channel agent-test in Slack"),
    ).toEqual({
      name: "app_send_text",
      args: {
        app: "Slack",
        destination: "agent-test",
        text: "hello from friday",
        shortcut: "cmd+k",
        submit: true,
      },
    });
    expect(
      deterministicAction(
        "open Slack, go to channel agent-test, then send message saying deploy is green",
      ),
    ).toEqual({
      name: "app_send_text",
      args: {
        app: "Slack",
        destination: "agent-test",
        text: "deploy is green",
        shortcut: "cmd+k",
        submit: true,
      },
    });
  });

  it("fast-paths explicit generic app search and play requests", () => {
    expect(
      deterministicAction("open Music and play Numb by Linkin Park"),
    ).toEqual({
      name: "app_search_text",
      args: {
        app: "Music",
        text: "Numb by Linkin Park",
        shortcut: "cmd+l",
        submit: true,
        mode: "play",
      },
    });
    expect(
      deterministicAction("open Chrome and search for OpenAI realtime docs"),
    ).toEqual({
      name: "app_search_text",
      args: {
        app: "Google Chrome",
        text: "OpenAI realtime docs",
        shortcut: "cmd+l",
        submit: true,
        mode: "search",
      },
    });
  });

  it("does not fast-path open-ended multi-step UI or media requests", () => {
    expect(
      deterministicAction("open Slack and send a message to agent-test"),
    ).toBeUndefined();
    expect(deterministicAction("open music and play my favorite song")).toBeUndefined();
  });

  it("resolves remembered favorite-song app actions generically when memory is supplied", () => {
    expect(
      favoriteSongAppAction("open Music and play my favorite song", "Numb by Linkin Park"),
    ).toEqual({
      name: "app_search_text",
      args: {
        app: "Music",
        text: "Numb by Linkin Park",
        shortcut: "cmd+l",
        submit: true,
        mode: "play",
      },
    });
    expect(
      favoriteSongAppAction(
        "dry run open Music and play my favorite song",
        "Numb by Linkin Park",
      ),
    ).toEqual({
      name: "app_search_text",
      args: {
        app: "Music",
        text: "Numb by Linkin Park",
        shortcut: "cmd+l",
        submit: true,
        mode: "play",
        dry_run: true,
      },
    });
  });

  it("fast-paths visual screen summaries to screenshot vision", () => {
    expect(deterministicAction("look at my screen and tell me what you see")).toEqual({
      name: "screen_see",
      args: {
        prompt:
          "Inspect the current Mac screen and answer the user's visual question briefly.",
      },
    });
    expect(deterministicAction("what is on my screen?")).toEqual({
      name: "screen_see",
      args: {
        prompt:
          "Inspect the current Mac screen and answer the user's visual question briefly.",
      },
    });
    expect(deterministicAction("what am I looking at?")).toEqual({
      name: "screen_see",
      args: {
        prompt:
          "Inspect the current Mac screen and answer the user's visual question briefly.",
      },
    });
    expect(deterministicAction("what is the frontmost app?")).toEqual({
      name: "screen_brief",
      args: {},
    });
    expect(deterministicAction("click the blue button on my screen")).toBeUndefined();
  });

  it("fast-paths screen and mouse permission checks", () => {
    expect(deterministicAction("check if screen recording permission is working")).toEqual({
      name: "screen_screenshot",
      args: { note: "friday-screen-permission-check" },
    });
    expect(deterministicAction("take a screenshot")).toEqual({
      name: "screen_screenshot",
      args: { note: "friday-requested-screenshot" },
    });
    expect(deterministicAction("check if you can control the mouse")).toEqual({
      name: "mouse_control",
      args: { action: "check" },
    });
  });

  it("fast-paths visual read requests without direct-clicking", () => {
    expect(deterministicAction("read the visible text on my screen")).toEqual({
      name: "screen_see",
      args: {
        prompt:
          "Inspect the current Mac screen and answer the user's visual question briefly.",
      },
    });
    expect(deterministicAction("click the blue button on my screen")).toBeUndefined();
  });

  it("fast-paths explicit shell commands", () => {
    expect(deterministicAction("run command: sleep 2; printf ok")).toEqual({
      name: "run_shell",
      args: { command: "sleep 2; printf ok" },
    });
    expect(deterministicAction("run this shell command: printf ok")).toEqual({
      name: "run_shell",
      args: { command: "printf ok" },
    });
    expect(
      deterministicAction("run this shell command: printf friday-live-probe-ok"),
    ).toEqual({
      name: "run_shell",
      args: { command: "printf friday-live-probe-ok" },
    });
  });

  it("fast-paths system temperature checks to shell", () => {
    const action = deterministicAction("Can you check my laptop's temperature?");
    expect(action?.name).toBe("run_shell");
    expect(String(action?.args.command)).toContain("AppleSmartBattery");
    expect(String(action?.args.command).indexOf("AppleSmartBattery")).toBeLessThan(
      String(action?.args.command).indexOf("pmset -g therm"),
    );
  });

  it("fast-paths clear engineering work to local Codex dispatch", () => {
    expect(deterministicAction("run the tests in the backend repo")).toEqual({
      name: "dispatch_engineering",
      args: {
        prompt: "run the tests in the backend repo",
        engine: "auto",
      },
    });
    expect(deterministicAction("fix the typecheck in example-backend")).toEqual({
      name: "dispatch_engineering",
      args: {
        prompt: "fix the typecheck in example-backend",
        engine: "auto",
      },
    });
    expect(deterministicAction("review PR #123 with Claude")).toEqual({
      name: "dispatch_engineering",
      args: {
        prompt: "review PR #123 with Claude",
        engine: "claude",
      },
    });
    expect(deterministicAction("create a new API endpoint in the backend")).toEqual({
      name: "dispatch_engineering",
      args: {
        prompt: "create a new API endpoint in the backend",
        engine: "auto",
      },
    });
    expect(deterministicAction("make a React component in the frontend")).toEqual({
      name: "dispatch_engineering",
      args: {
        prompt: "make a React component in the frontend",
        engine: "auto",
      },
    });
    expect(deterministicAction("check the logs in example-backend")).toEqual({
      name: "dispatch_engineering",
      args: {
        prompt: "check the logs in example-backend",
        engine: "auto",
      },
    });
    expect(
      deterministicAction(
        "dry-run engineering dispatch: review the backend API route and report a concise plan",
      ),
    ).toEqual({
      name: "dispatch_engineering",
      args: {
        prompt: "review the backend API route and report a concise plan",
        engine: "auto",
        dry_run: true,
      },
    });
  });

  it("prefers the right Realtime tool for non-direct actions", () => {
    expect(preferredToolForAction("click the blue button on my screen")).toBe(
      "screen_see",
    );
    expect(preferredToolForAction("check my screen")).toBe("screen_see");
    expect(preferredToolForAction("what is the frontmost app?")).toBe(
      "screen_brief",
    );
    expect(preferredToolForAction("read the text on my screen")).toBe("screen_see");
    expect(preferredToolForAction("open Music and play my favorite song")).toBe(
      "memory_search",
    );
    expect(preferredToolForAction("fix the typecheck in example-backend")).toBe(
      "dispatch_engineering",
    );
    expect(preferredToolForAction("create a new API endpoint in the backend")).toBe(
      "dispatch_engineering",
    );
    expect(preferredToolForAction("look up latest realtime api docs on the web")).toBe(
      "web_search",
    );
    expect(preferredToolForAction("open slack and send a message")).toBe(
      "open_app",
    );
    expect(
      preferredToolForAction("send \"hello\" to channel agent-test in Slack"),
    ).toBe("app_send_text");
    expect(
      preferredToolForAction("go to chatgpt.com and search for realtime docs"),
    ).toBe("browser_submit_text");
    expect(preferredToolForAction("open Slack and go to channel agent-test")).toBe(
      "app_quick_switch",
    );
    expect(preferredToolForAction("open Linear")).toBe("open_app");
    expect(preferredToolForAction("Can you check my laptop's temperature?")).toBe(
      "run_shell",
    );
    expect(preferredToolForAction("the audio needs to pick up faster")).toBe(
      "dispatch_engineering",
    );
    expect(preferredToolForAction("Can you change your own code?")).toBeUndefined();
  });

  it("keeps post-vision action continuation scoped to UI tasks", () => {
    expect(likelyNeedsPostVisionAction("click the top result")).toBe(true);
    expect(likelyNeedsPostVisionAction("what is on my screen?")).toBe(false);
  });

  it("continues multi-step UI tasks after intermediate tools", () => {
    expect(
      likelyNeedsPostToolContinuation({
        text: "open Slack and send a message to agent-test",
        lastTool: "open_app",
        toolCallCount: 1,
      }),
    ).toBe(true);
    expect(
      likelyNeedsPostToolContinuation({
        text: "open chrome and search for realtime docs",
        lastTool: "browser_open_url",
        toolCallCount: 2,
      }),
    ).toBe(true);
    expect(
      likelyNeedsPostToolContinuation({
        text: "open Chrome",
        lastTool: "open_app",
        toolCallCount: 1,
      }),
    ).toBe(false);
    expect(
      likelyNeedsPostToolContinuation({
        text: "open Slack, go to agent-test, then click the canvas button",
        lastTool: "app_quick_switch",
        toolCallCount: 1,
      }),
    ).toBe(true);
    expect(
      likelyNeedsPostToolContinuation({
        text: "open Music and play my favorite song",
        lastTool: "memory_search",
        toolCallCount: 1,
      }),
    ).toBe(true);
    expect(
      likelyNeedsPostToolContinuation({
        text: "open Slack and send a message",
        lastTool: "open_app",
        toolCallCount: 24,
      }),
    ).toBe(false);
  });
});
