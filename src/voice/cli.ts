#!/usr/bin/env bun
// Friday voice CLI — the surface skhd / `bin/friday-voice` calls.
//
//   start    run the daemon in the foreground (starts idle). `bun run voice`.
//   toggle   flip listening on a running daemon (SIGUSR2); if none, launch one
//            detached and start it listening. This is what the hotkey calls.
//   stop     SIGTERM a running daemon.
//   status   print the daemon state.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { runDaemon } from "./daemon.ts";
import { appendFileSync } from "node:fs";
import { loadVoiceConfig } from "./config.ts";
import { loadVoicePersona } from "./persona.ts";
import { MicCapture, Player } from "./audio.ts";
import { RealtimeClient } from "./realtime.ts";
import { TOOL_DEFS } from "./tools.ts";
import {
  runningDaemonPid,
  readState,
  ensureStateDir,
  LOG_FILE,
} from "./control.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, "cli.ts");

async function runOutputTest(text: string): Promise<void> {
  const cfg = loadVoiceConfig();
  const persona = await loadVoicePersona();
  const player = new Player(cfg.sampleRate, cfg.playbackPrebufferMs);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      player.flush();
      client.close();
      reject(new Error("Timed out waiting for Realtime output audio."));
    }, 20_000);

    const client = new RealtimeClient(cfg, persona, TOOL_DEFS, {
      onAudioDelta: (pcm) => player.write(pcm),
      onSpeechStarted: () => {},
      onFunctionCall: ({ callId, name }) => client.sendFunctionResult(callId, `Output test skipped tool ${name}.`),
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
    (level) => { peak = Math.max(peak, level); },
    cfg.micGain,
  );

  mic.start();
  await new Promise((resolve) => setTimeout(resolve, ms));
  mic.stop();
  console.log(
    `Mic test (${Math.round(ms / 1000)}s): ${chunks} chunks, ${Math.round(bytes / 1024)} KB, peak ${peak.toFixed(3)}` +
    (peak < 0.01 ? "\nMic is effectively silent. Check macOS Microphone permission for the app launching Friday voice." : ""),
  );
}

async function spawnDetached(startListening: boolean): Promise<void> {
  ensureStateDir();
  appendFileSync(LOG_FILE, `[voice:cli] spawning detached daemon (startListening=${startListening})\n`);
  const repoRoot = path.resolve(__dirname, "../..");
  const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const cmd = [
    `cd ${q(repoRoot)} &&`,
    `FRIDAY_VOICE_START_ON=${startListening ? "1" : "0"}`,
    "/usr/bin/nohup",
    q(process.execPath),
    "run",
    q(CLI_PATH),
    "start",
    `>> ${q(LOG_FILE)} 2>&1 < /dev/null &`,
  ].join(" ");
  appendFileSync(LOG_FILE, `[voice:cli] detached command: ${cmd}\n`);
  const proc = Bun.spawn(["/bin/sh", "-lc", cmd], {
    env: process.env as Record<string, string>,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
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
      await runDaemon({ startListening: process.env.FRIDAY_VOICE_START_ON === "1" });
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
        console.log("Started voice daemon — listening ON.");
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
        `  mic peak:     ${(state.micPeakLevel ?? 0).toFixed(3)}\n` +
        `  uptime:       ${Math.round((Date.now() - state.startedAt) / 1000)}s`,
      );
      break;
    }

    case "test-output": {
      const text = process.argv.slice(3).join(" ").trim() || "Voice output test. If you can hear me, the speaker path is working.";
      await runOutputTest(text);
      break;
    }

    case "mic-test": {
      const seconds = Math.max(1, Number(process.argv[3] ?? "4") || 4);
      await runMicTest(seconds * 1000);
      break;
    }

    default:
      console.log("Usage: friday-voice <start|toggle|stop|status|test-output|mic-test>");
      process.exit(1);
  }
}

void main();
