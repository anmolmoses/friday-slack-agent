#!/usr/bin/env bun
// Friday voice CLI — the surface skhd / `bin/friday-voice` calls.
//
//   start    run the daemon in the foreground (starts idle). `bun run voice`.
//   toggle   flip listening on a running daemon (SIGUSR2); if none, launch one
//            detached and start it listening. This is what the hotkey calls.
//   stop     SIGTERM a running daemon.
//   status   print the daemon state.
//   probe    inject text into the live daemon to test the actual running path.

import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runDaemon } from "./daemon.ts";
import { appendFileSync, chmodSync, readFileSync, writeFileSync } from "node:fs";
import { inspect } from "node:util";
import { loadVoiceConfig } from "./config.ts";
import { loadVoicePersona } from "./persona.ts";
import { MicCapture, Player } from "./audio.ts";
import { RealtimeClient } from "./realtime.ts";
import { toolDefsForConfig } from "./tools.ts";
import {
  runningDaemonPid,
  readState,
  writeInjectRequest,
  ensureStateDir,
  LOG_FILE,
  READINESS_FILE,
  SHORTCUT_LOG_FILE,
  type DaemonState,
  type VoiceActionState,
  type VoiceLatencyState,
  type VoiceProbeState,
  type VoiceSpeakerState,
  type VoiceVisionState,
} from "./control.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function stringifyLogArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.stack ?? arg.message;
  return inspect(arg, { colors: false, depth: 4, breakLength: 160 });
}

function installVisibleLogTee(): void {
  if (!process.stdout.isTTY) return;
  ensureStateDir();
  const originalLog = console.log.bind(console);
  const originalError = console.error.bind(console);
  const write = (kind: "log" | "error", args: unknown[]) => {
    const line = args.map(stringifyLogArg).join(" ");
    try {
      appendFileSync(
        LOG_FILE,
        `[${new Date().toISOString()}] [voice:${kind}] ${line}\n`,
      );
    } catch {
      /* keep console logging even if the file cannot be written */
    }
  };
  console.log = (...args: unknown[]) => {
    originalLog(...args);
    write("log", args);
  };
  console.error = (...args: unknown[]) => {
    originalError(...args);
    write("error", args);
  };
  write("log", ["visible daemon log tee attached"]);
}

async function runOutputTest(text: string): Promise<void> {
  const cfg = loadVoiceConfig();
  const persona = await loadVoicePersona();
  const toolDefs = toolDefsForConfig(cfg);
  const player = new Player(
    cfg.sampleRate,
    cfg.playbackPrebufferMs,
    cfg.audioPlayer,
    cfg.playbackGain,
  );

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      player.flush();
      client.close();
      reject(new Error("Timed out waiting for Realtime output audio."));
    }, 20_000);

    const client = new RealtimeClient(cfg, persona, toolDefs, {
      onAudioDelta: (pcm) => player.write(pcm),
      onSpeechStarted: () => {},
      onFunctionCall: ({ callId, name }) =>
        client.sendFunctionResult(callId, `Output test skipped tool ${name}.`),
      onOpen: () => client.sendText(text),
      onResponseDone: () => {
        clearTimeout(timer);
        player.finishSoon();
        setTimeout(() => {
          client.close();
          resolve();
        }, 3500);
      },
      onClose: () => {},
    });

    client.connect();
  });
}

async function runMicTest(ms: number): Promise<void> {
  const cfg = loadVoiceConfig();
  let peak = 0;
  let chunks = 0;
  let bytes = 0;
  const mic = new MicCapture(
    cfg.micIndex,
    cfg.sampleRate,
    (b64) => {
      chunks++;
      bytes += Buffer.from(b64, "base64").byteLength;
    },
    (level) => {
      peak = Math.max(peak, level);
    },
    cfg.micGain,
  );

  mic.start();
  await new Promise((resolve) => setTimeout(resolve, ms));
  mic.stop();
  console.log(
    `Mic test (${Math.round(ms / 1000)}s): ${chunks} chunks, ${Math.round(bytes / 1024)} KB, peak ${peak.toFixed(3)}` +
      (peak < 0.01
        ? "\nMic is effectively silent. Check macOS Microphone permission for the app launching Friday voice."
        : ""),
  );
}

function fmtMs(ms: number | undefined): string {
  return ms == null ? "-" : `${ms}ms`;
}

function formatLatencyStatus(lat: VoiceLatencyState | undefined): string {
  if (!lat) return "";
  const ageSec = Math.round((Date.now() - lat.at) / 1000);
  return (
    "\n" +
    `  last latency: stop->audio ${fmtMs(lat.stopToFirstAudioMs)}, stop->done ${fmtMs(lat.stopToDoneMs)} (${ageSec}s ago)\n` +
    `                speech ${fmtMs(lat.speechMs)}, transcript ${fmtMs(lat.stopToTranscriptMs)}, memory ${fmtMs(lat.memoryRecallMs)}, model ${fmtMs(lat.responseCreateToFirstAudioMs)}`
  );
}

function formatActionStatus(action: VoiceActionState | undefined): string {
  if (!action) return "";
  const ageSec = Math.round((Date.now() - action.at) / 1000);
  return (
    "\n" +
    `  last action:  ${action.direct ? "direct " : ""}${action.tool} ${fmtMs(action.ms)} (${ageSec}s ago)\n` +
    `                ${clipStatus(action.summary)}${action.backgroundJobId ? ` [job ${action.backgroundJobId}]` : ""}`
  );
}

function formatProbeStatus(probe: VoiceProbeState | undefined): string {
  if (!probe) return "";
  const ageSec = Math.round((Date.now() - probe.at) / 1000);
  const turnAudioMs =
    probe.firstAudioMs == null || probe.turnStartMs == null
      ? undefined
      : Math.max(0, probe.firstAudioMs - probe.turnStartMs);
  const timing = [
    probe.turnStartMs == null ? null : `queued ${fmtMs(probe.turnStartMs)}`,
    probe.firstAudioMs == null ? null : `audio ${fmtMs(probe.firstAudioMs)}`,
    turnAudioMs == null ? null : `turn audio ${fmtMs(turnAudioMs)}`,
    probe.doneMs == null ? null : `done ${fmtMs(probe.doneMs)}`,
    probe.responseCount == null ? null : `responses ${probe.responseCount}`,
  ]
    .filter(Boolean)
    .join(", ");
  const detail =
    probe.transcript ||
    probe.message ||
    probe.text;
  return (
    "\n" +
    `  live probe:   ${probe.status}${timing ? ` (${timing})` : ""} (${ageSec}s ago)\n` +
    `                ${clipStatus(detail)}`
  );
}

function formatMicSignalStatus(state: DaemonState): string {
  if (!state.listening) return "idle";
  if (!state.micObservedAt) return "waiting for chunks";
  const chunks = state.micChunkCount ?? 0;
  if (!state.micLastSignalAt) {
    return `quiet (no >0.01 signal yet, ${chunks} chunks)`;
  }
  const ageSec = Math.max(0, Math.round((Date.now() - state.micLastSignalAt) / 1000));
  return `last signal ${ageSec}s ago (${chunks} chunks)`;
}

function clipStatus(s: string, n = 110): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

function formatPerceptionStatus(args: {
  vision?: VoiceVisionState;
  speaker?: VoiceSpeakerState;
}): string {
  const age = (at: number) => `${Math.max(0, Math.round((Date.now() - at) / 1000))}s ago`;
  return (
    "\n" +
    `  vision cache: ${args.vision ? `${clipStatus(args.vision.summary)} (${age(args.vision.at)})` : "-"}\n` +
    `  speaker:      ${args.speaker ? `${clipStatus(args.speaker.summary)} (${age(args.speaker.at)})` : "-"}`
  );
}

function formatShortcutLogLine(line: string): string {
  const match = line.match(/^\[([^\]]+)\]\s+friday-(?:hud|voice)\s+(.+)$/);
  if (!match) return clipStatus(line, 120);
  const at = Date.parse(match[1]);
  const age =
    Number.isFinite(at) && at > 0
      ? ` (${Math.max(0, Math.round((Date.now() - at) / 1000))}s ago)`
      : "";
  return `${clipStatus(match[2], 105)}${age}`;
}

function formatShortcutStatus(): string {
  try {
    const lines = readFileSync(SHORTCUT_LOG_FILE, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-120);
    const lastPressed = [...lines]
      .reverse()
      .find((line) => /friday-(?:hud|voice) hotkey .*(?:pressed|ignored duplicate)/.test(line));
    const lastRegistered = [...lines]
      .reverse()
      .find((line) => /friday-hud hotkey .* register status=/.test(line));
    return (
      "\n" +
      "  shortcuts:    ctrl+option+F / ctrl+option+cmd+F / cmd+option+space\n" +
      `  last hotkey:  ${lastPressed ? formatShortcutLogLine(lastPressed) : lastRegistered ? formatShortcutLogLine(lastRegistered) : "-"}`
    );
  } catch {
    return (
      "\n" +
      "  shortcuts:    ctrl+option+F / ctrl+option+cmd+F / cmd+option+space\n" +
      "  last hotkey:  -"
    );
  }
}

interface ReadinessCheckStatus {
  name: string;
  ok: boolean;
  ms?: number;
  summary?: string;
  metrics?: Record<string, unknown>;
}

interface ReadinessStatus {
  ok: boolean;
  at: string;
  budgets?: Record<string, unknown>;
  checks?: ReadinessCheckStatus[];
}

function readReadinessStatus(): ReadinessStatus | undefined {
  try {
    const parsed = JSON.parse(readFileSync(READINESS_FILE, "utf8")) as ReadinessStatus;
    if (!parsed || typeof parsed.ok !== "boolean" || typeof parsed.at !== "string") {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function readinessAge(at: string): string {
  const ms = Date.now() - Date.parse(at);
  if (!Number.isFinite(ms) || ms < 0) return "unknown age";
  if (ms < 90_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 90 * 60_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
}

function readinessMetricMs(
  check: ReadinessCheckStatus | undefined,
  key = "createToFirstAudioMs",
): number | undefined {
  const value = check?.metrics?.[key];
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined;
}

function formatReadinessBudgets(status: ReadinessStatus): string {
  const b = status.budgets ?? {};
  const fast = typeof b.fastActionFirstAudioMs === "number" ? fmtMs(b.fastActionFirstAudioMs) : "-";
  const live =
    typeof b.liveProbeFirstAudioMs === "number" ? fmtMs(b.liveProbeFirstAudioMs) : "-";
  const settle =
    typeof b.liveProbeSettleMs === "number" ? fmtMs(b.liveProbeSettleMs) : "-";
  const bg =
    typeof b.backgroundToolFirstAudioMs === "number" ? fmtMs(b.backgroundToolFirstAudioMs) : "-";
  const dispatch =
    typeof b.dispatchToolFirstAudioMs === "number" ? fmtMs(b.dispatchToolFirstAudioMs) : "-";
  const vision =
    typeof b.visionActionFirstAudioMs === "number" ? fmtMs(b.visionActionFirstAudioMs) : "-";
  return `budgets fast ${fast}, live ${live} (settle ${settle}), bg ${bg}, dispatch ${dispatch}, vision ${vision}`;
}

function formatReadinessStatus(): string {
  const status = readReadinessStatus();
  if (!status) return "\n  readiness:   no run yet";

  const checks = status.checks ?? [];
  const byName = new Map(checks.map((check) => [check.name, check]));
  const failed = checks.filter((check) => !check.ok).map((check) => check.name);
  const labelPairs: Array<[string, string]> = [
    ["live-daemon-voice-probe", "live"],
    ["live-background-action-probe", "live bg"],
    ["live-browser-action-probe", "live browser"],
    ["live-mouse-permission-probe", "live mouse"],
    ["live-screen-vision-probe", "live screen"],
    ["live-engineering-dispatch-probe", "live engineer"],
    ["casual-speech-latency", "speech"],
    ["direct-shell-latency", "shell"],
    ["direct-generic-app-latency", "app"],
    ["direct-app-search-latency", "app search"],
    ["direct-app-send-draft-latency", "send"],
    ["direct-browser-latency", "browser"],
    ["direct-browser-submit-latency", "browser submit"],
    ["direct-engineering-dispatch-latency", "engineer"],
    ["direct-screen-brief-latency", "screen brief"],
    ["realtime-shell-background-tool-latency", "bg tool"],
    ["realtime-dispatch-tool-latency", "dispatch tool"],
    ["direct-screen-latency", "vision"],
  ];
  const latencies = labelPairs
    .map(([name, label]) => {
      const check = byName.get(name);
      const liveProbe = name.startsWith("live-");
      const firstMs =
        liveProbe
          ? readinessMetricMs(check, "firstAudioMs")
          : readinessMetricMs(check);
      const doneMs =
        liveProbe
          ? readinessMetricMs(check, "doneMs")
          : readinessMetricMs(check, "createToDoneMs");
      if (firstMs == null) return undefined;
      return doneMs == null
        ? `${label} ${fmtMs(firstMs)}`
        : `${label} ${fmtMs(firstMs)}/${fmtMs(doneMs)} voice`;
    })
    .filter((value): value is string => Boolean(value));
  const firstLine =
    `  readiness:   ${status.ok ? "ok" : "failing"} (${readinessAge(status.at)}); ` +
    (status.ok ? formatReadinessBudgets(status) : clipStatus(failed.join(", "), 92));
  const secondLine = latencies.length > 0 ? `\n                ${latencies.join(", ")}` : "";
  return `\n${firstLine}${secondLine}`;
}

async function spawnDetached(startListening: boolean): Promise<void> {
  ensureStateDir();
  appendFileSync(
    LOG_FILE,
    `[voice:cli] spawning detached daemon (startListening=${startListening})\n`,
  );
  const repoRoot = path.resolve(__dirname, "../..");
  const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const voiceBin = path.join(repoRoot, "bin/friday-voice");
  const startCmd = [
    `cd ${q(repoRoot)} &&`,
    `FRIDAY_VOICE_START_ON=${startListening ? "1" : "0"}`,
    q(voiceBin),
    "start",
    `>> ${q(LOG_FILE)} 2>&1`,
  ].join(" ");
  const detacher =
    process.env.FRIDAY_VOICE_DETACHER ||
    (process.platform === "darwin" ? "terminal" : "nohup");
  let cmd: string;
  if (detacher === "terminal") {
    const commandFile = path.join(path.dirname(LOG_FILE), "start-daemon.command");
    writeFileSync(
      commandFile,
      [
        "#!/bin/zsh",
        "set -e",
        `cd ${q(repoRoot)}`,
        `export FRIDAY_VOICE_START_ON=${startListening ? "1" : "0"}`,
        `exec ${q(voiceBin)} start`,
        "",
      ].join("\n"),
    );
    chmodSync(commandFile, 0o755);
    cmd = `/usr/bin/open -a Terminal ${q(commandFile)}`;
  } else if (detacher === "tmux") {
    cmd = [
        `tmux kill-session -t friday-voice-daemon 2>/dev/null || true;`,
        "tmux",
        "new-session",
        "-d",
        "-s",
        "friday-voice-daemon",
        q(startCmd),
      ].join(" ");
  } else {
    cmd = [
        "/usr/bin/nohup",
        "/bin/sh",
        "-lc",
        q(startCmd),
        `>> ${q(LOG_FILE)} 2>&1 < /dev/null &`,
      ].join(" ");
  }
  appendFileSync(
    LOG_FILE,
    `[voice:cli] detached command (${detacher}): ${cmd}\n`,
  );
  const proc = Bun.spawn(["/bin/sh", "-lc", cmd], {
    env: process.env as Record<string, string>,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDaemonPid(timeoutMs = 5_000): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = runningDaemonPid();
    if (pid) return pid;
    await sleep(100);
  }
  return runningDaemonPid();
}

async function waitForDaemonState(
  predicate: (state: DaemonState) => boolean,
  timeoutMs = 7_000,
): Promise<DaemonState | null> {
  const deadline = Date.now() + timeoutMs;
  let latest = readState();
  while (Date.now() < deadline) {
    latest = readState();
    if (latest && runningDaemonPid() === latest.pid && predicate(latest)) {
      return latest;
    }
    await sleep(100);
  }
  latest = readState();
  return latest && runningDaemonPid() === latest.pid && predicate(latest)
    ? latest
    : null;
}

async function waitForProbe(
  id: string,
  timeoutMs = 15_000,
): Promise<VoiceProbeState | undefined> {
  const deadline = Date.now() + timeoutMs;
  let latest: VoiceProbeState | undefined;
  while (Date.now() < deadline) {
    latest = readState()?.lastProbe;
    if (
      latest?.id === id &&
      ["done", "rejected", "error"].includes(latest.status)
    ) {
      return latest;
    }
    await sleep(100);
  }
  return readState()?.lastProbe ?? latest;
}

async function restoreListeningAfterProbe(
  pid: number,
  shouldRestoreListening: boolean,
): Promise<void> {
  if (!shouldRestoreListening) return;
  const livePid = runningDaemonPid();
  const state = readState();
  if (livePid !== pid || state?.pid !== pid || state.listening) return;
  process.kill(pid, "SIGUSR2");
  await sleep(500);
}

async function runLiveProbe(text: string): Promise<void> {
  const jsonOutput =
    process.env.FRIDAY_VOICE_PROBE_JSON === "1" ||
    process.env.FRIDAY_VOICE_PROBE_JSON?.toLowerCase() === "true";
  let pid = runningDaemonPid();
  const initialPid = pid;
  const shouldRestoreListening =
    initialPid != null && process.env.FRIDAY_VOICE_PROBE_RESTORE_LISTENING !== "0";
  if (!pid) {
    await spawnDetached(false);
    pid = await waitForDaemonPid();
  }
  if (!pid) {
    console.error("Voice daemon did not start for live probe.");
    process.exit(1);
  }

  const id = randomUUID();
  const requestAt = Date.now();
  writeInjectRequest({ id, text, at: requestAt });
  process.kill(pid, "SIGUSR1");
  const probe = await waitForProbe(id);
  if (!probe || probe.id !== id) {
    await restoreListeningAfterProbe(pid, shouldRestoreListening);
    console.error(`Live probe ${id} timed out before the daemon reported status.`);
    process.exit(1);
  }
  const turnAudioMs =
    probe.firstAudioMs == null || probe.turnStartMs == null
      ? undefined
      : Math.max(0, probe.firstAudioMs - probe.turnStartMs);
  const turnDoneMs =
    probe.doneMs == null || probe.turnStartMs == null
      ? undefined
      : Math.max(0, probe.doneMs - probe.turnStartMs);
  const timing = [
    probe.turnStartMs == null ? null : `queued ${fmtMs(probe.turnStartMs)}`,
    probe.firstAudioMs == null ? null : `first audio ${fmtMs(probe.firstAudioMs)}`,
    turnAudioMs == null ? null : `turn audio ${fmtMs(turnAudioMs)}`,
    turnDoneMs == null ? null : `turn done ${fmtMs(turnDoneMs)}`,
    probe.doneMs == null ? null : `done ${fmtMs(probe.doneMs)}`,
    probe.responseCount == null ? null : `${probe.responseCount} response(s)`,
  ]
    .filter(Boolean)
    .join(", ");
  const postProbeState = readState();
  const action =
    postProbeState?.lastAction?.at != null &&
    postProbeState.lastAction.at >= requestAt
      ? postProbeState.lastAction
      : undefined;
  if (jsonOutput) {
    console.log(
      JSON.stringify(
        {
          ok: probe.status === "done",
          failures: probe.status === "done" ? [] : [probe.message ?? probe.status],
          pid,
          status: probe.status,
          text: probe.text,
          transcript: probe.transcript ?? "",
          message: probe.message ?? "",
          queuedMs: probe.turnStartMs,
          firstAudioMs: probe.firstAudioMs,
          turnAudioMs,
          turnDoneMs,
          doneMs: probe.doneMs,
          responseCount: probe.responseCount ?? 0,
          ...(action
            ? {
                actionTool: action.tool,
                actionDirect: action.direct ?? false,
                actionMs: action.ms,
                actionAtMs: action.at - requestAt,
                actionSummary: action.summary,
                actionBackgroundJobId: action.backgroundJobId,
              }
            : {}),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `Live probe ${probe.status}${timing ? `: ${timing}` : ""}\n` +
        `Said: ${probe.transcript ? clipStatus(probe.transcript, 220) : "-"}\n` +
        `${probe.message ? `Message: ${probe.message}\n` : ""}` +
        `Text: ${clipStatus(probe.text, 220)}`,
    );
  }
  await restoreListeningAfterProbe(pid, shouldRestoreListening);
  if (probe.status !== "done") process.exit(1);
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "start";

  switch (cmd) {
    case "start": {
      const existing = runningDaemonPid();
      if (existing && existing !== process.pid) {
        console.log(`Voice daemon already running (pid ${existing}).`);
        return;
      }
      installVisibleLogTee();
      await runDaemon({
        startListening: process.env.FRIDAY_VOICE_START_ON === "1",
      });
      // runDaemon keeps the process alive (signals + interval); never returns.
      break;
    }

    case "toggle": {
      const pid = runningDaemonPid();
      if (pid) {
        process.kill(pid, "SIGUSR2");
        console.log(`Toggled voice (pid ${pid}).`);
      } else {
        await spawnDetached(true);
        const started = await waitForDaemonState(
          (state) => state.listening && state.wsConnected,
        );
        if (!started) {
          const state = readState();
          console.error(
            state
              ? `Voice daemon startup incomplete (pid ${state.pid}, listening=${state.listening}, ws=${state.wsConnected}).`
              : "Voice daemon did not report startup state.",
          );
          process.exit(1);
        }
        console.log(`Started voice daemon (pid ${started.pid}) — listening ON.`);
      }
      break;
    }

    case "stop": {
      const pid = runningDaemonPid();
      if (pid) {
        process.kill(pid, "SIGTERM");
        console.log(`Stopped voice daemon (pid ${pid}).`);
      } else {
        console.log("No voice daemon running.");
      }
      break;
    }

    case "status": {
      const pid = runningDaemonPid();
      const state = readState();
      if (!pid || !state) {
        console.log("Voice daemon: not running.");
        return;
      }
      console.log(
        `Voice daemon: running (pid ${pid})\n` +
          `  listening:    ${state.listening}\n` +
          `  ws connected: ${state.wsConnected}\n` +
          `  model:        ${state.model}\n` +
          `  voice:        ${state.voice ?? "(unknown)"}\n` +
          `  interruption: ${state.interruptionEnabled ? "on" : "off"}\n` +
          `  noise reduce: ${state.noiseReduction ?? "(unknown)"}\n` +
          `  transcript:   ${state.backgroundTranscription ? "background" : "blocking"} (${state.transcriptionModel ?? "off"})\n` +
          `  local vad:    ${state.localVadEnabled ? `on (${(state.localVadMinLevel ?? 0).toFixed(2)})` : "off"}\n` +
          `  audio out:    ${state.audioPlayer ?? "auto"}${state.playbackGain != null ? ` @ ${state.playbackGain}x` : ""}\n` +
	          `  max output:   speech ${state.maxOutputTokens ?? "(default)"}, short ${state.shortReplyTokens ?? "(default)"}, tools ${state.maxToolCallTokens ?? "(default)"}\n` +
	          `  tool hold:    ${state.toolAudioHoldMs ?? 0}ms\n` +
	          `  tool ack:     ${state.toolLocalAckEnabled ? `on (${state.toolLocalAckModel ?? "speech"})` : "off"}\n` +
	          `  progress:     ${state.toolProgressAckEnabled ? `on after ${state.toolProgressAckAfterMs ?? 0}ms` : "off"}\n` +
	          `  action wait:  ${state.actionClassifyWaitMs ?? 0}ms\n` +
          `  tool loop:    ${state.toolLoopMaxCalls ?? 0} calls / ${state.toolLoopMaxMs ?? 0}ms\n` +
          `  shell wait:   ${state.runShellFastWaitMs ?? 0}ms\n` +
          `  web timeout:  ${state.webFetchTimeoutMs ?? 0}ms\n` +
          `  shot timeout: ${state.browserScreenshotTimeoutMs ?? 0}ms\n` +
          `  dispatch:     ${state.dispatchLaunchTimeoutMs ?? 0}ms\n` +
          `  auto idle:    ${state.autoIdleAfterTurn ? "after turn" : "off"}\n` +
          `  camera:       ${state.cameraEnabled ? `on (device ${state.cameraIndex ?? "0"}, warmup ${state.cameraWarmupMs ?? 0}ms, ambient ${state.cameraAutoRecognize ? `${state.cameraAutoIntervalMs ?? 0}ms` : "off"})` : "off"}\n` +
          `  speaker id:   ${state.speakerRecognitionEnabled ? `on (proactive ${state.speakerProactiveIdentify ? "on" : "off"})` : "off"}\n` +
          `  int gate:     ${(state.interruptMinLevel ?? 0).toFixed(2)} x ${state.interruptFrames ?? 0}\n` +
          `  mic peak:     ${(state.micPeakLevel ?? 0).toFixed(3)}\n` +
          `  mic signal:   ${formatMicSignalStatus(state)}\n` +
          `  uptime:       ${Math.round((Date.now() - state.startedAt) / 1000)}s` +
          formatShortcutStatus() +
          formatReadinessStatus() +
          formatLatencyStatus(state.lastLatency) +
          formatActionStatus(state.lastAction) +
          formatProbeStatus(state.lastProbe) +
          formatPerceptionStatus({
            vision: state.lastVision,
            speaker: state.lastSpeaker,
          }),
      );
      break;
    }

    case "test-output": {
      const text =
        process.argv.slice(3).join(" ").trim() ||
        "Voice output test. If you can hear me, the speaker path is working.";
      await runOutputTest(text);
      break;
    }

    case "mic-test": {
      const seconds = Math.max(1, Number(process.argv[3] ?? "4") || 4);
      await runMicTest(seconds * 1000);
      break;
    }

    case "probe": {
      const text = process.argv.slice(3).join(" ").trim();
      if (!text) {
        console.log("Usage: friday-voice probe <text to send to the live daemon>");
        process.exit(1);
      }
      await runLiveProbe(text);
      break;
    }

    default:
      console.log(
        "Usage: friday-voice <start|toggle|stop|status|test-output|mic-test|probe>",
      );
      process.exit(1);
  }
}

void main();
