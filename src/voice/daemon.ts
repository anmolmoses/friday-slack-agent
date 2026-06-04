// The long-lived voice daemon. Wires Realtime WS ↔ mic/speaker ↔ tools and owns
// the listen/idle lifecycle. Starts IDLE; SIGUSR2 toggles listening; SIGTERM
// shuts down cleanly. The CLI sends those signals (driven by skhd / `friday-voice`).

import { loadVoiceConfig } from "./config.ts";
import { loadVoicePersona } from "./persona.ts";
import {
  toolDefsForConfig,
  ToolRunner,
  type ToolRunResult,
} from "./tools.ts";
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
  type VoiceSpeakerState,
  type VoiceVisionState,
} from "./control.ts";
import { recallContext, engramRecallEnabled } from "../memory/engram-bridge.ts";
import {
  captureExchange,
  engramCaptureEnabled,
} from "../memory/auto-capture.ts";
import {
  captureCameraFrame,
  lookupVisualPerson,
  type VisualPersonMatch,
} from "../memory/vision.ts";
import {
  lookupVoicePerson,
  rememberVoicePerson,
  type VoicePersonMatch,
} from "../memory/voice.ts";
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
  speakerChunks: Buffer[];
  speakerSampleMs: number;
  speakerAnalyzed: boolean;
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
    cfg.cameraEnabled
      ? "Camera vision is enabled. For physical-world visual questions, use current_perception first when cached context is enough; use camera_see only when you need a fresh visual inspection. For identity, use confirmed visual-person memory as tentative context; if no confident match exists, ask for the person's name, then use visual_person_remember only after explicit confirmation."
      : "Camera vision is disabled by FRIDAY_VOICE_CAMERA=false. Do not claim you can see through the camera.",
    cfg.speakerRecognitionEnabled
      ? "Speaker recognition is enabled. Use the current speaker context as tentative. If a new or unknown speaker identifies themselves, call voice_person_remember with the confirmed name. Do not claim a speaker identity from a weak match."
      : "Speaker recognition is disabled by FRIDAY_VOICE_SPEAKER_RECOGNITION=false.",
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
  const baseInstructions = [persona, engineeringContext(cfg), voiceMemoryPrimer]
    .filter(Boolean)
    .join("\n\n");
  let visualInstructionBlock = "";
  let speakerInstructionBlock = "";
  let lastVision: VoiceVisionState | undefined;
  let lastSpeaker: VoiceSpeakerState | undefined;
  let lastVisualSummary = "";
  let lastSpeakerSummary = "";
  let lastSpeakerSample: {
    pcm: Buffer;
    sampleRate: number;
    durationMs: number;
    at: number;
  } | null = null;
  let pendingUnknownSpeakerPrompt = "";
  let lastUnknownSpeakerPromptAt = 0;

  function currentInstructions(extra?: string): string {
    return [
      baseInstructions,
      visualInstructionBlock,
      speakerInstructionBlock,
      extra,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  const toolDefs = toolDefsForConfig(cfg);
  const tools = new ToolRunner(cfg, {
    currentPerception: perceptionContextForTool,
    rememberCurrentSpeaker,
  });
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
  let responseInFlight = false;
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

  const client = new RealtimeClient(cfg, currentInstructions(), toolDefs, {
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
      void analyzeSpeakerTurn(turn);
      if (!cfg.backgroundTranscription) scheduleResponseFallback(turn);
    },
    onResponseCreated: () => {
      responseInFlight = true;
      if (activeTurn) activeTurn.responseCreateAt ??= Date.now();
    },
    onResponseDone: () => {
      responseInFlight = false;
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
        maybeSpeakPendingUnknownSpeaker();
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
      const output = toolOutput(result);
      const images = toolImages(result);
      if (images.length > 0) {
        client.sendFunctionResult(callId, output, false);
        for (const image of images) {
          client.sendImageInput(image.path, image.prompt);
        }
        client.createResponse();
      } else {
        client.sendFunctionResult(callId, output);
      }
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
      speakerChunks: [],
      speakerSampleMs: 0,
      speakerAnalyzed: false,
    };
  }

  function toolOutput(result: ToolRunResult): string {
    return typeof result === "string" ? result : result.output;
  }

  function toolImages(result: ToolRunResult): Array<{ path: string; prompt?: string }> {
    return typeof result === "string" ? [] : (result.realtimeImages ?? []);
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
      ? currentInstructions(memoryContext)
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

  function updateLiveInstructions(): void {
    client.updateInstructions(currentInstructions());
  }

  function perceptionContextForTool(): string {
    const age = (at?: number) =>
      at ? `${Math.max(0, Math.round((Date.now() - at) / 1000))}s ago` : "never";
    return [
      "Background perception cache:",
      lastVision
        ? `- Vision (${age(lastVision.at)}): ${lastVision.summary}`
        : `- Vision: ${cfg.cameraEnabled && cfg.cameraAutoRecognize ? "warming up / no cache yet" : "disabled"}`,
      lastSpeaker
        ? `- Speaker (${age(lastSpeaker.at)}): ${lastSpeaker.summary}`
        : `- Speaker: ${cfg.speakerRecognitionEnabled ? "no speaker sample yet" : "disabled"}`,
    ].join("\n");
  }

  function setVisionState(args: {
    summary: string;
    imagePath?: string;
    match?: VisualPersonMatch;
  }): void {
    const changed = args.summary !== lastVisualSummary;
    lastVisualSummary = args.summary;
    lastVision = {
      at: Date.now(),
      summary: args.summary,
      imagePath: args.imagePath,
      matchName: args.match?.name,
      confidence: args.match?.confidence,
    };
    if (changed) {
      visualInstructionBlock = [
        "## Current Camera Recognition",
        args.summary,
        "This is a background visual cache. Use it for zero-latency room/person context, but do not claim identity from weak or tentative matches.",
      ].join("\n");
      updateLiveInstructions();
    }
    syncState();
  }

  function setSpeakerState(args: {
    summary: string;
    match?: VoicePersonMatch;
    sampleMs?: number;
    unknownPromptPending?: boolean;
  }): void {
    const changed = args.summary !== lastSpeakerSummary;
    lastSpeakerSummary = args.summary;
    lastSpeaker = {
      at: Date.now(),
      summary: args.summary,
      matchName: args.match?.name,
      confidence: args.match?.confidence,
      sampleMs: args.sampleMs,
      unknownPromptPending: args.unknownPromptPending,
    };
    if (changed) {
      speakerInstructionBlock = [
        "## Current Speaker Recognition",
        args.summary,
        "This is a local voice-fingerprint cache from confirmed speaker memories. Treat it as tentative; if a new speaker gives a name, remember the voice only after confirmation.",
      ].join("\n");
      updateLiveInstructions();
    }
    syncState();
  }

  function visualSummaryForMatch(
    matches: VisualPersonMatch[],
  ): { summary: string; match?: VisualPersonMatch } {
    const top = matches[0];
    if (!top) {
      return {
        summary:
          "Latest camera recognition: no saved visual person memories exist yet. Do not claim identity; ask for a name if identity matters.",
      };
    }
    const pct = Math.round(top.confidence * 100);
    if (top.confidence >= cfg.cameraAutoMinConfidence) {
      return {
        match: top,
        summary: `Latest camera recognition: likely ${top.name} (${pct}% confidence, distance ${top.distance}/64). Treat as tentative unless confirmed.`,
      };
    }
    return {
      match: top,
      summary: `Latest camera recognition: no confident identity match. Closest saved person is ${top.name} (${pct}% confidence, distance ${top.distance}/64). Ask before claiming identity.`,
    };
  }

  async function refreshVisualContext(): Promise<void> {
    if (!cfg.cameraEnabled || !cfg.cameraAutoRecognize) return;
    if (visualRunning) return;
    visualRunning = true;
    try {
      const frame = await captureCameraFrame({
        deviceIndex: cfg.cameraIndex,
        width: cfg.cameraWidth,
        height: cfg.cameraHeight,
        warmupMs: cfg.cameraWarmupMs,
        persist: false,
      });
      const matches = await lookupVisualPerson({
        imagePath: frame.file,
        limit: 3,
      });
      const result = visualSummaryForMatch(matches);
      setVisionState({
        summary: `${result.summary} Frame: ${frame.relPath}.`,
        imagePath: frame.file,
        match: result.match,
      });
    } catch (err) {
      log(
        "ambient vision skipped:",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      visualRunning = false;
    }
  }

  function startAutoVision(): void {
    if (!cfg.cameraEnabled || !cfg.cameraAutoRecognize || visualTimer) return;
    const interval = Math.max(3000, cfg.cameraAutoIntervalMs);
    const tick = () => {
      if (!listening || visualRunning) return;
      void refreshVisualContext();
    };
    visualTimer = setInterval(tick, interval);
    setTimeout(tick, 750);
    log(`ambient vision ON (${interval}ms interval)`);
  }

  function stopAutoVision(): void {
    if (!visualTimer) return;
    clearInterval(visualTimer);
    visualTimer = null;
    visualRunning = false;
    log("ambient vision OFF");
  }

  function captureSpeakerChunk(
    b64: string,
    level: number,
    durationMs: number,
  ): void {
    if (!cfg.speakerRecognitionEnabled) return;
    const turn = activeTurn;
    if (!turn || turn.speechStoppedAt != null || turn.speakerAnalyzed) return;
    if (turn.speakerSampleMs >= cfg.speakerMaxSampleMs) return;
    if (level < 0.01) return;
    turn.speakerChunks.push(Buffer.from(b64, "base64"));
    turn.speakerSampleMs += durationMs;
  }

  function speakerSummaryForMatch(
    matches: VoicePersonMatch[],
  ): { summary: string; match?: VoicePersonMatch; recognized: boolean } {
    const top = matches[0];
    if (!top) {
      return {
        recognized: false,
        summary:
          "Latest speaker recognition: no saved voice profiles exist yet. If identity matters, ask who is speaking and remember the voice only after confirmation.",
      };
    }
    const pct = Math.round(top.confidence * 100);
    if (top.confidence >= cfg.speakerMinConfidence) {
      return {
        recognized: true,
        match: top,
        summary: `Latest speaker recognition: likely ${top.name} (${pct}% confidence, similarity ${top.similarity.toFixed(3)}). Treat as tentative unless confirmed.`,
      };
    }
    return {
      recognized: false,
      match: top,
      summary: `Latest speaker recognition: new or uncertain speaker. Closest saved voice is ${top.name} (${pct}% confidence, similarity ${top.similarity.toFixed(3)}). Ask who is speaking before claiming identity.`,
    };
  }

  async function analyzeSpeakerTurn(turn: VoiceTurn): Promise<void> {
    if (!cfg.speakerRecognitionEnabled || turn.speakerAnalyzed) return;
    turn.speakerAnalyzed = true;
    if (turn.speakerSampleMs < cfg.speakerMinSampleMs) return;
    const pcm = Buffer.concat(turn.speakerChunks);
    if (pcm.byteLength < cfg.sampleRate) return;
    lastSpeakerSample = {
      pcm,
      sampleRate: cfg.sampleRate,
      durationMs: turn.speakerSampleMs,
      at: Date.now(),
    };
    try {
      const matches = await lookupVoicePerson({
        pcm,
        sampleRate: cfg.sampleRate,
        limit: 3,
      });
      const result = speakerSummaryForMatch(matches);
      setSpeakerState({
        summary: `${result.summary} Sample length: ${turn.speakerSampleMs}ms.`,
        match: result.match,
        sampleMs: turn.speakerSampleMs,
      });
      if (!result.recognized) queueUnknownSpeakerPrompt(result.match);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSpeakerState({
        summary: `Latest speaker recognition: skipped (${message}).`,
        sampleMs: turn.speakerSampleMs,
      });
    }
  }

  function queueUnknownSpeakerPrompt(match?: VoicePersonMatch): void {
    const now = Date.now();
    if (now - lastUnknownSpeakerPromptAt < cfg.speakerNoveltyCooldownMs) return;
    lastUnknownSpeakerPromptAt = now;
    const seen =
      lastVision?.matchName &&
      (lastVision.confidence ?? 0) >= cfg.cameraAutoMinConfidence
        ? ` I can see someone who may be ${lastVision.matchName}, but this voice is not confirmed yet.`
        : "";
    const closest = match
      ? ` The closest saved voice was ${match.name}, but confidence was only ${Math.round(match.confidence * 100)}%.`
      : "";
    pendingUnknownSpeakerPrompt =
      `A new or uncertain speaker was just detected.${seen}${closest} Ask one brief question to identify who is speaking so you can remember the voice. If they give a name, use voice_person_remember with that confirmed name.`;
    setSpeakerState({
      summary:
        lastSpeaker?.summary ??
        "Latest speaker recognition: new or uncertain speaker.",
      match,
      sampleMs: lastSpeaker?.sampleMs,
      unknownPromptPending: true,
    });
    setTimeout(() => maybeSpeakPendingUnknownSpeaker(), 1200);
  }

  function maybeSpeakPendingUnknownSpeaker(): void {
    if (!pendingUnknownSpeakerPrompt || !listening || !client.connected) return;
    if (
      responseInFlight ||
      audioResponseStarted ||
      (activeTurn &&
        (!activeTurn.responseDone ||
          activeTurn.pendingTools > 0 ||
          activeTurn.sawToolCall))
    ) {
      setTimeout(() => maybeSpeakPendingUnknownSpeaker(), 1500);
      return;
    }
    const prompt = pendingUnknownSpeakerPrompt;
    pendingUnknownSpeakerPrompt = "";
    if (lastSpeaker) {
      lastSpeaker = { ...lastSpeaker, unknownPromptPending: false };
      syncState();
    }
    client.createResponse(currentInstructions(prompt));
  }

  async function rememberCurrentSpeaker(args: {
    name: string;
    relationship?: string;
    notes?: string;
  }): Promise<string> {
    if (!cfg.speakerRecognitionEnabled) {
      return "Speaker recognition is disabled by FRIDAY_VOICE_SPEAKER_RECOGNITION=false.";
    }
    if (!lastSpeakerSample) {
      return "No recent speaker sample is available yet. Ask the person to speak once, then try again.";
    }
    try {
      const remembered = await rememberVoicePerson({
        name: args.name,
        pcm: lastSpeakerSample.pcm,
        sampleRate: lastSpeakerSample.sampleRate,
        relationship: args.relationship,
        notes: args.notes,
      });
      const summary = `Latest speaker recognition: confirmed and remembered ${remembered.profile.name}. Future matches can use ${remembered.profile.name}'s saved voice profile.`;
      setSpeakerState({
        summary,
        sampleMs: lastSpeakerSample.durationMs,
      });
      pendingUnknownSpeakerPrompt = "";
      return [
        `Remembered voice identity for ${remembered.profile.name}.`,
        `Person id: ${remembered.profile.id}`,
        `Reference sample: ${remembered.sample.path}`,
        `Duration: ${remembered.sample.durationMs}ms`,
        remembered.indexed
          ? "Engram index updated."
          : "Engram index update was skipped or already running.",
      ].join("\n");
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
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
      captureSpeakerChunk(b64, lvl, durationMs);
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
  let visualTimer: ReturnType<typeof setInterval> | null = null;
  let visualRunning = false;
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
      cameraEnabled: cfg.cameraEnabled,
      cameraIndex: cfg.cameraIndex,
      cameraWarmupMs: cfg.cameraWarmupMs,
      cameraAutoRecognize: cfg.cameraAutoRecognize,
      cameraAutoIntervalMs: cfg.cameraAutoIntervalMs,
      speakerRecognitionEnabled: cfg.speakerRecognitionEnabled,
      interruptMinLevel: cfg.interruptMinLevel,
      interruptFrames: cfg.interruptFrames,
      micPeakLevel: lastPeakLevel,
      lastLatency,
      lastVision,
      lastSpeaker,
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
    startAutoVision();
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
    stopAutoVision();
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
