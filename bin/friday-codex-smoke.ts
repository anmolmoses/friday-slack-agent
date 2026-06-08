#!/usr/bin/env bun
// Live smoke for the Codex brain spawner: validates real `codex exec` plumbing
// (args, stdin prompt, JSONL parse, session id, resume) against the ChatGPT
// subscription. Side-effect free prompts. Not a unit test — run manually.
import { spawnCodex } from "../src/codex/spawner.ts";
import { createSession, type ThreadSession } from "../src/session/types.ts";

const claudeCfg = {
  maxTurns: 25,
  timeoutMs: 600000,
  maxTimeoutMs: 1800000,
  permissionMode: "bypassPermissions",
};

function makeSession(overrides: Partial<ThreadSession> = {}): ThreadSession {
  return { ...createSession("smoke-thread", "C_SMOKE"), ...overrides };
}

const NO_ACTION =
  "SYSTEM SMOKE TEST — do not use any tools, do not read/write files, do not run commands.";

async function run() {
  console.log("→ Turn 1 (fresh session)…");
  const s1 = makeSession();
  const h1 = spawnCodex(
    s1,
    `${NO_ACTION} Reply with exactly one word: PONG`,
    claudeCfg,
    undefined,
    undefined,
    null,
    null,
  );

  const toolEvents: string[] = [];
  h1.onEvent((e) => {
    if (e.type === "assistant") {
      for (const b of e.message.content) {
        if (b.type === "tool_use") toolEvents.push(b.name ?? "tool");
      }
    }
  });

  const r1 = await h1.result;
  console.log("  sessionId:", r1.sessionId);
  console.log("  exitCode :", r1.exitCode);
  console.log("  error    :", r1.error?.slice(0, 200) ?? null);
  console.log("  response :", JSON.stringify(r1.response?.slice(0, 120)));
  console.log("  toolEvts :", toolEvents);

  if (!r1.sessionId) throw new Error("FAIL: no session id from turn 1");
  if (r1.exitCode !== 0) throw new Error(`FAIL: turn 1 exit ${r1.exitCode}`);
  if (!r1.response?.trim()) throw new Error("FAIL: empty response turn 1");

  console.log("\n→ Turn 2 (resume same session)…");
  const s2 = makeSession({ sessionId: r1.sessionId });
  const h2 = spawnCodex(
    s2,
    `${NO_ACTION} In one word, what did you just reply?`,
    claudeCfg,
    undefined,
    undefined,
    null,
    null,
  );
  const r2 = await h2.result;
  console.log("  sessionId:", r2.sessionId);
  console.log("  exitCode :", r2.exitCode);
  console.log("  error    :", r2.error?.slice(0, 200) ?? null);
  console.log("  response :", JSON.stringify(r2.response?.slice(0, 120)));

  if (r2.exitCode !== 0) throw new Error(`FAIL: turn 2 exit ${r2.exitCode}`);
  if (!r2.response?.trim()) throw new Error("FAIL: empty response turn 2");

  console.log("\n✅ Codex brain smoke passed (fresh + resume).");
}

run().catch((e) => {
  console.error("\n❌", e.message);
  process.exit(1);
});
