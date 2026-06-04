// The long-lived voice daemon. Wires Realtime WS ↔ mic/speaker ↔ tools and owns
// the listen/idle lifecycle. Starts IDLE; SIGUSR2 toggles listening; SIGTERM
// shuts down cleanly. The CLI sends those signals (driven by skhd / `friday-voice`).

import { loadVoiceConfig } from "./config.ts";
import { loadVoicePersona } from "./persona.ts";
import { toolDefsForConfig, ToolRunner } from "./tools.ts";
import { MicCapture, Player, cue, rms16 } from "./audio.ts";
import { RealtimeClient } from "./realtime.ts";
import { HudServer } from "./hud-server.ts";
import { spawnOverlay } from "./hud-overlay.ts";
import { writePid, writeState, clearPid, type DaemonState } from "./control.ts";
import type { Subprocess } from "bun";

const log = (...a: unknown[]) => console.log("[voice:daemon]", ...a);

function engineeringContext(cfg: ReturnType<typeof loadVoiceConfig>): string {
  const repos = cfg.repos.map((r) => `- ${r.name}: ${r.path}`).join("\n") || "- friday: this repo";
  return [
    "## Engineering voice routing",
    "For substantial coding/build/debug/review tasks, use dispatch_engineering.",
    "Do not ask Anmol which repo to use unless the request is truly ambiguous and choosing wrong would be destructive.",
    "Infer the repo from GitHub URLs, PR URLs, explicit repo names, or keywords: backend/api -> gx-backend; mobile/app/expo/iOS/Android -> gx-client-expo; web/Next/frontend -> gx-client-next; admin/dashboard -> gx-admin-client; talent/candidate -> gx-talent-client.",
    "If Slack dispatch is unavailable, dispatch_engineering will start local Codex in Terminal instead of refusing.",
    "Configured repos:",
    repos,
  ].join("\n");
}

export async function runDaemon(opts: { startListening: boolean }): Promise<void> {
  const cfg = loadVoiceConfig();
  const persona = await loadVoicePersona();
  const instructions = `${persona}\n\n${engineeringContext(cfg)}`;
  const toolDefs = toolDefsForConfig(cfg);
  const tools = new ToolRunner(cfg);
  const player = new Player(cfg.sampleRate, cfg.playbackPrebufferMs);
  let suppressMicUntil = 0;
  let estimatedPlaybackUntil = 0;

  // On-screen holographic HUD (localhost page + transparent Swift overlay).
  const hud = new HudServer(cfg.hudPort);
  let overlayProc: Subprocess | null = null;
  if (cfg.hudEnabled) {
    hud.start();
    overlayProc = await spawnOverlay(hud.url);
  }

  const client = new RealtimeClient(cfg, instructions, toolDefs, {
    onAudioDelta: (pcm) => {
      const now = Date.now();
      const pcmMs = Math.ceil((pcm.byteLength / (cfg.sampleRate * 2)) * 1000);
      estimatedPlaybackUntil = Math.max(estimatedPlaybackUntil, now + cfg.playbackPrebufferMs) + pcmMs;
      suppressMicUntil = estimatedPlaybackUntil + cfg.echoSuppressionMs;
      player.write(pcm);
      if (listening) { hud.set("speaking"); voiceLevel = Math.max(voiceLevel, rms16(pcm)); }
    },
    onSpeechStarted: () => {
      if (Date.now() < suppressMicUntil) {
        log("ignored speech_started during speaker echo guard");
        return;
      }
      // Barge-in: user started talking — stop Friday mid-sentence.
      player.flush();
      client.cancelResponse();
      if (listening) hud.set("hearing");
    },
    onSpeechStopped: () => { if (listening) hud.set("thinking"); },
    onResponseDone: () => {
      suppressMicUntil = Math.max(suppressMicUntil, estimatedPlaybackUntil + cfg.echoSuppressionMs);
      estimatedPlaybackUntil = 0;
      player.finishSoon();
      if (listening) hud.set("listening");
    },
    onUserTranscript: (t) => log("heard:", t),
    onFunctionCall: async ({ callId, name, args }) => {
      log(`tool: ${name}`, JSON.stringify(args).slice(0, 200));
      if (listening) hud.set("thinking", name.replace(/_/g, " "));
      const result = await tools.exec(name, args);
      client.sendFunctionResult(callId, result);
    },
    onOpen: () => syncState(),
    onClose: () => syncState(),
  });

  let voiceLevel = 0;
  let peakLevel = 0;
  let lastPeakLevel = 0;
  const mic = new MicCapture(
    cfg.micIndex,
    cfg.sampleRate,
    (b64) => {
      if (listening && client.connected && Date.now() >= suppressMicUntil) client.appendAudio(b64);
    },
    (lvl) => { voiceLevel = Math.max(voiceLevel, lvl); peakLevel = Math.max(peakLevel, lvl); },
    cfg.micGain,
  );

  let listening = false;
  let levelTimer: ReturnType<typeof setInterval> | null = null;
  let peakTimer: ReturnType<typeof setInterval> | null = null;
  const startedAt = Date.now();

  function syncState(): void {
    const state: DaemonState = {
      pid: process.pid,
      listening,
      wsConnected: client.connected,
      model: cfg.model,
      micPeakLevel: lastPeakLevel,
      startedAt,
      updatedAt: Date.now(),
    };
    writeState(state);
  }

  function startListening(): void {
    if (listening) return;
    listening = true;
    if (!client.connected) client.connect();
    mic.start();
    cue("on");
    hud.set("listening");
    // Drive the HUD waveform from the live voice level at ~25Hz (with decay).
    levelTimer = setInterval(() => { hud.pushLevel(voiceLevel); voiceLevel *= 0.55; }, 40);
    // Diagnostic: log peak mic level each second. ~0 => mic is silent (TCC denied).
    peakTimer = setInterval(() => {
      lastPeakLevel = peakLevel;
      log(`mic peak level (post-gain, 0..1): ${lastPeakLevel.toFixed(3)} ${lastPeakLevel < 0.01 ? "← SILENT (mic permission denied?)" : ""}`);
      peakLevel = 0;
      syncState();
    }, 1000);
    log("listening ON");
    syncState();
  }

  function stopListening(): void {
    if (!listening) return;
    listening = false;
    if (levelTimer) { clearInterval(levelTimer); levelTimer = null; }
    if (peakTimer) { clearInterval(peakTimer); peakTimer = null; }
    voiceLevel = 0; peakLevel = 0; lastPeakLevel = 0;
    hud.pushLevel(0);
    mic.stop();
    player.flush();
    if (cfg.wsIdleOff) client.close();
    cue("off");
    hud.set("offline");
    log("listening OFF");
    syncState();
  }

  function toggle(): void {
    if (listening) stopListening();
    else startListening();
  }

  writePid(process.pid);
  syncState();
  log(`up (pid ${process.pid}, model ${cfg.model}, vad ${cfg.vad}, voice ${cfg.voice})`);

  process.on("SIGUSR2", () => toggle());
  const shutdown = () => {
    log("shutting down");
    stopListening();
    client.close();
    try { overlayProc?.kill(); } catch { /* ignore */ }
    hud.stop();
    clearPid();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  if (opts.startListening) startListening();

  // Keep the event loop alive indefinitely (idle daemon does nothing until toggled).
  setInterval(() => syncState(), 30_000);
}
