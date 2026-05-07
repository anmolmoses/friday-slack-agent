#!/usr/bin/env bun
// Safe smoke for the real dispatch_engineering voice tool.
//
// It exercises ToolRunner.exec("dispatch_engineering", ...) with Terminal launch
// disabled, proving repo inference and local Codex command construction without
// starting a real agent session.

import { loadVoiceConfig } from "../src/voice/config.ts";
import { ToolRunner, type ToolRunResult } from "../src/voice/tools.ts";

interface DispatchSmokeResult {
  ok: boolean;
  failures: string[];
  ms: number;
  output: string;
}

function toolOutput(result: ToolRunResult): string {
  return typeof result === "string" ? result : result.output;
}

async function main(): Promise<void> {
  const started = Date.now();
  const previousDryRun = process.env.FRIDAY_VOICE_DISPATCH_DRY_RUN;
  process.env.FRIDAY_VOICE_DISPATCH_DRY_RUN = "1";
  const cfg = loadVoiceConfig();
  const runner = new ToolRunner(cfg);
  const prompt =
    process.env.FRIDAY_VOICE_DISPATCH_SMOKE_PROMPT ||
    "Review the backend API route and report a concise plan. Do not make changes.";
  const repo = process.env.FRIDAY_VOICE_DISPATCH_SMOKE_REPO;
  const engine = process.env.FRIDAY_VOICE_DISPATCH_SMOKE_ENGINE || "auto";
  const output = toolOutput(
    await runner.exec("dispatch_engineering", {
      prompt,
      ...(repo ? { repo } : {}),
      engine,
    }),
  );
  if (previousDryRun == null) delete process.env.FRIDAY_VOICE_DISPATCH_DRY_RUN;
  else process.env.FRIDAY_VOICE_DISPATCH_DRY_RUN = previousDryRun;

  const failures: string[] = [];
  if (!/Dry run: local Codex dispatch prepared/i.test(output)) {
    failures.push("dispatch_engineering did not use local Codex dry-run path.");
  }
  if (!/codex --ask-for-approval never --search exec\b/.test(output)) {
    failures.push("Codex command is missing the supported top-level flag order.");
  }
  if (/codex exec --ask-for-approval|codex exec --search/i.test(output)) {
    failures.push("Codex command uses the old unsupported exec-first flag order.");
  }
  if (/Slack|Claude dispatch|SLACK_VOICE_CHANNEL|dispatch_to_claude/i.test(output)) {
    failures.push("Output suggests Slack/Claude dispatch instead of local Codex.");
  }
  if (/which repo|ask the user|need.*repo/i.test(output)) {
    failures.push("Dispatch asked for a repo instead of inferring one.");
  }

  const result: DispatchSmokeResult = {
    ok: failures.length === 0,
    failures,
    ms: Date.now() - started,
    output,
  };
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
