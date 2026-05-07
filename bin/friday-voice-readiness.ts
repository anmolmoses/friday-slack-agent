#!/usr/bin/env bun
// One-command readiness check for the FRIDAY voice route.
//
// This intentionally runs the same public smokes we use while tuning the daemon:
// routing tests, Mac-control permissions, direct-action latency, and a
// hardcoded-media-app scan.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { READINESS_FILE, readState, runningDaemonPid } from "../src/voice/control.ts";

interface CheckResult {
  name: string;
  ok: boolean;
  ms: number;
  command: string;
  summary?: string;
  metrics?: Record<string, unknown>;
  output?: string;
}

const REPO = process.cwd();
const BUN = process.env.BUN_BIN || process.execPath;
const FAST_ACTION_BUDGET_MS =
  process.env.FRIDAY_VOICE_READY_FAST_BUDGET_MS || "2200";
const LIVE_PROBE_BUDGET_MS =
  process.env.FRIDAY_VOICE_READY_LIVE_PROBE_BUDGET_MS || FAST_ACTION_BUDGET_MS;
const LIVE_PROBE_SETTLE_MS =
  process.env.FRIDAY_VOICE_READY_LIVE_SETTLE_MS || "1500";
const BACKGROUND_TOOL_BUDGET_MS =
  process.env.FRIDAY_VOICE_READY_BACKGROUND_TOOL_BUDGET_MS || "3200";
const DISPATCH_TOOL_BUDGET_MS =
  process.env.FRIDAY_VOICE_READY_DISPATCH_TOOL_BUDGET_MS || "3500";
const VISION_ACTION_BUDGET_MS =
  process.env.FRIDAY_VOICE_READY_VISION_BUDGET_MS || "5000";
const RG =
  process.env.RG_BIN ||
  [
    "/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex-path/rg",
    "/opt/homebrew/bin/rg",
    "/usr/local/bin/rg",
    `${process.env.HOME ?? ""}/.cargo/bin/rg`,
  ].find((candidate) => existsSync(candidate)) ||
  "rg";

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

function envPrefix(env: Record<string, string>): string {
  const entries = Object.entries(env);
  if (entries.length === 0) return "";
  return `${entries.map(([k, v]) => `${k}=${shellQuote(v)}`).join(" ")} `;
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function resolveVoiceUser(): { name: string; uid: string } | undefined {
  if (currentUid() !== 0) return undefined;
  const requested =
    process.env.FRIDAY_VOICE_READY_USER || process.env.SUDO_USER || "anmol";
  const explicitUid = process.env.FRIDAY_VOICE_READY_UID;
  if (explicitUid) return { name: requested, uid: explicitUid };
  const proc = spawnSync("id", ["-u", requested], {
    encoding: "utf8",
  });
  if (proc.status !== 0) return undefined;
  const uid = proc.stdout.trim();
  return uid ? { name: requested, uid } : undefined;
}

const VOICE_USER = resolveVoiceUser();

function envBool(name: string, def = false): boolean {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  return raw === "1" || raw.toLowerCase() === "true";
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runShell(
  name: string,
  command: string,
  env: Record<string, string> = {},
  asVoiceUser = false,
): CheckResult {
  const started = Date.now();
  const finalCommand =
    asVoiceUser && VOICE_USER
      ? [
          "launchctl",
          "asuser",
          VOICE_USER.uid,
          "sudo",
          "-u",
          shellQuote(VOICE_USER.name),
          "/bin/zsh",
          "-lc",
          shellQuote(`cd ${shellQuote(REPO)} && ${envPrefix(env)}${command}`),
        ].join(" ")
      : `${envPrefix(env)}${command}`;
  const proc = spawnSync("/bin/zsh", ["-lc", finalCommand], {
    cwd: REPO,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  const output = [proc.stdout, proc.stderr].filter(Boolean).join("\n").trim();
  return {
    name,
    ok: proc.status === 0,
    ms: Date.now() - started,
    command: finalCommand,
    output: output.slice(-6000),
  };
}

function extractJson(output: string): Record<string, unknown> | undefined {
  const trimmed = output.trim();
  for (let i = trimmed.lastIndexOf("\n{"); i >= 0; i = trimmed.lastIndexOf("\n{", i - 1)) {
    const candidate = trimmed.slice(i + 1);
    try {
      return JSON.parse(candidate) as Record<string, unknown>;
    } catch {
      /* try previous JSON-looking block */
    }
  }
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      /* no JSON */
    }
  }
  return undefined;
}

function summarizeJsonCheck(result: CheckResult): CheckResult {
  const json = extractJson(result.output ?? "");
  if (!json) return result;
  const failures = Array.isArray(json.failures)
    ? (json.failures as unknown[]).map(String)
    : [];
  const ok = result.ok && (json.ok !== false) && failures.length === 0;
  const firstAudioMs =
    typeof json.createToFirstAudioMs === "number"
      ? Math.round(json.createToFirstAudioMs)
      : undefined;
  const doneMs =
    typeof json.createToDoneMs === "number"
      ? Math.round(json.createToDoneMs)
      : undefined;
  const probeTurnAudioMs =
    typeof json.turnAudioMs === "number"
      ? Math.round(json.turnAudioMs)
      : undefined;
  const probeTurnDoneMs =
    typeof json.turnDoneMs === "number"
      ? Math.round(json.turnDoneMs)
      : undefined;
  const ack =
    json.localToolAck === true
      ? json.localToolAckCached === true
        ? "ack warm"
        : `ack cold${typeof json.localToolAckMs === "number" ? ` ${Math.round(json.localToolAckMs)}ms` : ""}`
      : undefined;
  return {
    ...result,
    ok,
    metrics: json,
    summary:
      firstAudioMs != null
        ? `first audio ${firstAudioMs}ms${doneMs != null ? `, voice ${doneMs}ms` : ""}, tool ${String(json.toolName ?? "-")}${ack ? `, ${ack}` : ""}, pre-tool audio ${String(json.audioBeforeFunction ?? "-")}, spoken ${String(json.assistantTranscriptCount ?? "-")}`
        : probeTurnAudioMs != null
          ? `queued ${String(json.queuedMs ?? "-")}ms, turn audio ${probeTurnAudioMs}ms${probeTurnDoneMs != null ? `, turn done ${probeTurnDoneMs}ms` : ""}, status ${String(json.status ?? "-")}`
        : Array.isArray(json.results)
          ? (json.results as Array<Record<string, unknown>>)
              .map((r) => `${String(r.name)}=${r.ok ? "ok" : "fail"}@${String(r.ms)}ms`)
              .join(", ")
        : typeof json.ok === "boolean"
          ? `ok=${json.ok}`
          : undefined,
  };
}

function runJsonSmoke(
  name: string,
  command: string,
  env: Record<string, string> = {},
  asUser = false,
): CheckResult {
  return summarizeJsonCheck(runShell(name, command, env, asUser));
}

function metricNumber(metrics: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = metrics?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

interface LiveDaemonProbeOptions {
  name: string;
  prompt: string;
  budgetMs?: string;
  requireResponseCount?: boolean;
  expectedTool?: string;
  actionSummaryIncludes?: string;
  requireBackgroundJob?: boolean;
  totalBudgetMs?: string;
  requireDirectAction?: boolean;
}

function runLiveDaemonProbe(options: LiveDaemonProbeOptions): CheckResult {
  const budget = Number(options.budgetMs ?? LIVE_PROBE_BUDGET_MS);
  const totalBudget =
    options.totalBudgetMs == null
      ? Number.POSITIVE_INFINITY
      : Number(options.totalBudgetMs);
  const settleMs = Number(LIVE_PROBE_SETTLE_MS);
  if (Number.isFinite(settleMs) && settleMs > 0) sleepSync(settleMs);
  const result = runJsonSmoke(
    options.name,
    `bin/friday-voice probe ${shellQuote(options.prompt)}`,
    {
      FRIDAY_VOICE_PROBE_JSON: "true",
      FRIDAY_VOICE_PROBE_RESTORE_LISTENING: "1",
    },
    true,
  );
  const metrics = result.metrics;
  const failures = Array.isArray(metrics?.failures)
    ? (metrics.failures as unknown[]).map(String).filter(Boolean)
    : [];
  const firstAudioMs = metricNumber(metrics, "firstAudioMs");
  const doneMs = metricNumber(metrics, "doneMs");
  const queuedMs = metricNumber(metrics, "queuedMs");
  const turnAudioMs = metricNumber(metrics, "turnAudioMs");
  const turnDoneMs = metricNumber(metrics, "turnDoneMs");
  const responseCount = metricNumber(metrics, "responseCount");
  const transcript = String(metrics?.transcript ?? "").trim();
  const actionTool =
    typeof metrics?.actionTool === "string" ? metrics.actionTool : undefined;
  const actionDirect = metrics?.actionDirect === true;
  const actionMs = metricNumber(metrics, "actionMs");
  const actionSummary =
    typeof metrics?.actionSummary === "string" ? metrics.actionSummary : "";
  const backgroundJobId =
    typeof metrics?.actionBackgroundJobId === "string"
      ? metrics.actionBackgroundJobId
      : undefined;

  if (!result.ok) failures.push("live daemon probe did not complete");
  if (turnAudioMs == null) {
    failures.push("live daemon did not report first audio");
  } else if (Number.isFinite(budget) && turnAudioMs > budget) {
    failures.push(`live daemon first audio ${Math.round(turnAudioMs)}ms exceeded ${budget}ms`);
  }
  if (firstAudioMs == null) {
    failures.push("live daemon did not report total first-audio latency");
  } else if (Number.isFinite(totalBudget) && firstAudioMs > totalBudget) {
    failures.push(
      `live daemon total first audio ${Math.round(firstAudioMs)}ms exceeded ${totalBudget}ms`,
    );
  }
  if (options.requireResponseCount && (responseCount ?? 0) < 1) {
    failures.push("live daemon reported no realtime response audio");
  }
  if (!transcript) failures.push("live daemon returned no spoken transcript");
  if (options.expectedTool && actionTool !== options.expectedTool) {
    failures.push(
      actionTool
        ? `live daemon used ${actionTool}, expected ${options.expectedTool}`
        : `live daemon did not report ${options.expectedTool} action`,
    );
  }
  if (options.requireDirectAction && !actionDirect) {
    failures.push(`live daemon action was not direct for ${options.expectedTool ?? "probe"}`);
  }
  if (options.requireBackgroundJob && !backgroundJobId) {
    failures.push("live daemon action did not start a background job");
  }
  if (
    options.actionSummaryIncludes &&
    !actionSummary.includes(options.actionSummaryIncludes)
  ) {
    failures.push(
      `live daemon action summary did not include "${options.actionSummaryIncludes}"`,
    );
  }

  return {
    ...result,
    ok: failures.length === 0,
    summary:
      turnAudioMs == null
        ? result.summary
        : [
            `turn audio ${Math.round(turnAudioMs)}ms/${Number.isFinite(budget) ? budget : "-"}ms budget`,
            firstAudioMs != null
              ? `total audio ${Math.round(firstAudioMs)}ms/${Number.isFinite(totalBudget) ? totalBudget : "-"}ms budget`
              : "",
            queuedMs != null ? `queued ${Math.round(queuedMs)}ms` : "",
            turnDoneMs != null ? `turn done ${Math.round(turnDoneMs)}ms` : "",
            doneMs != null ? `total done ${Math.round(doneMs)}ms` : "",
            actionTool
              ? `action ${actionDirect ? "direct " : ""}${actionTool}${actionMs != null ? ` ${Math.round(actionMs)}ms` : ""}`
              : "",
            options.actionSummaryIncludes && actionSummary.includes(options.actionSummaryIncludes)
              ? options.actionSummaryIncludes
              : "",
            backgroundJobId ? `job ${backgroundJobId}` : "",
          ]
            .filter(Boolean)
            .join(", "),
    output: failures.length > 0 ? failures.join("\n") : result.output,
  };
}

const checks: CheckResult[] = [];
const initialDaemonState = readState();
const initialDaemonPid = runningDaemonPid();
const shouldRestoreListening =
  envBool("FRIDAY_VOICE_READY_RESTORE_LISTENING", true) &&
  initialDaemonState?.listening === true &&
  initialDaemonPid === initialDaemonState.pid;

checks.push(
  runShell(
    "routing-tests",
    `${shellQuote(BUN)} test src/voice/action-routing.test.ts src/voice/engineering-routing.test.ts`,
  ),
);

checks.push(runShell("daemon-status", "bin/friday-voice status"));

{
  const started = Date.now();
  const state = readState();
  const failures: string[] = [];
  if (!state) {
    failures.push("daemon state is missing");
  } else {
    if (state.autoIdleAfterTurn) {
      failures.push("FRIDAY_VOICE_AUTO_IDLE_AFTER_TURN is enabled");
    }
    if (!state.backgroundTranscription) {
      failures.push("background transcription is disabled");
    }
  }
  checks.push({
    name: "responsive-daemon-config",
    ok: failures.length === 0,
    ms: Date.now() - started,
    command: "read /tmp/friday-voice/state.json",
    summary:
      failures.length === 0
        ? "auto-idle disabled and background transcription enabled"
        : failures.join("; "),
    metrics: state
      ? {
          listening: state.listening,
          autoIdleAfterTurn: state.autoIdleAfterTurn,
          backgroundTranscription: state.backgroundTranscription,
          localVadMinLevel: state.localVadMinLevel,
        }
      : undefined,
    output: failures.join("\n"),
  });
}

checks.push(
  runLiveDaemonProbe({
    name: "live-daemon-voice-probe",
    prompt: "Say exactly this sentence and nothing else: Ready.",
    requireResponseCount: true,
  }),
);

checks.push(
  runLiveDaemonProbe({
    name: "live-background-action-probe",
    prompt: "run command: sleep 2; printf friday-live-bg-ok",
    budgetMs: FAST_ACTION_BUDGET_MS,
    expectedTool: "run_shell",
    requireBackgroundJob: true,
  }),
);

checks.push(
  runLiveDaemonProbe({
    name: "live-browser-action-probe",
    prompt: "open https://example.com in Google Chrome",
    budgetMs: FAST_ACTION_BUDGET_MS,
    expectedTool: "browser_open_url",
  }),
);

checks.push(
  runLiveDaemonProbe({
    name: "live-mouse-permission-probe",
    prompt: "check if you can control the mouse",
    budgetMs: FAST_ACTION_BUDGET_MS,
    expectedTool: "mouse_control",
    requireDirectAction: true,
  }),
);

if (envBool("FRIDAY_VOICE_READY_INCLUDE_SCREEN", true)) {
  checks.push(
    runLiveDaemonProbe({
      name: "live-screen-vision-probe",
      prompt: "read the visible text on my screen and answer in one short sentence",
      budgetMs: FAST_ACTION_BUDGET_MS,
      expectedTool: "screen_see",
      requireDirectAction: true,
    }),
  );
}

checks.push(
  runLiveDaemonProbe({
    name: "live-memory-action-probe",
    prompt: "dry run open Music and play my favorite song",
    budgetMs: FAST_ACTION_BUDGET_MS,
    expectedTool: "app_search_text",
    actionSummaryIncludes: "Numb by Linkin Park",
  }),
);

checks.push(
  runLiveDaemonProbe({
    name: "live-engineering-dispatch-probe",
    prompt:
      "dry-run engineering dispatch: review the backend API route and report a concise plan. Do not make changes.",
    budgetMs: FAST_ACTION_BUDGET_MS,
    expectedTool: "dispatch_engineering",
    actionSummaryIncludes: "Dry run: local Codex dispatch prepared",
  }),
);

{
  const started = Date.now();
  const failures: string[] = [];
  try {
    const shim = readFileSync(path.join(REPO, "bin/friday-voice"), "utf8");
    const cli = readFileSync(path.join(REPO, "src/voice/cli.ts"), "utf8");
    if (!shim.includes("unset OPENAI_API_KEY")) {
      failures.push("bin/friday-voice does not clear inherited OPENAI_API_KEY");
    }
    if (!shim.includes("FRIDAY_VOICE_ALLOW_ENV_OPENAI_KEY")) {
      failures.push("bin/friday-voice has no opt-out for repo .env key preference");
    }
    if (!cli.includes('path.join(repoRoot, "bin/friday-voice")')) {
      failures.push("detached launcher does not route startup through bin/friday-voice");
    }
  } catch (err) {
    failures.push(err instanceof Error ? err.message : String(err));
  }
  checks.push({
    name: "launcher-key-hygiene",
    ok: failures.length === 0,
    ms: Date.now() - started,
    command: "inspect bin/friday-voice and src/voice/cli.ts",
    summary:
      failures.length === 0
        ? "zero-start uses shim and repo .env key preference"
        : failures.join("; "),
    output: failures.join("\n"),
  });
}

{
  const started = Date.now();
  const failures: string[] = [];
  const stateDir = path.dirname(READINESS_FILE);
  const probeFile = path.join(stateDir, `.readiness-write-${process.pid}.tmp`);
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(probeFile, "ok");
    rmSync(probeFile, { force: true });
  } catch (err) {
    failures.push(err instanceof Error ? err.message : String(err));
  }
  checks.push({
    name: "state-dir-writable",
    ok: failures.length === 0,
    ms: Date.now() - started,
    command: `write ${probeFile}`,
    summary:
      failures.length === 0
        ? `${stateDir} is writable by the readiness user`
        : failures.join("; "),
    output: failures.join("\n"),
  });
}

checks.push(
  runShell(
    "codex-cli-shape",
    "codex --ask-for-approval never --search exec --help >/dev/null",
    {},
    true,
  ),
);

checks.push(
  runJsonSmoke(
    "dispatch-engineering-dry-run",
    `${shellQuote(BUN)} run bin/friday-voice-dispatch-smoke.ts`,
    {},
    true,
  ),
);

checks.push(
  runJsonSmoke(
    "direct-engineering-dispatch-latency",
    `${shellQuote(BUN)} run bin/friday-voice-latency-smoke.ts`,
    {
      FRIDAY_VOICE_DISPATCH_DRY_RUN: "1",
      FRIDAY_VOICE_SMOKE_DIRECT_ACTION: "true",
      FRIDAY_VOICE_SMOKE_FIRST_AUDIO_BUDGET_MS: FAST_ACTION_BUDGET_MS,
      FRIDAY_VOICE_SMOKE_EXPECTED_TOOL: "dispatch_engineering",
      FRIDAY_VOICE_SMOKE_DIRECT_ARGS_JSON:
        '{"prompt":"Review the backend API route and report a concise plan. Do not make changes.","engine":"auto"}',
    },
    true,
  ),
);

if (envBool("FRIDAY_VOICE_READY_INCLUDE_DISPATCH_TOOL", false)) {
  checks.push(
    runJsonSmoke(
      "realtime-dispatch-tool-latency",
      `${shellQuote(BUN)} run bin/friday-voice-latency-smoke.ts`,
      {
        FRIDAY_VOICE_DISPATCH_DRY_RUN: "1",
        FRIDAY_VOICE_SMOKE_EXPECTED_TOOL: "dispatch_engineering",
        FRIDAY_VOICE_SMOKE_FORCE_EXPECTED_TOOL: "true",
        FRIDAY_VOICE_SMOKE_FIRST_AUDIO_BUDGET_MS: DISPATCH_TOOL_BUDGET_MS,
        FRIDAY_VOICE_SMOKE_PROMPT:
          "Call dispatch_engineering with prompt: Review the backend API route and report a concise plan. Do not make changes. Use engine auto. Do not speak before the tool call; after the result, say one short acknowledgement.",
      },
      true,
    ),
  );
}

checks.push(
  runJsonSmoke(
    "tool-permissions",
    `${shellQuote(BUN)} run bin/friday-voice-tool-smoke.ts`,
    {},
    true,
  ),
);

checks.push(
  runJsonSmoke(
    "direct-shell-latency",
    `${shellQuote(BUN)} run bin/friday-voice-latency-smoke.ts`,
    {
      FRIDAY_VOICE_SMOKE_DIRECT_ACTION: "true",
      FRIDAY_VOICE_SMOKE_FIRST_AUDIO_BUDGET_MS: FAST_ACTION_BUDGET_MS,
    },
    true,
  ),
);

checks.push(
  runJsonSmoke(
    "casual-speech-latency",
    `${shellQuote(BUN)} run bin/friday-voice-latency-smoke.ts`,
    {
      FRIDAY_VOICE_SMOKE_NO_TOOL: "true",
      FRIDAY_VOICE_SMOKE_FIRST_AUDIO_BUDGET_MS: FAST_ACTION_BUDGET_MS,
      FRIDAY_VOICE_SMOKE_EXPECTED_TOOL: "none",
      FRIDAY_VOICE_SMOKE_PROMPT:
        "Say exactly this sentence and nothing else: Ready.",
    },
    true,
  ),
);

checks.push(
  runJsonSmoke(
    "realtime-shell-background-tool-latency",
    `${shellQuote(BUN)} run bin/friday-voice-latency-smoke.ts`,
    {
      FRIDAY_VOICE_SMOKE_EXPECTED_TOOL: "run_shell",
      FRIDAY_VOICE_SMOKE_FORCE_EXPECTED_TOOL: "true",
      FRIDAY_VOICE_SMOKE_FIRST_AUDIO_BUDGET_MS: BACKGROUND_TOOL_BUDGET_MS,
    },
    true,
  ),
);

checks.push(
  runJsonSmoke(
    "direct-browser-latency",
    `${shellQuote(BUN)} run bin/friday-voice-latency-smoke.ts`,
    {
      FRIDAY_VOICE_SMOKE_DIRECT_ACTION: "true",
      FRIDAY_VOICE_SMOKE_FIRST_AUDIO_BUDGET_MS: FAST_ACTION_BUDGET_MS,
      FRIDAY_VOICE_SMOKE_EXPECTED_TOOL: "browser_open_url",
      FRIDAY_VOICE_SMOKE_DIRECT_ARGS_JSON:
        '{"url":"https://example.com","app":"Google Chrome"}',
    },
    true,
  ),
);

checks.push(
  runJsonSmoke(
    "direct-browser-submit-latency",
    `${shellQuote(BUN)} run bin/friday-voice-latency-smoke.ts`,
    {
      FRIDAY_VOICE_SMOKE_DIRECT_ACTION: "true",
      FRIDAY_VOICE_SMOKE_FIRST_AUDIO_BUDGET_MS: FAST_ACTION_BUDGET_MS,
      FRIDAY_VOICE_SMOKE_EXPECTED_TOOL: "browser_submit_text",
      FRIDAY_VOICE_SMOKE_DIRECT_ARGS_JSON:
        '{"url":"google.com","text":"OpenAI realtime docs","app":"Google Chrome","submit":true,"verify":false}',
    },
    true,
  ),
);

checks.push(
  runJsonSmoke(
    "direct-generic-app-latency",
    `${shellQuote(BUN)} run bin/friday-voice-latency-smoke.ts`,
    {
      FRIDAY_VOICE_SMOKE_DIRECT_ACTION: "true",
      FRIDAY_VOICE_SMOKE_FIRST_AUDIO_BUDGET_MS: FAST_ACTION_BUDGET_MS,
      FRIDAY_VOICE_SMOKE_EXPECTED_TOOL: "open_app",
      FRIDAY_VOICE_SMOKE_DIRECT_ARGS_JSON: '{"name":"Calculator"}',
    },
    true,
  ),
);

checks.push(
  runJsonSmoke(
    "direct-app-search-latency",
    `${shellQuote(BUN)} run bin/friday-voice-latency-smoke.ts`,
    {
      FRIDAY_VOICE_SMOKE_DIRECT_ACTION: "true",
      FRIDAY_VOICE_SMOKE_FIRST_AUDIO_BUDGET_MS: FAST_ACTION_BUDGET_MS,
      FRIDAY_VOICE_SMOKE_EXPECTED_TOOL: "app_search_text",
      FRIDAY_VOICE_SMOKE_DIRECT_ARGS_JSON:
        '{"app":"Music","text":"Numb by Linkin Park","shortcut":"cmd+l","submit":true,"mode":"play","dry_run":true}',
    },
    true,
  ),
);

checks.push(
  runJsonSmoke(
    "direct-app-send-draft-latency",
    `${shellQuote(BUN)} run bin/friday-voice-latency-smoke.ts`,
    {
      FRIDAY_VOICE_SMOKE_DIRECT_ACTION: "true",
      FRIDAY_VOICE_SMOKE_FIRST_AUDIO_BUDGET_MS: FAST_ACTION_BUDGET_MS,
      FRIDAY_VOICE_SMOKE_EXPECTED_TOOL: "app_send_text",
      FRIDAY_VOICE_SMOKE_DIRECT_ARGS_JSON:
        '{"app":"Slack","destination":"agent-test","text":"friday readiness draft","shortcut":"cmd+k","submit":false,"dry_run":true}',
    },
    true,
  ),
);

checks.push(
  runJsonSmoke(
    "direct-screen-brief-latency",
    `${shellQuote(BUN)} run bin/friday-voice-latency-smoke.ts`,
    {
      FRIDAY_VOICE_SMOKE_DIRECT_ACTION: "true",
      FRIDAY_VOICE_SMOKE_FIRST_AUDIO_BUDGET_MS: FAST_ACTION_BUDGET_MS,
      FRIDAY_VOICE_SMOKE_EXPECTED_TOOL: "screen_brief",
      FRIDAY_VOICE_SMOKE_DIRECT_ARGS_JSON: "{}",
    },
    true,
  ),
);

if (envBool("FRIDAY_VOICE_READY_INCLUDE_SCREEN", true)) {
  checks.push(
    runJsonSmoke(
      "direct-screen-latency",
      `${shellQuote(BUN)} run bin/friday-voice-latency-smoke.ts`,
      {
        FRIDAY_VOICE_SMOKE_DIRECT_ACTION: "true",
        FRIDAY_VOICE_SMOKE_EXPECTED_TOOL: "screen_see",
        FRIDAY_VOICE_SMOKE_FIRST_AUDIO_BUDGET_MS: VISION_ACTION_BUDGET_MS,
        FRIDAY_VOICE_SMOKE_DIRECT_ARGS_JSON:
          '{"prompt":"Inspect the current Mac screen and summarize the visible state briefly."}',
      },
      true,
    ),
  );
}

const disallowedMediaApp = ["spo", "tify"].join("");
const hardcodeScanTargets = [
  "src/voice",
  "docs/features/voice-route.md",
  ".env.example",
  "friday-personal/VOICE.md",
  "bin/friday-voice-dispatch-smoke.ts",
  "bin/friday-voice-latency-smoke.ts",
  "bin/friday-voice-tool-smoke.ts",
  "bin/friday-voice-readiness.ts",
];
checks.push(
  runShell(
    "no-hardcoded-media-app-voice-code",
    `${shellQuote(RG)} -n -i ${shellQuote(disallowedMediaApp)} ${hardcodeScanTargets.map(shellQuote).join(" ")} || true`,
  ),
);

const hardcodeCheck = checks.find((c) => c.name === "no-hardcoded-media-app-voice-code");
if (hardcodeCheck) {
  hardcodeCheck.ok = !(hardcodeCheck.output ?? "").trim();
  hardcodeCheck.summary = hardcodeCheck.ok ? "no matches" : "unexpected matches";
}

{
  const started = Date.now();
  const failures: string[] = [];
  let summary = "not needed";
  const currentPid = runningDaemonPid();
  const currentState = readState();
  if (shouldRestoreListening) {
    if (currentPid !== initialDaemonPid || currentState?.pid !== initialDaemonPid) {
      failures.push("daemon pid changed during readiness");
    } else if (currentState.listening && currentState.wsConnected) {
      summary = "still listening";
    } else {
      try {
        process.kill(initialDaemonPid, "SIGUSR2");
        const deadline = Date.now() + 7_000;
        let restored = readState();
        while (Date.now() < deadline) {
          restored = readState();
          if (
            runningDaemonPid() === initialDaemonPid &&
            restored?.pid === initialDaemonPid &&
            restored.listening &&
            restored.wsConnected
          ) {
            break;
          }
          sleepSync(100);
        }
        if (
          runningDaemonPid() === initialDaemonPid &&
          restored?.pid === initialDaemonPid &&
          restored.listening &&
          restored.wsConnected
        ) {
          summary = "restored listening";
        } else {
          failures.push(
            `restore incomplete (listening=${restored?.listening ?? false}, ws=${restored?.wsConnected ?? false})`,
          );
        }
      } catch (err) {
        failures.push(err instanceof Error ? err.message : String(err));
      }
    }
  }
  checks.push({
    name: "restore-listening-state",
    ok: failures.length === 0,
    ms: Date.now() - started,
    command: "restore initial daemon listening state",
    summary,
    metrics: {
      initialPid: initialDaemonPid,
      initialListening: initialDaemonState?.listening ?? false,
      finalPid: runningDaemonPid(),
      finalListening: readState()?.listening ?? false,
    },
    output: failures.join("\n"),
  });
}

const ok = checks.every((c) => c.ok);
const summary = {
  ok,
  at: new Date().toISOString(),
  voiceUser: VOICE_USER,
  budgets: {
    fastActionFirstAudioMs: Number(FAST_ACTION_BUDGET_MS),
    liveProbeFirstAudioMs: Number(LIVE_PROBE_BUDGET_MS),
    liveProbeSettleMs: Number(LIVE_PROBE_SETTLE_MS),
    backgroundToolFirstAudioMs: Number(BACKGROUND_TOOL_BUDGET_MS),
    dispatchToolFirstAudioMs: Number(DISPATCH_TOOL_BUDGET_MS),
    visionActionFirstAudioMs: Number(VISION_ACTION_BUDGET_MS),
  },
  checks: checks.map(({ output, ...check }) => ({
    ...check,
    ...(check.ok ? {} : { output }),
  })),
};

try {
  mkdirSync(path.dirname(READINESS_FILE), { recursive: true });
  writeFileSync(READINESS_FILE, JSON.stringify(summary, null, 2));
} catch (err) {
  console.error(`Failed to write readiness summary to ${READINESS_FILE}: ${err}`);
}

console.log(JSON.stringify(summary, null, 2));
process.exit(ok ? 0 : 1);
