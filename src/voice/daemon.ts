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
import {
  writePid,
  writeState,
  clearPid,
  type DaemonState,
  type VoiceLatencyState,
} from "./control.ts";
import { recallContext, engramRecallEnabled } from "../memory/engram-bridge.ts";
import {
  captureExchange,
  engramCaptureEnabled,
} from "../memory/auto-capture.ts";
import type { Subprocess } from "bun";

const log = (...a: unknown[]) => console.log("[voice:daemon]", ...a);

interface VoiceTurn {
  id: string;
  userText: string;
  assistantText: string;
  speechStartedAt: number | null;
  speechStoppedAt: number | null;
  transcriptAt: number | null;
  recallStartedAt: number | null;
  recallEndedAt: number | null;
  responseCreateAt: number | null;
  firstAudioAt: number | null;
  responseDoneAt: number | null;
  responseRequested: boolean;
  responseDone: boolean;
  sawToolCall: boolean;
  pendingTools: number;
  captureAttempts: number;
  captured: boolean;
  fallbackTimer: ReturnType<typeof setTimeout> | null;
  captureTimer: ReturnType<typeof setTimeout> | null;
}

function engineeringContext(cfg: ReturnType<typeof loadVoiceConfig>): string {
  const repos =
    cfg.repos.map((r) => `- ${r.name}: ${r.path}`).join("\n") ||
    "- friday: this repo";
  return [
    "## Engineering voice routing",
    "You are a capable Mac agent with explicit tools for local memory, associative engram recall, web search, browser reading/screenshots, current-screen screenshots, mouse control, shell, AppleScript, and engineering dispatch.",
    "For questions involving Anmol's past preferences, previous project context, remembered decisions, or how he likes work done, use memory_search and/or engram_recall before answering. Use remember when Anmol asks you to remember something or states a stable preference/lesson.",
    "If the injected associative-memory block contains a direct answer to a preference question, use it directly instead of asking Anmol again.",
    "For current or internet-dependent facts, use web_search first, then browser_page_text on the most relevant URLs before making claims.",
    "For browser/UI tasks, use browser_open_url as needed, take browser_screenshot or screen_screenshot before coordinate-based actions, then use mouse_control only when you have clear coordinates. The orange ring means you are controlling the pointer.",
    "For Slack app tasks, control the visible Slack app instead of using Slack API tokens: open_app Slack, use cmd+k to jump to a channel/person such as agent-test, press return, type the message, then press return to send.",
    "For substantial coding/build/debug/review tasks, use dispatch_engineering.",
    "Do not ask Anmol which repo to use unless the request is truly ambiguous and choosing wrong would be destructive.",
    "Infer the repo from GitHub URLs, PR URLs, explicit repo names, or keywords: backend/api -> gx-backend; mobile/app/expo/iOS/Android -> gx-client-expo; web/Next/frontend -> gx-client-next; admin/dashboard -> gx-admin-client; talent/candidate -> gx-talent-client.",
    "If Slack dispatch is unavailable, dispatch_engineering will start local Codex in Terminal instead of refusing.",
    "Configured repos:",
    repos,
  ].join("\n");
}

export async function runDaemon(opts: {
  startListening: boolean;
}): Promise<void> {
  const cfg = loadVoiceConfig();
  const persona = await loadVoicePersona();
  let voiceMemoryPrimer = "";
  if (engramRecallEnabled()) {
    try {
      voiceMemoryPrimer = await recallContext(
        "Anmol stable preferences favorite song preferred apps voice agent settings",
        6,
        5_000,
      );
      if (voiceMemoryPrimer) log("loaded voice memory primer");
    } catch (err) {
      log(
        "voice memory primer skipped:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  const instructions = [persona, engineeringContext(cfg), voiceMemoryPrimer]
    .filter(Boolean)
    .join("\n\n");
  const toolDefs = toolDefsForConfig(cfg);
  const tools = new ToolRunner(cfg);
  const player = new Player(cfg.sampleRate, cfg.playbackPrebufferMs);
  let suppressMicUntil = 0;
  let estimatedPlaybackUntil = 0;
  let dropCanceledAudioUntil = 0;
  let acceptedInterruptUntil = 0;
  let lastInterruptAt = 0;
  let interruptHighFrames = 0;
  let activeAssistantAudioItemId: string | null = null;
  let activeAssistantAudioContentIndex = 0;
  let audioResponseStarted = false;
  let assistantAudioStartedAt = 0;
  let interruptsThisResponse = 0;
  let micRingMs = 0;
  const micRing: Array<{ b64: string; durationMs: number }> = [];
  let activeTurn: VoiceTurn | null = null;
  let lastLatency: VoiceLatencyState | undefined;

  // On-screen holographic HUD (localhost page + transparent Swift overlay).
  const hud = new HudServer(cfg.hudPort);
  let overlayProc: Subprocess | null = null;
  if (cfg.hudEnabled) {
    hud.start();
    overlayProc = await spawnOverlay(hud.url);
  }

  const client = new RealtimeClient(cfg, instructions, toolDefs, {
    onAudioDelta: (pcm, meta) => {
      const now = Date.now();
      if (now < dropCanceledAudioUntil) return;
      const itemId = meta.itemId ?? activeAssistantAudioItemId;
      if (
        !audioResponseStarted ||
        (itemId && itemId !== activeAssistantAudioItemId)
      ) {
        player.beginResponse();
        audioResponseStarted = true;
        assistantAudioStartedAt = now;
        interruptsThisResponse = 0;
        if (activeTurn) {
          activeTurn.responseDone = false;
          if (!activeTurn.firstAudioAt) {
            activeTurn.firstAudioAt = now;
            lastLatency = computeTurnLatency(activeTurn, now);
            log(`latency first_audio: ${formatLatency(lastLatency)}`);
            syncState();
          }
        }
      }
      if (itemId) activeAssistantAudioItemId = itemId;
      activeAssistantAudioContentIndex = meta.contentIndex;
      const pcmMs = Math.ceil((pcm.byteLength / (cfg.sampleRate * 2)) * 1000);
      estimatedPlaybackUntil =
        Math.max(estimatedPlaybackUntil, now + cfg.playbackPrebufferMs) + pcmMs;
      suppressMicUntil = estimatedPlaybackUntil + cfg.echoSuppressionMs;
      player.write(pcm);
      if (listening) {
        hud.set("speaking");
        voiceLevel = Math.max(voiceLevel, rms16(pcm));
      }
    },
    onSpeechStarted: () => {
      const now = Date.now();
      if (now < suppressMicUntil) {
        log("ignored speech_started during speaker echo guard");
        return;
      }
      beginVoiceTurn(now);
      if (listening) hud.set("hearing");
    },
    onSpeechStopped: () => {
      if (listening) hud.set("thinking");
      const turn = ensureVoiceTurn();
      turn.speechStoppedAt = Date.now();
      if (!cfg.backgroundTranscription) scheduleResponseFallback(turn);
    },
    onResponseCreated: () => {
      if (activeTurn) activeTurn.responseCreateAt ??= Date.now();
    },
    onResponseDone: () => {
      if (Date.now() < dropCanceledAudioUntil) {
        dropCanceledAudioUntil = 0;
        estimatedPlaybackUntil = 0;
        suppressMicUntil = 0;
        audioResponseStarted = false;
        assistantAudioStartedAt = 0;
        interruptsThisResponse = 0;
        activeAssistantAudioItemId = null;
        player.flush();
        if (listening) hud.set("hearing", "interrupted");
        return;
      }
      suppressMicUntil = Math.max(
        suppressMicUntil,
        estimatedPlaybackUntil + cfg.echoSuppressionMs,
      );
      estimatedPlaybackUntil = 0;
      audioResponseStarted = false;
      assistantAudioStartedAt = 0;
      interruptsThisResponse = 0;
      activeAssistantAudioItemId = null;
      player.finishSoon();
      if (listening) hud.set("listening");
      const turn = activeTurn;
      if (turn) {
        turn.responseDoneAt = Date.now();
        turn.responseDone = true;
        const latency = computeTurnLatency(turn, turn.responseDoneAt);
        if (hasUsefulLatency(latency)) {
          lastLatency = latency;
          log(`latency response_done: ${formatLatency(lastLatency)}`);
          syncState();
        }
        scheduleVoiceCapture(turn);
      }
    },
    onUserTranscript: (t) => {
      void handleUserTranscript(t);
    },
    onAssistantTranscript: (t) => {
      const turn = activeTurn;
      if (!turn) return;
      turn.assistantText = t.trim();
      log("said:", turn.assistantText);
      if (turn.responseDone) scheduleVoiceCapture(turn);
    },
    onFunctionCall: async ({ callId, name, args }) => {
      log(`tool: ${name}`, JSON.stringify(args).slice(0, 200));
      const turn = ensureVoiceTurn();
      turn.sawToolCall = true;
      turn.pendingTools++;
      if (listening) hud.set("thinking", name.replace(/_/g, " "));
      const result = await tools.exec(name, args);
      turn.pendingTools = Math.max(0, turn.pendingTools - 1);
      turn.responseDone = false;
      client.sendFunctionResult(callId, result);
    },
    onOpen: () => syncState(),
    onClose: () => syncState(),
  });

  function newVoiceTurn(speechStartedAt: number | null = null): VoiceTurn {
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      userText: "",
      assistantText: "",
      speechStartedAt,
      speechStoppedAt: null,
      transcriptAt: null,
      recallStartedAt: null,
      recallEndedAt: null,
      responseCreateAt: null,
      firstAudioAt: null,
      responseDoneAt: null,
      responseRequested: false,
      responseDone: false,
      sawToolCall: false,
      pendingTools: 0,
      captureAttempts: 0,
      captured: false,
      fallbackTimer: null,
      captureTimer: null,
    };
  }

  function clearVoiceTurnTimers(turn: VoiceTurn): void {
    if (turn.fallbackTimer) {
      clearTimeout(turn.fallbackTimer);
      turn.fallbackTimer = null;
    }
    if (turn.captureTimer) {
      clearTimeout(turn.captureTimer);
      turn.captureTimer = null;
    }
  }

  function beginVoiceTurn(speechStartedAt = Date.now()): VoiceTurn {
    if (activeTurn && !activeTurn.captured && activeTurn.userText) {
      scheduleVoiceCapture(activeTurn, 250);
    }
    activeTurn = newVoiceTurn(speechStartedAt);
    return activeTurn;
  }

  function ensureVoiceTurn(): VoiceTurn {
    if (!activeTurn || activeTurn.captured) activeTurn = newVoiceTurn();
    return activeTurn;
  }

  function scheduleResponseFallback(turn: VoiceTurn): void {
    if (turn.responseRequested || turn.fallbackTimer) return;
    turn.fallbackTimer = setTimeout(() => {
      turn.fallbackTimer = null;
      if (activeTurn === turn && !turn.responseRequested) {
        void requestVoiceResponse(turn);
      }
    }, 2500);
  }

  async function handleUserTranscript(transcript: string): Promise<void> {
    const text = transcript.trim();
    if (!text) return;
    const turn = ensureVoiceTurn();
    turn.userText = text;
    turn.transcriptAt = Date.now();
    log("heard:", text);
    if (turn.fallbackTimer) {
      clearTimeout(turn.fallbackTimer);
      turn.fallbackTimer = null;
    }
    if (cfg.backgroundTranscription) {
      if (turn.responseDone) scheduleVoiceCapture(turn);
      return;
    }
    await requestVoiceResponse(turn);
  }

  async function requestVoiceResponse(turn: VoiceTurn): Promise<void> {
    if (turn.responseRequested) return;
    turn.responseRequested = true;
    turn.responseDone = false;
    let memoryContext = "";
    if (engramRecallEnabled() && turn.userText.trim()) {
      try {
        turn.recallStartedAt = Date.now();
        memoryContext = await recallContext(turn.userText, 8);
        turn.recallEndedAt = Date.now();
        if (memoryContext) log("engram recall injected for voice turn");
      } catch (err) {
        turn.recallEndedAt = Date.now();
        log(
          "engram recall skipped:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    const responseInstructions = memoryContext
      ? `${instructions}\n\n${memoryContext}`
      : undefined;
    turn.responseCreateAt = Date.now();
    client.createResponse(responseInstructions);
  }

  function elapsed(start: number | null, end: number | null): number | undefined {
    if (start == null || end == null) return undefined;
    return Math.max(0, end - start);
  }

  function computeTurnLatency(
    turn: VoiceTurn,
    at = Date.now(),
  ): VoiceLatencyState {
    return {
      at,
      speechMs: elapsed(turn.speechStartedAt, turn.speechStoppedAt),
      stopToTranscriptMs: elapsed(turn.speechStoppedAt, turn.transcriptAt),
      memoryRecallMs: elapsed(turn.recallStartedAt, turn.recallEndedAt),
      transcriptToResponseCreateMs: elapsed(
        turn.transcriptAt,
        turn.responseCreateAt,
      ),
      responseCreateToFirstAudioMs: elapsed(
        turn.responseCreateAt,
        turn.firstAudioAt,
      ),
      stopToFirstAudioMs: elapsed(turn.speechStoppedAt, turn.firstAudioAt),
      stopToDoneMs: elapsed(turn.speechStoppedAt, turn.responseDoneAt),
      firstAudioToDoneMs: elapsed(turn.firstAudioAt, turn.responseDoneAt),
    };
  }

  function formatLatency(lat: VoiceLatencyState): string {
    const show = (label: string, value: number | undefined) =>
      value == null ? null : `${label}=${value}ms`;
    return [
      show("speech", lat.speechMs),
      show("stop->transcript", lat.stopToTranscriptMs),
      show("memory", lat.memoryRecallMs),
      show("transcript->create", lat.transcriptToResponseCreateMs),
      show("create->audio", lat.responseCreateToFirstAudioMs),
      show("stop->audio", lat.stopToFirstAudioMs),
      show("stop->done", lat.stopToDoneMs),
      show("audio->done", lat.firstAudioToDoneMs),
    ]
      .filter(Boolean)
      .join(" ");
  }

  function hasUsefulLatency(lat: VoiceLatencyState): boolean {
    return (
      lat.stopToFirstAudioMs != null ||
      lat.responseCreateToFirstAudioMs != null ||
      lat.stopToDoneMs != null
    );
  }

  function scheduleVoiceCapture(turn: VoiceTurn, delayMs = 1200): void {
    if (turn.captureTimer) clearTimeout(turn.captureTimer);
    turn.captureTimer = setTimeout(() => {
      turn.captureTimer = null;
      captureVoiceTurn(turn);
    }, delayMs);
  }

  function captureVoiceTurn(turn: VoiceTurn): void {
    if (turn.captured) return;
    if (!turn.userText.trim()) {
      turn.captureAttempts++;
      if (turn.captureAttempts < 8) scheduleVoiceCapture(turn, 1500);
      return;
    }
    if (!turn.responseDone || turn.pendingTools > 0) {
      scheduleVoiceCapture(turn, 1500);
      return;
    }
    turn.captureAttempts++;
    if (!turn.assistantText.trim() && turn.captureAttempts < 8) {
      scheduleVoiceCapture(turn, 1500);
      return;
    }
    if (engramCaptureEnabled()) {
      captureExchange({
        channel: "voice",
        channelName: "voice",
        threadId: `voice-${turn.id}`,
        user: "Anmol",
        userText: turn.userText,
        reply: turn.assistantText,
      });
      log("captured voice exchange into memory");
    }
    turn.captured = true;
    clearVoiceTurnTimers(turn);
    if (activeTurn === turn) activeTurn = null;
  }

  function rememberMicChunk(b64: string, durationMs: number): void {
    micRing.push({ b64, durationMs });
    micRingMs += durationMs;
    while (micRingMs > cfg.interruptBufferMs && micRing.length > 1) {
      const old = micRing.shift()!;
      micRingMs -= old.durationMs;
    }
  }

  function assistantIsAudible(now: number): boolean {
    return (
      audioResponseStarted &&
      (estimatedPlaybackUntil > now || player.playedMs() > 0)
    );
  }

  function tryInterrupt(level: number): boolean {
    if (!cfg.interruptionEnabled) return false;
    const now = Date.now();
    if (!assistantIsAudible(now)) {
      interruptHighFrames = 0;
      return false;
    }
    if (now - assistantAudioStartedAt < cfg.interruptMinAssistantMs)
      return false;
    if (interruptsThisResponse >= cfg.interruptMaxPerResponse) return false;
    if (now - lastInterruptAt < cfg.interruptCooldownMs) return false;

    interruptHighFrames =
      level >= cfg.interruptMinLevel ? interruptHighFrames + 1 : 0;
    if (interruptHighFrames < cfg.interruptFrames) return false;

    const playedMs = player.playedMs();
    const itemId = activeAssistantAudioItemId;
    lastInterruptAt = now;
    interruptsThisResponse++;
    interruptHighFrames = 0;
    acceptedInterruptUntil = now + 5000;
    dropCanceledAudioUntil = now + 3000;
    estimatedPlaybackUntil = 0;
    suppressMicUntil = 0;

    log(
      `accepted interruption: level=${level.toFixed(3)} frames=${cfg.interruptFrames} played=${playedMs}ms item=${itemId ?? "unknown"}`,
    );
    client.cancelResponse();
    if (itemId)
      client.truncateResponseAudio(
        itemId,
        playedMs,
        activeAssistantAudioContentIndex,
      );
    player.flush();
    for (const chunk of micRing) client.appendAudio(chunk.b64);
    micRing.length = 0;
    micRingMs = 0;
    if (listening) hud.set("hearing", "interrupted");
    return true;
  }

  let voiceLevel = 0;
  let peakLevel = 0;
  let lastPeakLevel = 0;
  const mic = new MicCapture(
    cfg.micIndex,
    cfg.sampleRate,
    (b64, lvl, durationMs) => {
      if (!listening || !client.connected) return;
      rememberMicChunk(b64, durationMs);
      const now = Date.now();
      if (now < suppressMicUntil) {
        if (tryInterrupt(lvl)) return;
        if (now < acceptedInterruptUntil) client.appendAudio(b64);
        return;
      }
      interruptHighFrames = 0;
      client.appendAudio(b64);
    },
    (lvl) => {
      voiceLevel = Math.max(voiceLevel, lvl);
      peakLevel = Math.max(peakLevel, lvl);
    },
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
      voice: cfg.voice,
      interruptionEnabled: cfg.interruptionEnabled,
      noiseReduction: cfg.inputNoiseReduction,
      transcriptionModel: cfg.transcriptionModel,
      backgroundTranscription: cfg.backgroundTranscription,
      interruptMinLevel: cfg.interruptMinLevel,
      interruptFrames: cfg.interruptFrames,
      micPeakLevel: lastPeakLevel,
      lastLatency,
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
    levelTimer = setInterval(() => {
      hud.pushLevel(voiceLevel);
      voiceLevel *= 0.55;
    }, 40);
    // Diagnostic: log peak mic level each second. ~0 => mic is silent (TCC denied).
    peakTimer = setInterval(() => {
      lastPeakLevel = peakLevel;
      log(
        `mic peak level (post-gain, 0..1): ${lastPeakLevel.toFixed(3)} ${lastPeakLevel < 0.01 ? "← SILENT (mic permission denied?)" : ""}`,
      );
      peakLevel = 0;
      syncState();
    }, 1000);
    log("listening ON");
    syncState();
  }

  function stopListening(): void {
    if (!listening) return;
    listening = false;
    if (levelTimer) {
      clearInterval(levelTimer);
      levelTimer = null;
    }
    if (peakTimer) {
      clearInterval(peakTimer);
      peakTimer = null;
    }
    voiceLevel = 0;
    peakLevel = 0;
    lastPeakLevel = 0;
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
  log(
    `up (pid ${process.pid}, model ${cfg.model}, vad ${cfg.vad}, voice ${cfg.voice})`,
  );

  process.on("SIGUSR2", () => toggle());
  const shutdown = () => {
    log("shutting down");
    stopListening();
    client.close();
    try {
      overlayProc?.kill();
    } catch {
      /* ignore */
    }
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
