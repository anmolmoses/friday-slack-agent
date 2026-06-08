#!/usr/bin/env bun
// Fast local smoke for FRIDAY's Mac/browser control tools.
//
// Run as the same macOS user that runs the voice daemon. It verifies the common
// "can she actually do stuff?" permissions without going through the mic.

import { loadVoiceConfig } from "../src/voice/config.ts";
import { ToolRunner, type ToolRunResult } from "../src/voice/tools.ts";

interface ToolSmokeResult {
  name: string;
  ok: boolean;
  ms: number;
  output: string;
}

function toolOutput(result: ToolRunResult): string {
  return typeof result === "string" ? result : result.output;
}

function looksFailed(output: string): boolean {
  return (
    /^Tool .* failed:/i.test(output) ||
    /\bpermission denied\b/i.test(output) ||
    /\bneeds macOS\b/i.test(output) ||
    /\bGrant .* permission\b/i.test(output) ||
    /\bnot trusted\b/i.test(output) ||
    /\bunavailable\b/i.test(output) ||
    /\btimed out\b/i.test(output) ||
    /\bfailed:/i.test(output)
  );
}

async function main(): Promise<void> {
  const cfg = loadVoiceConfig();
  const runner = new ToolRunner(cfg);
  const openUrl =
    process.env.FRIDAY_VOICE_TOOL_SMOKE_OPEN_URL || "https://example.com";
  const checks: Array<[string, Record<string, unknown>]> = [
    ["screen_screenshot", { note: "friday-tool-smoke" }],
    ["browser_page_text", { url: "https://example.com", max_chars: 600 }],
    ["browser_open_url", { url: openUrl, app: "Google Chrome" }],
    ["mouse_control", { action: "check" }],
  ];
  const results: ToolSmokeResult[] = [];

  for (const [name, args] of checks) {
    const t0 = Date.now();
    try {
      const output = toolOutput(await runner.exec(name, args));
      results.push({
        name,
        ok: !looksFailed(output),
        ms: Date.now() - t0,
        output: output.slice(0, 1200),
      });
    } catch (err) {
      results.push({
        name,
        ok: false,
        ms: Date.now() - t0,
        output: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const ok = results.every((r) => r.ok);
  console.log(JSON.stringify({ ok, results }, null, 2));
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
