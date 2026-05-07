import { describe, it, expect } from "bun:test";
import { formatToolStatuses, splitResponse, toSlackMrkdwn } from "./formatting.ts";
import type { StreamEventAssistant } from "../claude/types.ts";

function makeAssistantEvent(
  tools: Array<{ name?: string; input?: Record<string, unknown> }>,
): StreamEventAssistant {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: tools.map((t) => ({
        type: "tool_use" as const,
        name: t.name,
        input: t.input,
      })),
    },
  };
}

describe("formatToolStatuses", () => {
  it("formats Bash with command", () => {
    const result = formatToolStatuses(makeAssistantEvent([{ name: "Bash", input: { command: "git diff" } }]));
    expect(result).toEqual(["⚙️ `git diff`"]);
  });

  it("truncates Bash command longer than 120 chars", () => {
    const longCmd = "a".repeat(150);
    const result = formatToolStatuses(makeAssistantEvent([{ name: "Bash", input: { command: longCmd, description: "doing stuff" } }]));
    // Long command falls back to description for the label
    expect(result[0]).toBe("⚙️ `doing stuff`");
  });

  it("prefers command if it fits", () => {
    const cmd = "b".repeat(100);
    const result = formatToolStatuses(makeAssistantEvent([{ name: "Bash", input: { command: cmd } }]));
    expect(result[0]).toBe(`⚙️ \`${cmd}\``);
  });

  it("formats Read with file_path", () => {
    const result = formatToolStatuses(makeAssistantEvent([{ name: "Read", input: { file_path: "src/auth.ts" } }]));
    expect(result).toEqual(["📖 Reading `src/auth.ts`"]);
  });

  it("formats Edit with file_path", () => {
    const result = formatToolStatuses(makeAssistantEvent([{ name: "Edit", input: { file_path: "src/index.ts" } }]));
    expect(result).toEqual(["✏️ Editing `src/index.ts`"]);
  });

  it("formats Write with file_path", () => {
    const result = formatToolStatuses(makeAssistantEvent([{ name: "Write", input: { file_path: "src/new.ts" } }]));
    expect(result).toEqual(["📝 Writing `src/new.ts`"]);
  });

  it("formats Grep with pattern", () => {
    const result = formatToolStatuses(makeAssistantEvent([{ name: "Grep", input: { pattern: "TODO" } }]));
    expect(result).toEqual(["🔎 Searching for `TODO`"]);
  });

  it("formats Glob with pattern", () => {
    const result = formatToolStatuses(makeAssistantEvent([{ name: "Glob", input: { pattern: "**/*.ts" } }]));
    expect(result).toEqual(["🔎 Finding `**/*.ts`"]);
  });

  it("formats WebSearch with query", () => {
    const result = formatToolStatuses(makeAssistantEvent([{ name: "WebSearch", input: { query: "claude code" } }]));
    expect(result).toEqual(["🌐 Web search · `claude code`"]);
  });

  it("formats WebFetch with url", () => {
    const result = formatToolStatuses(makeAssistantEvent([{ name: "WebFetch", input: { url: "https://example.com" } }]));
    expect(result).toEqual(["🌐 Fetching `https://example.com`"]);
  });

  it("formats MCP tools with server and method", () => {
    const result = formatToolStatuses(makeAssistantEvent([{ name: "mcp__playwright__browser_click", input: {} }]));
    expect(result[0]).toBe("🔌 playwright · browser_click");
  });

  it("formats Task/Agent dispatch", () => {
    const result = formatToolStatuses(makeAssistantEvent([{ name: "Task", input: { description: "audit memory", subagent_type: "Explore" } }]));
    expect(result[0]).toContain("🤝 Dispatching");
    expect(result[0]).toContain("Explore");
  });

  it("formats unknown tool with tool name", () => {
    const result = formatToolStatuses(makeAssistantEvent([{ name: "MysteryTool" }]));
    expect(result).toEqual(["🔧 Using MysteryTool"]);
  });

  it("handles missing input", () => {
    const result = formatToolStatuses(makeAssistantEvent([{ name: "Bash" }]));
    expect(result).toEqual(["⚙️ ``"]);
  });

  it("handles missing name", () => {
    const result = formatToolStatuses(makeAssistantEvent([{}]));
    expect(result).toEqual(["🔧 Using Unknown"]);
  });

  it("returns empty for text-only events", () => {
    const event: StreamEventAssistant = {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
    };
    expect(formatToolStatuses(event)).toEqual([]);
  });

  it("handles multiple tool_use blocks", () => {
    const result = formatToolStatuses(makeAssistantEvent([
      { name: "Read", input: { file_path: "a.ts" } },
      { name: "Read", input: { file_path: "b.ts" } },
    ]));
    expect(result).toHaveLength(2);
  });
});

describe("splitResponse", () => {
  it("returns single chunk for short text", () => {
    const result = splitResponse("Hello world", 100);
    expect(result).toEqual(["Hello world"]);
  });

  it("returns empty array for empty string", () => {
    expect(splitResponse("")).toEqual([]);
  });

  it("splits at paragraph boundary (double newline)", () => {
    const text = "First paragraph.\n\nSecond paragraph.";
    const result = splitResponse(text, 25);
    expect(result).toEqual(["First paragraph.", "Second paragraph."]);
  });

  it("keeps code blocks intact", () => {
    const code = "x".repeat(20);
    const text = `Before\n\n\`\`\`\n${code}\n\`\`\`\n\nAfter`;
    const result = splitResponse(text, 30);
    for (const chunk of result) {
      const backtickCount = (chunk.match(/```/g) || []).length;
      expect(backtickCount % 2).toBe(0);
    }
  });

  it("splits at maxLength as last resort", () => {
    const text = "x".repeat(200);
    const result = splitResponse(text, 50);
    expect(result).toHaveLength(4);
  });

  it("uses default maxLength of 4000", () => {
    const text = "a".repeat(4000);
    const result = splitResponse(text);
    expect(result).toEqual([text]);
  });

  it("returns text that exceeds default maxLength in multiple chunks", () => {
    const text = "a".repeat(8001);
    const result = splitResponse(text);
    expect(result.length).toBeGreaterThan(1);
    expect(result.join("")).toBe(text);
  });

  it("prefers paragraph splits over single newline splits", () => {
    const text = "Line one\nLine two\n\nLine three\nLine four";
    const result = splitResponse(text, 30);
    expect(result[0]).toBe("Line one\nLine two");
    expect(result[1]).toBe("Line three\nLine four");
  });

  it("splits at single newline when no paragraph break is available", () => {
    const text = "Line one\nLine two\nLine three\nLine four";
    const result = splitResponse(text, 20);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(20);
    }
  });
});

describe("toSlackMrkdwn", () => {
  it("converts **bold** to *bold*", () => {
    expect(toSlackMrkdwn("**push notifications** shipped")).toBe("*push notifications* shipped");
  });

  it("converts multiple bold runs in one line", () => {
    expect(toSlackMrkdwn("**A** and **B** and **C**")).toBe("*A* and *B* and *C*");
  });

  it("converts __bold__ to _bold_", () => {
    expect(toSlackMrkdwn("__emphasized__ text")).toBe("_emphasized_ text");
  });

  it("converts [label](url) to <url|label>", () => {
    expect(toSlackMrkdwn("see [docs](https://example.com)")).toBe(
      "see <https://example.com|docs>",
    );
  });

  it("does not touch image syntax", () => {
    expect(toSlackMrkdwn("![alt](https://x.png)")).toBe("![alt](https://x.png)");
  });

  it("converts markdown headings to bold lines", () => {
    expect(toSlackMrkdwn("# Title\nbody")).toBe("*Title*\nbody");
    expect(toSlackMrkdwn("## Subtitle")).toBe("*Subtitle*");
    expect(toSlackMrkdwn("### Third")).toBe("*Third*");
  });

  it("leaves code blocks untouched", () => {
    const md = "intro **bold**\n```js\nconst x = **bold**;\n```\ntail **bold**";
    const out = toSlackMrkdwn(md);
    expect(out).toContain("```js\nconst x = **bold**;\n```");
    expect(out).toContain("intro *bold*");
    expect(out).toContain("tail *bold*");
  });

  it("leaves inline code untouched", () => {
    const out = toSlackMrkdwn("see `**raw**` token but **bold** here");
    expect(out).toBe("see `**raw**` token but *bold* here");
  });

  it("handles the example from the bug report", () => {
    const input = "**April recap (plain English):**\n\nYou shipped **push notifications** for the mobile app";
    const out = toSlackMrkdwn(input);
    expect(out).toContain("*April recap (plain English):*");
    expect(out).toContain("*push notifications*");
    expect(out).not.toContain("**");
  });
});
