import { describe, it, expect } from "bun:test";
import { mapCodexEvent } from "./spawner.ts";

// Event samples are the real shapes emitted by `codex exec --json` (codex-cli 0.137).
describe("mapCodexEvent", () => {
  it("maps thread.started to a system/init carrying the resume id", () => {
    const out = mapCodexEvent({
      type: "thread.started",
      thread_id: "019ea680-70e5-75e2-9132-5fa53bb41a3a",
    });
    expect(out).toEqual([
      {
        type: "system",
        subtype: "init",
        session_id: "019ea680-70e5-75e2-9132-5fa53bb41a3a",
      },
    ]);
  });

  it("maps an agent_message item to an assistant text block", () => {
    const out = mapCodexEvent({
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text: "PONG" },
    });
    expect(out).toEqual([
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "PONG" }] },
      },
    ]);
  });

  it("maps a reasoning item to a thinking block", () => {
    const out = mapCodexEvent({
      type: "item.completed",
      item: { id: "r1", type: "reasoning", text: "thinking..." },
    });
    expect(out[0]).toMatchObject({
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "thinking..." }] },
    });
  });

  it("maps any other completed item to a tool_use block for status display", () => {
    const out = mapCodexEvent({
      type: "item.completed",
      item: {
        id: "c1",
        type: "command_execution",
        command: "ls -la",
        exit_code: 0,
      },
    });
    expect(out).toHaveLength(1);
    const block = (out[0] as any).message.content[0];
    expect(block.type).toBe("tool_use");
    expect(block.name).toBe("command_execution");
    expect(block.input).toEqual({ command: "ls -la", exit_code: 0 });
    // id/type are stripped from the surfaced input
    expect(block.input.id).toBeUndefined();
    expect(block.input.type).toBeUndefined();
  });

  it("maps turn.completed to a success result", () => {
    const out = mapCodexEvent({
      type: "turn.completed",
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    expect(out).toEqual([{ type: "result", subtype: "success" }]);
  });

  it("maps turn.failed/error to an error result with the message", () => {
    expect(mapCodexEvent({ type: "turn.failed", error: { message: "boom" } })).toEqual([
      { type: "result", subtype: "error", result: "boom" },
    ]);
    expect(mapCodexEvent({ type: "error", error: "rate limited" })).toEqual([
      { type: "result", subtype: "error", result: "rate limited" },
    ]);
  });

  it("ignores noise: turn.started, item.started, unknown types, empty text", () => {
    expect(mapCodexEvent({ type: "turn.started" })).toEqual([]);
    expect(mapCodexEvent({ type: "item.started", item: { type: "agent_message" } })).toEqual([]);
    expect(mapCodexEvent({ type: "thread.metadata" })).toEqual([]);
    expect(
      mapCodexEvent({ type: "item.completed", item: { type: "agent_message", text: "" } }),
    ).toEqual([]);
  });
});
