// The long-lived voice daemon. Wires Realtime WS ↔ mic/speaker ↔ tools and owns
// the listen/idle lifecycle. Starts IDLE; SIGUSR2 toggles listening; SIGTERM
// shuts down cleanly. The CLI sends those signals (driven by HUD hotkey / `friday-voice`).

import { loadVoiceConfig } from "./config.ts";
import { loadVoicePersona } from "./persona.ts";
import {
  toolDefsForConfig,
  ToolRunner,
  type ToolRunResult,
} from "./tools.ts";
import { finalToolInstructions, finalToolSpeech } from "./tool-final.ts";
import { MicCapture, Player, cue, rms16 } from "./audio.ts";
import { RealtimeClient } from "./realtime.ts";
import {
  completeShortSentence,
  isLikelyNoiseTranscript as isTranscriptNoise,
} from "./speech-text.ts";
import {
  deterministicAction,
  favoriteSongAppAction,
  likelyNeedsPostToolContinuation,
  likelyNeedsPostVisionAction,
  likelyNeedsMemoryRecall,
  likelyNeedsTool,
  preferredToolForAction,
  type DeterministicAction,
} from "./action-routing.ts";
import { HudServer } from "./hud-server.ts";
import { spawnOverlay } from "./hud-overlay.ts";
import {
  writePid,
  writeState,
  clearPid,
  readInjectRequest,
  clearInjectRequest,
  type DaemonState,
  type VoiceActionState,
  type VoiceProbeState,
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
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
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
const VOICE_AUDIO_CACHE_DIR = "/tmp/friday-voice/audio-cache";

interface VoiceTurn {
  id: string;
  userText: string;
  partialUserText: string;
  assistantText: string;
  speechStartedAt: number | null;
  speechStoppedAt: number | null;
  transcriptAt: number | null;
  transcriptCompletedAt: number | null;
  recallStartedAt: number | null;
  recallEndedAt: number | null;
  responseCreateAt: number | null;
  firstAudioAt: number | null;
  responseDoneAt: number | null;
  responseRequested: boolean;
  responseToolCandidate: boolean;
  inputCommitted: boolean;
  responseDone: boolean;
  sawToolCall: boolean;
  actionCandidate: boolean;
  pendingTools: number;
  toolCallCount: number;
  captureAttempts: number;
  captured: boolean;
  fallbackTimer: ReturnType<typeof setTimeout> | null;
  responseTimer: ReturnType<typeof setTimeout> | null;
  captureTimer: ReturnType<typeof setTimeout> | null;
  speakerChunks: Buffer[];
  speakerSampleMs: number;
  speakerAnalyzed: boolean;
  localTextSpeech: boolean;
  localTextSpoken: boolean;
  toolProgressSpoken: boolean;
  injectId?: string;
}

function engineeringContext(cfg: ReturnType<typeof loadVoiceConfig>): string {
  const repos =
    cfg.repos.map((r) => `- ${r.name}: ${r.path}`).join("\n") ||
    "- friday: this repo";
  return [
    "## Engineering voice routing",
    "You are a capable Mac agent with explicit tools for local memory, associative engram recall, web search, browser reading/screenshots, current-screen screenshots, mouse control, shell, AppleScript, and engineering dispatch.",
    "You run on the user's Mac with real control. Never refuse a Mac/app/media task or claim you cannot do it: do not say 'I can't control Spotify/Music', 'I can't do that here', 'I'm unable to', 'you can open it yourself', or 'ask Siri'. For any 'play/open/control <app>' request, open the app (open_app) and drive it with app_search_text (mode play for songs), key_combo/type_text, mouse_control, or run_applescript (e.g. tell application \"Spotify\" to play). Only report a limitation if a tool you actually called this turn failed, quoting what it returned.",
    "NEVER hand a step back to the user. Do not say 'use the address bar', 'type it in', 'switch to that window', 'click it yourself', 'open YouTube and...', or otherwise instruct him to do something you can do — finish it with your own tools (browser_open_url, find_and_click, key_combo, run_applescript). If a window isn't focused, focus it yourself (open_app / activate) and continue; never stop a task because another window was in front.",
    "For questions involving the user's past preferences, previous project context, remembered decisions, or how he likes work done, use memory_search and/or engram_recall before answering. Use remember when the user asks you to remember something or states a stable preference/lesson.",
    "MEMORY HONESTY: for any question about what the user told you, when, or WHY — actually check your memory (use memory_search/engram_recall, or the injected memory block) and answer ONLY from what you find there. If your memory does not contain the answer — for example you recorded the fact but not a reason — say so plainly (e.g. 'You told me it's your favorite but never said why'). NEVER invent a reason, date, or detail you did not actually record, and never stall with 'let me think' without calling a memory tool. A truthful 'I don't have that saved' beats a made-up answer.",
    "If the injected associative-memory block contains a direct answer to a preference question, use it directly instead of asking the user again.",
    "For current or internet-dependent facts, use web_search first, then browser_page_text on the most relevant URLs before making claims.",
    "For any work likely to take more than about two seconds, start it with run_shell_background or dispatch_engineering, then speak a brief acknowledgement while it continues. Use background_job_status later when the user asks for progress.",
    "For browser/UI tasks, STRONGLY prefer deterministic automation over clicking pixel coordinates — coordinate clicks are unreliable and slow. Choose in this order: (1) a direct URL that lands exactly where you need; (2) keyboard shortcuts plus type_text in the focused app; (3) run_applescript UI scripting; only as a last resort (4) screen_see + mouse_control. Known recipes: Gmail compose -> browser_open_url \"https://mail.google.com/mail/u/0/?view=cm&fs=1\" (opens a compose window directly, no clicking; then type_text the recipient/subject/body, Tab between fields); Gmail already open -> press the 'c' key to compose; web search -> browser_submit_text. Play a YouTube video -> browser_open_url to a watch URL if you know it (e.g. https://www.youtube.com/watch?v=dQw4w9WgXcQ for Never Gonna Give You Up), otherwise browser_open_url \"https://www.youtube.com/results?search_query=<terms>\" then find_and_click \"the first video thumbnail\" to play it; never tell the user to type it in the address bar. To play/pause/seek a video already in the browser, run_applescript executing JS on the active tab (e.g. tell application \"Google Chrome\" to tell active tab of front window to execute javascript \"document.querySelector('video').pause()\" — use .play() to resume) — never say the browser blocks control or ask the user to hit pause himself. NEVER press cmd+r or reload a page mid-task. After opening a page, let it finish loading before acting — if screen_see shows it still loading or blank, wait a moment and look again instead of clicking or reopening.",
    "CRITICAL — keep your eyes on your hands: your own editor/terminal is often the frontmost window, so a raw screenshot may show code instead of the app you opened. Whenever you call screen_see for a specific app, pass app=<that app> (e.g. app=\"Google Chrome\") so it is activated and raised before the capture. Do the same before mouse_control — make sure that app is frontmost first. If screen_see shows a different app than you expect, you are looking at the wrong window: focus the right app and look again before acting or speaking.",
    "To CLICK anything, use find_and_click with a plain description (e.g. find_and_click target=\"the Compose button\" app=\"Google Chrome\") — Claude vision locates the exact pixel and clicks it reliably. Prefer this over mouse_control, which needs exact coordinates and should only be used for drags or when you already know the precise point. After a find_and_click, use screen_see (same app) to confirm if needed.",
    "Use screen_screenshot only when a saved file path is enough. The orange ring means you are controlling the pointer; if the orange helper lacks permission, mouse_control may fall back to Terminal Accessibility for simple clicks.",
    "Do not claim screen recording, screenshot, browser screenshot, or mouse permission is missing based on memory or old errors. Verify the current session first with screen_see, browser_screenshot, or mouse_control check; only report a permission problem when the tool output from this turn says so.",
    "For music/media: SEARCHING OR OPENING AN APP IS NOT PLAYING. Spotify and Apple Music show search results when you type and press Enter, but they do NOT start a song on their own — app_search_text only searches. To actually PLAY a specific song: (1) open_app the player and search the song (app_search_text or type in its search box), then (2) find_and_click target=\"the play button on the top result\" app=\"Spotify\" to start it (if a play button isn't visible, find_and_click \"the first song in the search results\" which plays it), then (3) verify with screen_see that a track is actually playing. To resume/pause/skip the CURRENT track, use run_applescript (e.g. tell application \"Spotify\" to play / to pause / to next track) — but plain 'play' only resumes an already-loaded track, it will NOT start a brand-new search result. NEVER say a song is playing until you have clicked play and seen it playing; do not narrate success you have not confirmed.",
    cfg.cameraEnabled
      ? "Camera vision is enabled. For physical-world visual questions, use current_perception first when cached context is enough; use camera_see only when you need a fresh visual inspection. For identity, use confirmed visual-person memory as tentative context; if no confident match exists, ask for the person's name, then use visual_person_remember only after explicit confirmation."
      : "Camera vision is disabled by FRIDAY_VOICE_CAMERA=false. Do not claim you can see through the camera.",
    cfg.speakerRecognitionEnabled
      ? "Speaker recognition is enabled. Use the current speaker context as tentative. If a new or unknown speaker identifies themselves, call voice_person_remember with the confirmed name. Do not claim a speaker identity from a weak match."
      : "Speaker recognition is disabled by FRIDAY_VOICE_SPEAKER_RECOGNITION=false.",
    "For Slack app tasks, control the visible Slack app instead of using Slack API tokens: open_app Slack, use cmd+k to jump to a channel/person such as agent-test, press return, type the message, then press return to send.",
    "For substantial coding/build/debug/review tasks, use dispatch_engineering.",
    "Do not ask the user which repo to use unless the request is truly ambiguous and choosing wrong would be destructive.",
    "Infer the repo from GitHub URLs, PR URLs, explicit repo names, or keywords: backend/api -> example-backend; mobile/app/expo/iOS/Android -> example-mobile; web/Next/frontend -> example-web; admin/dashboard -> example-admin; talent/candidate -> example-talent-client.",
    "Use local Codex for engineering dispatch by default. Use Slack/Claude dispatch only if the user explicitly asks for the cloud/Slack/Claude route.",
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
        "the user stable preferences favorite song preferred apps voice agent settings",
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
  const voiceStyleGuard =
    "Voice response rule: speak once, briefly. Default to one short sentence under twenty words. Do not repeat the same confirmation or restate the same idea in different words. Never preface answers with filler like 'got it', 'got you', 'understood', 'let me think', 'let me check', 'one sec', or 'thinking'. If you need more information, ask the shortest useful question instead of narrating your thinking. The local voice system may already play a short working acknowledgement for tool turns; during tool-selection and intermediate tool steps, call tools silently unless explicit turn instructions ask you to speak. Never say you are checking, opening, running, changing, or doing a Mac action unless you call the matching tool in that same response. If no tool is called, answer only from what you know and be clear about limits. If a task is done, say only the result.";
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
  let instructionUpdateTimer: ReturnType<typeof setTimeout> | null = null;

  function currentInstructions(extra?: string): string {
    return [
      baseInstructions,
      visualInstructionBlock,
      speakerInstructionBlock,
      extra,
      voiceStyleGuard,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  function fastMemorySpeech(text: string): string | undefined {
    if (!isFavoriteSongQuestion(text)) return undefined;
    const song = extractFavoriteSong(voiceMemoryPrimer);
    return song ? `${song}.` : undefined;
  }

  function isFavoriteSongQuestion(text: string): boolean {
    const t = text.trim().toLowerCase();
    if (!t) return false;
    return (
      /\b(what(?:'s| is)|which|tell me|remind me|do you remember|remember)\b[\s\S]{0,80}\b(my|anmol'?s)\s+(favorite|favourite)\s+song\b/.test(
        t,
      ) ||
      /\b(my|anmol'?s)\s+(favorite|favourite)\s+song\??$/.test(t)
    );
  }

  function extractFavoriteSong(memoryText: string): string | undefined {
    const cleaned = memoryText.replace(/\s+/g, " ");
    const match =
      cleaned.match(
        /\bthe user(?:'s)? favorite song (?:is|=)\s+(.+?)(?:\.|;|,?\s+When\b|$)/i,
      ) ??
      cleaned.match(
        /\bfavorite song (?:is|=)\s+(.+?)(?:\.|;|,?\s+When\b|$)/i,
      );
    const song = match?.[1]
      ?.replace(/\s*\([^)]*\)\s*$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!song || song.length > 80) return undefined;
    return song;
  }

  const toolDefs = toolDefsForConfig(cfg);
  const tools = new ToolRunner(cfg, {
    currentPerception: perceptionContextForTool,
    rememberCurrentSpeaker,
  });
  let audioPlaybackActive = false;
  let autoIdlePending = false;
  let autoIdleTimer: ReturnType<typeof setTimeout> | null = null;
  const player = new Player(
    cfg.sampleRate,
    cfg.playbackPrebufferMs,
    cfg.audioPlayer,
    cfg.playbackGain,
    () => {
      audioPlaybackActive = false;
      if (listening && !modelIsBusy()) hud.set("listening");
      syncState();
      maybeSpeakPendingUnknownSpeaker();
      maybeAutoIdleAfterTurn("audio idle");
    },
  );
  let toolAckPcm: Buffer | null = null;
  let toolAckLoad: Promise<Buffer | null> | null = null;
  let toolAckFailed = false;
  let toolProgressPcm: Buffer | null = null;
  let toolProgressLoad: Promise<Buffer | null> | null = null;
  let toolProgressFailed = false;
  const speechLoads = new Map<string, Promise<Buffer | null>>();
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
  const micRing: Array<{ b64: string; level: number; durationMs: number }> = [];
  let localSpeechOpen = false;
  let localSpeechHighFrames = 0;
  let localSpeechSilenceMs = 0;
  let localSpeechOpenedAt = 0;
  let localNoiseFloor = 0;
  let localSpeechSentToServer = false;
  let ignoredServerSpeechActive = false;
  let activeTurn: VoiceTurn | null = null;
  let lastLatency: VoiceLatencyState | undefined;
  let lastAction: VoiceActionState | undefined;
  let lastProbe: VoiceProbeState | undefined;
  let heldAssistantAudio: Array<{
    pcm: Buffer;
    meta: { itemId?: string; contentIndex: number; responseId?: string };
  }> = [];
  let audioHoldTimer: ReturnType<typeof setTimeout> | null = null;
  let holdingInitialAudio = false;
  let dropCurrentResponseAudio = false;
  let holdAudioForCurrentResponse = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let realtimeFatalError = "";

  // On-screen holographic HUD (localhost page + transparent Swift overlay).
  const hud = new HudServer(cfg.hudPort);
  let overlayProc: Subprocess | null = null;
  if (cfg.hudEnabled) {
    if (hud.start()) {
      overlayProc = await spawnOverlay(hud.url);
    }
  }

  const client = new RealtimeClient(cfg, currentInstructions(), toolDefs, {
    onAudioDelta: (pcm, meta) => {
      const now = Date.now();
      if (now < dropCanceledAudioUntil) return;
      if (dropCurrentResponseAudio) return;
      if (shouldHoldAssistantAudio()) {
        beginAssistantAudioHold();
        heldAssistantAudio.push({ pcm, meta });
        return;
      }
      playAssistantAudio(pcm, meta);
    },
    onSpeechStarted: () => {
      const now = Date.now();
      if (now < suppressMicUntil) {
        log("ignored speech_started during speaker echo guard");
        ignoredServerSpeechActive = true;
        activeTurn = null;
        resetLocalSpeechGate();
        return;
      }
      if (modelIsBusy()) {
        log("ignored speech_started while model is busy");
        ignoredServerSpeechActive = true;
        activeTurn = null;
        resetLocalSpeechGate();
        return;
      }
      ignoredServerSpeechActive = false;
      if (activeTurn && activeTurn.speechStoppedAt == null) {
        activeTurn.speechStartedAt ??= now;
      } else {
        beginVoiceTurn(now);
      }
      if (listening) hud.set("hearing");
    },
    onSpeechStopped: () => {
      if (ignoredServerSpeechActive) {
        ignoredServerSpeechActive = false;
        if (listening) hud.set(modelIsBusy() ? "speaking" : "listening");
        log("ignored speech_stopped for rejected server speech");
        return;
      }
      const turn = activeTurn;
      if (!turn) {
        if (listening) hud.set("listening");
        log("ignored speech_stopped with no active local turn");
        return;
      }
      markSpeechStopped(turn);
      if (!cfg.backgroundTranscription) scheduleResponseFallback(turn);
    },
    onInputCommitted: () => {
      const turn = activeTurn ?? beginVoiceTurn(Date.now());
      turn.inputCommitted = true;
      markSpeechStopped(turn);
      if (cfg.backgroundTranscription) scheduleVoiceResponse(turn, false);
    },
    onResponseCreated: () => {
      responseInFlight = true;
      dropCurrentResponseAudio = false;
      if (activeTurn) {
        activeTurn.responseCreateAt ??= Date.now();
        if (activeTurn.injectId && lastProbe?.id === activeTurn.injectId) {
          markProbe({
            id: activeTurn.injectId,
            responseCount: (lastProbe.responseCount ?? 0) + 1,
          });
        }
      }
    },
    onResponseDone: ({ audioChunks, expectedAudio }) => {
      responseInFlight = false;
      if (dropCurrentResponseAudio) clearHeldAssistantAudio();
      else flushHeldAssistantAudio();
      if (Date.now() < dropCanceledAudioUntil) {
        dropCanceledAudioUntil = 0;
        estimatedPlaybackUntil = 0;
        suppressMicUntil = 0;
        audioResponseStarted = false;
        audioPlaybackActive = false;
        assistantAudioStartedAt = 0;
        interruptsThisResponse = 0;
        activeAssistantAudioItemId = null;
        clearHeldAssistantAudio();
        player.flush();
        if (listening) hud.set("hearing", "interrupted");
        return;
      }
      const turn = activeTurn;
      if (expectedAudio && audioChunks === 0 && turn) {
        log("audio response produced no chunks; ending silent response");
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
      dropCurrentResponseAudio = false;
      player.finishSoon();
      if (listening) hud.set(audioPlaybackActive ? "speaking" : "listening");
      if (turn) {
        if (turn.localTextSpeech && !turn.localTextSpoken) {
          turn.responseDone = true;
          void speakTurnTextLocally(turn);
          return;
        }
        turn.responseDoneAt = Date.now();
        turn.responseDone = true;
        if (turn.injectId && expectedAudio && lastProbe?.id === turn.injectId) {
          markProbe({
            id: turn.injectId,
            status: "done",
            doneMs: turn.responseDoneAt - lastProbe.at,
            transcript: turn.assistantText.trim() || lastProbe.transcript,
          });
          if (!listening && cfg.wsIdleOff) client.close();
        }
        const latency = computeTurnLatency(turn, turn.responseDoneAt);
        if (hasUsefulLatency(latency)) {
          lastLatency = latency;
          log(`latency response_done: ${formatLatency(lastLatency)}`);
          syncState();
        }
        scheduleVoiceCapture(turn);
        maybeSpeakPendingUnknownSpeaker();
        maybeAutoIdleAfterTurn("response done");
      }
    },
    onUserTranscript: (t) => {
      void handleUserTranscript(t);
    },
    onUserTranscriptDelta: (t) => {
      handleUserTranscriptDelta(t);
    },
    onUserTranscriptCompleted: (t) => {
      handleUserTranscriptCompleted(t);
    },
    onAssistantTranscript: (t) => {
      const turn = activeTurn;
      if (!turn) return;
      turn.assistantText = t.trim();
      if (turn.injectId && lastProbe?.id === turn.injectId) {
        markProbe({ id: turn.injectId, transcript: turn.assistantText });
      }
      log("said:", turn.assistantText);
      if (turn.responseDone) scheduleVoiceCapture(turn);
    },
    onAssistantText: (t) => {
      const turn = activeTurn;
      if (!turn) return;
      turn.assistantText = t.trim();
      log("text:", turn.assistantText);
      if (turn.localTextSpeech && turn.responseDone && !turn.localTextSpoken) {
        void speakTurnTextLocally(turn);
      }
    },
    onFunctionCall: async ({ callId, name, args }) => {
      log(`tool: ${name}`, JSON.stringify(args).slice(0, 200));
      const turn = ensureVoiceTurn();
      turn.sawToolCall = true;
      turn.toolCallCount++;
      turn.pendingTools++;
      if (listening) hud.set("thinking", name.replace(/_/g, " "));
      const toolStartedAt = Date.now();
      const result = await tools.exec(name, args);
      const toolMs = Date.now() - toolStartedAt;
      turn.pendingTools = Math.max(0, turn.pendingTools - 1);
      turn.responseDone = false;
      const output = toolOutput(result);
      const images = toolImages(result);
      recordAction({
        tool: name,
        direct: false,
        ms: toolMs,
        toolCallCount: turn.toolCallCount,
        output,
      });
      if (images.length > 0) {
        client.sendFunctionResult(callId, output, false);
        for (const image of images) {
          client.sendImageInput(image.path, image.prompt);
        }
        const intentText = turn.userText || turn.partialUserText;
        const continueSilently = likelyNeedsPostVisionAction(intentText);
        const loopElapsedMs = turn.speechStoppedAt
          ? Date.now() - turn.speechStoppedAt
          : 0;
        if (continueSilently) {
          maybePlayToolProgress(turn, loopElapsedMs, name);
        }
        turn.localTextSpeech = continueSilently;
        client.createResponse(
          continueSilently
            ? currentInstructions(
                "Vision observation turn: inspect the attached screen image. If another concrete UI/tool action is needed, call that tool now. If the page is loading, blank, or not yet showing the content needed for the user's request, wait briefly with run_shell and inspect again once before reporting. If the screenshot already answers the user's request, return the answer as concise text; the local voice system will speak it.",
              )
            : currentInstructions(
                "A screen or camera image is attached. Answer the user's visual request aloud in one complete sentence of eight words or fewer. Name the main app, object, person, or UI state. End with a period. Do not say the task is handled. Do not call tools or read file paths.",
              ),
          {
            queueIfActive: true,
            maxOutputTokens: continueSilently
              ? cfg.maxToolCallTokens
              : cfg.maxOutputTokens,
            toolChoice: continueSilently ? "auto" : "none",
            outputModalities: continueSilently ? ["text"] : ["audio"],
          },
        );
      } else {
        const intentText = turn.userText || turn.partialUserText;
        const continueTask = likelyNeedsPostToolContinuation({
          text: intentText,
          lastTool: name,
          toolCallCount: turn.toolCallCount,
        });
        const loopElapsedMs = turn.speechStoppedAt
          ? Date.now() - turn.speechStoppedAt
          : 0;
        const loopOverBudget =
          (cfg.toolLoopMaxCalls > 0 &&
            turn.toolCallCount >= cfg.toolLoopMaxCalls) ||
          (cfg.toolLoopMaxMs > 0 && loopElapsedMs >= cfg.toolLoopMaxMs);
        if (continueTask && !loopOverBudget) {
          maybePlayToolProgress(turn, loopElapsedMs, name);
          holdAudioForCurrentResponse = false;
          client.sendFunctionResult(callId, output, true, {
            instructions: currentInstructions(
              "Continue the user's multi-step Mac task. If another concrete UI/tool action is needed, call that tool now. Do not speak until the task is complete or genuinely blocked.",
            ),
            maxOutputTokens: cfg.maxToolCallTokens,
            toolChoice: "auto",
            outputModalities: ["text"],
          });
          return;
        }
        if (continueTask && loopOverBudget) {
          log(
            `tool loop budget hit: calls=${turn.toolCallCount}/${cfg.toolLoopMaxCalls} elapsed=${loopElapsedMs}/${cfg.toolLoopMaxMs}ms`,
          );
          client.sendFunctionResult(callId, output, true, {
            instructions: currentInstructions(
              "The UI task has taken too long or needed too many repeated steps. Speak one short progress update saying you are still working through the UI and stopped to avoid getting stuck. Do not claim the task is complete.",
            ),
            maxOutputTokens: cfg.maxOutputTokens,
            toolChoice: "none",
            outputModalities: ["audio"],
          });
          return;
        }
        if (cfg.aiDriven) {
          client.sendFunctionResult(callId, output, true, {
            instructions: currentInstructions(
              "The tool finished and its result is in the function output above. Tell the user the real outcome in one short spoken sentence, grounded in that output. If it shows an error or the task is not actually done, say so plainly — never claim a success you cannot see in the output.",
            ),
            maxOutputTokens: cfg.maxOutputTokens,
            toolChoice: "none",
            outputModalities: ["audio"],
          });
          return;
        }
        client.sendFunctionResult(callId, output, false);
        const speech = finalToolSpeech(name, output);
        if (await playLocalSpeech(turn, speech, name)) return;
        client.createResponse(currentInstructions(finalToolInstructions(name, output)), {
          queueIfActive: true,
          maxOutputTokens: cfg.maxOutputTokens,
          toolChoice: "none",
          outputModalities: ["audio"],
        });
      }
    },
    onFunctionCallStarted: ({ name }) => {
      const turn = ensureVoiceTurn();
      turn.sawToolCall = true;
      turn.localTextSpeech = false;
      if (holdAudioForCurrentResponse) {
        flushHeldAssistantAudio();
        holdAudioForCurrentResponse = false;
        log(
          `released pre-tool audio while ${name ? `${name} ` : ""}tool call started`,
        );
      }
    },
    onOpen: () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      syncState();
    },
    onClose: () => {
      resetResponseActivity(true);
      resetLocalSpeechGate();
      if (
        lastProbe &&
        (lastProbe.status === "queued" || lastProbe.status === "running")
      ) {
        markProbe({
          id: lastProbe.id,
          status: "error",
          message: "Realtime connection closed before the response completed.",
        });
      }
      if (listening) {
        if (realtimeFatalError) hud.set("offline", realtimeFatalError);
        else {
          hud.set("listening", "reconnecting");
          scheduleRealtimeReconnect();
        }
      }
      syncState();
    },
    onError: (err) => {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code?: unknown }).code ?? "")
          : "";
      if (code === "input_audio_buffer_commit_empty") {
        log("cleared empty input audio turn");
        resetLocalSpeechGate();
        if (activeTurn && !activeTurn.responseRequested) activeTurn = null;
        if (listening && !modelIsBusy()) hud.set("listening");
        syncState();
        return;
      }
      if (code === "invalid_api_key") {
        realtimeFatalError = code;
        log("realtime fatal error: invalid_api_key; reconnect paused");
        if (listening) hud.set("offline", "invalid_api_key");
        syncState();
      }
    },
  });
  prewarmToolAck();
  prewarmToolProgressAck();
  if (!cfg.aiDriven) prewarmCommonFinalSpeech();

  function newVoiceTurn(speechStartedAt: number | null = null): VoiceTurn {
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      userText: "",
      partialUserText: "",
      assistantText: "",
      speechStartedAt,
      speechStoppedAt: null,
      transcriptAt: null,
      transcriptCompletedAt: null,
      recallStartedAt: null,
      recallEndedAt: null,
      responseCreateAt: null,
      firstAudioAt: null,
      responseDoneAt: null,
      responseRequested: false,
      responseToolCandidate: false,
      inputCommitted: false,
      responseDone: false,
      sawToolCall: false,
      actionCandidate: false,
      pendingTools: 0,
      toolCallCount: 0,
      captureAttempts: 0,
      captured: false,
      fallbackTimer: null,
      responseTimer: null,
      captureTimer: null,
      speakerChunks: [],
      speakerSampleMs: 0,
      speakerAnalyzed: false,
      localTextSpeech: false,
      localTextSpoken: false,
      toolProgressSpoken: false,
    };
  }

  function toolOutput(result: ToolRunResult): string {
    return typeof result === "string" ? result : result.output;
  }

  function toolImages(result: ToolRunResult): Array<{ path: string; prompt?: string }> {
    return typeof result === "string" ? [] : (result.realtimeImages ?? []);
  }

  function recordAction(args: {
    tool: string;
    direct: boolean;
    ms?: number;
    toolCallCount?: number;
    output: string;
  }): void {
    const backgroundJobId = findBackgroundJobId(args.output);
    lastAction = {
      at: Date.now(),
      tool: args.tool,
      direct: args.direct,
      ms: args.ms,
      toolCallCount: args.toolCallCount,
      summary: args.output.replace(/\s+/g, " ").trim().slice(0, 180),
      ...(backgroundJobId ? { backgroundJobId } : {}),
    };
    syncState();
  }

  function findBackgroundJobId(output: string): string | undefined {
    return output
      .match(/background job ([A-Za-z0-9_.-]+)/i)?.[1]
      ?.replace(/[.,;:]+$/, "");
  }

  function markProbe(update: Partial<VoiceProbeState> & { id: string }): void {
    const previous =
      lastProbe && lastProbe.id === update.id ? lastProbe : undefined;
    const { id, ...rest } = update;
    lastProbe = {
      id,
      text: update.text ?? previous?.text ?? "",
      at: update.at ?? previous?.at ?? Date.now(),
      status: update.status ?? previous?.status ?? "running",
      ...(previous?.firstAudioMs != null
        ? { firstAudioMs: previous.firstAudioMs }
        : {}),
      ...(previous?.doneMs != null ? { doneMs: previous.doneMs } : {}),
      ...(previous?.turnStartMs != null
        ? { turnStartMs: previous.turnStartMs }
        : {}),
      ...(previous?.responseCount != null
        ? { responseCount: previous.responseCount }
        : {}),
      ...(previous?.transcript ? { transcript: previous.transcript } : {}),
      ...(previous?.message ? { message: previous.message } : {}),
      ...rest,
    };
    syncState();
  }

  function scheduleRealtimeReconnect(delayMs = 350): void {
    if (realtimeFatalError) return;
    if (!listening || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!listening || client.connected) {
        syncState();
        return;
      }
      if (realtimeFatalError) {
        syncState();
        return;
      }
      log("reconnecting realtime after unexpected close");
      client.connect();
      syncState();
    }, delayMs);
  }

  async function waitForRealtimeReady(timeoutMs = 8_000): Promise<boolean> {
    if (realtimeFatalError) return false;
    if (!client.connected) client.connect();
    const deadline = Date.now() + timeoutMs;
    while (!realtimeFatalError && !client.ready && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return !realtimeFatalError && client.ready;
  }

  async function waitForModelIdle(timeoutMs = 8_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (modelIsBusy() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return !modelIsBusy();
  }

  function shouldHoldAssistantAudio(): boolean {
    if (!holdAudioForCurrentResponse) return false;
    if (cfg.toolAudioHoldMs <= 0) return false;
    if (holdingInitialAudio) return true;
    const turn = activeTurn;
    if (!turn || turn.sawToolCall || turn.responseDone) return false;
    return true;
  }

  function beginAssistantAudioHold(): void {
    if (holdingInitialAudio) return;
    holdingInitialAudio = true;
    audioHoldTimer = setTimeout(() => {
      flushHeldAssistantAudio();
    }, cfg.toolAudioHoldMs);
  }

  function flushHeldAssistantAudio(): void {
    if (audioHoldTimer) {
      clearTimeout(audioHoldTimer);
      audioHoldTimer = null;
    }
    if (!holdingInitialAudio && heldAssistantAudio.length === 0) return;
    holdingInitialAudio = false;
    const chunks = heldAssistantAudio;
    heldAssistantAudio = [];
    for (const chunk of chunks) playAssistantAudio(chunk.pcm, chunk.meta);
  }

  function clearHeldAssistantAudio(): void {
    if (audioHoldTimer) {
      clearTimeout(audioHoldTimer);
      audioHoldTimer = null;
    }
    heldAssistantAudio = [];
    holdingInitialAudio = false;
    dropCurrentResponseAudio = false;
    holdAudioForCurrentResponse = false;
  }

  function speechCachePath(text: string, prefix: string): string {
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          model: cfg.toolLocalAckModel,
          voice: cfg.voice,
          text,
          rate: cfg.sampleRate,
          format: "pcm",
        }),
      )
      .digest("hex")
      .slice(0, 16);
    return path.join(VOICE_AUDIO_CACHE_DIR, `${prefix}-${hash}.pcm`);
  }

  async function loadSpeechPcm(
    textValue: string,
    prefix = "speech",
  ): Promise<Buffer | null> {
    const text = textValue.trim();
    if (!text) return null;
    const file = speechCachePath(text, prefix);
    if (speechLoads.has(file)) return speechLoads.get(file) ?? null;
    const load = (async () => {
      mkdirSync(VOICE_AUDIO_CACHE_DIR, { recursive: true });
      if (existsSync(file)) {
        const cached = readFileSync(file);
        if (cached.byteLength > 0) {
          log(`loaded cached ${prefix} audio (${cached.byteLength} bytes)`);
          return cached;
        }
      }
      const response = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.openaiApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: cfg.toolLocalAckModel,
          voice: cfg.voice,
          input: text,
          response_format: "pcm",
        }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `speech ${response.status}: ${body.slice(0, 240) || response.statusText}`,
        );
      }
      const pcm = Buffer.from(await response.arrayBuffer());
      if (pcm.byteLength === 0) throw new Error("speech returned empty PCM");
      writeFileSync(file, pcm);
      log(`cached ${prefix} audio (${pcm.byteLength} bytes)`);
      return pcm;
    })()
      .catch((err) => {
        log(
          `${prefix} audio unavailable:`,
          err instanceof Error ? err.message : String(err),
        );
        return null;
      })
      .finally(() => {
        speechLoads.delete(file);
      });
    speechLoads.set(file, load);
    return load;
  }

  async function loadToolAckPcm(): Promise<Buffer | null> {
    if (!cfg.toolLocalAckEnabled) return null;
    if (toolAckPcm) return toolAckPcm;
    if (toolAckFailed) return null;
    if (toolAckLoad) return toolAckLoad;
    toolAckLoad = (async () => {
      const pcm = await loadSpeechPcm(
        cfg.toolLocalAckText.trim() || "On it.",
        "tool-ack",
      );
      if (!pcm) {
        toolAckFailed = true;
        return null;
      }
      toolAckPcm = pcm;
      return pcm;
    })().finally(() => {
      toolAckLoad = null;
    });
    return toolAckLoad;
  }

  async function loadToolProgressPcm(): Promise<Buffer | null> {
    if (!cfg.toolProgressAckEnabled) return null;
    if (toolProgressPcm) return toolProgressPcm;
    if (toolProgressFailed) return null;
    if (toolProgressLoad) return toolProgressLoad;
    toolProgressLoad = (async () => {
      const pcm = await loadSpeechPcm(
        cfg.toolProgressAckText.trim() || "Still working through it.",
        "tool-progress",
      );
      if (!pcm) {
        toolProgressFailed = true;
        return null;
      }
      toolProgressPcm = pcm;
      return pcm;
    })().finally(() => {
      toolProgressLoad = null;
    });
    return toolProgressLoad;
  }

  function prewarmToolAck(): void {
    void loadToolAckPcm();
  }

  function prewarmToolProgressAck(): void {
    void loadToolProgressPcm();
  }

  function prewarmCommonFinalSpeech(): void {
    const phrases = [
      "It is open now.",
      "I searched it in the app.",
      "I started it in the app.",
      "I submitted it in the browser.",
      "I started Codex on it.",
      "I started it in the background.",
      "I jumped there.",
      "I sent it.",
      "I drafted it.",
      "Done.",
      "Google Chrome is frontmost.",
      "Slack is frontmost.",
      "Cursor is frontmost.",
      "Terminal is frontmost.",
      "Finder is frontmost.",
      "Calculator is frontmost.",
      "System Settings is frontmost.",
      "Notes is frontmost.",
      "Music is frontmost.",
      cfg.toolProgressAckText.trim() || "Still working through it.",
    ];
    for (const phrase of phrases) void loadSpeechPcm(phrase, "final");
  }

  function markTurnFirstAudio(turn: VoiceTurn, now: number): void {
    if (turn.firstAudioAt) return;
    turn.firstAudioAt = now;
    if (turn.injectId && lastProbe?.id === turn.injectId) {
      markProbe({
        id: turn.injectId,
        firstAudioMs: now - lastProbe.at,
        status: "running",
      });
    }
    lastLatency = computeTurnLatency(turn, now);
    log(`latency first_audio: ${formatLatency(lastLatency)}`);
    syncState();
  }

  function playToolAck(turn: VoiceTurn, reason: string): boolean {
    if (!cfg.toolLocalAckEnabled) return false;
    if (!toolAckPcm) {
      prewarmToolAck();
      return false;
    }
    if (audioPlaybackActive || audioResponseStarted || responseInFlight) {
      return false;
    }
    const now = Date.now();
    markTurnFirstAudio(turn, now);
    player.beginResponse();
    const pcmMs = Math.ceil((toolAckPcm.byteLength / (cfg.sampleRate * 2)) * 1000);
    estimatedPlaybackUntil =
      Math.max(estimatedPlaybackUntil, now + cfg.playbackPrebufferMs) + pcmMs;
    suppressMicUntil = estimatedPlaybackUntil + cfg.echoSuppressionMs;
    audioPlaybackActive = true;
    player.write(toolAckPcm);
    player.finishSoon(Math.max(900, pcmMs + 350));
    if (listening) {
      hud.set("speaking");
      voiceLevel = Math.max(voiceLevel, rms16(toolAckPcm));
    }
    log(`played local tool ack (${reason}, ${pcmMs}ms)`);
    return true;
  }

  function maybePlayToolProgress(
    turn: VoiceTurn,
    elapsedMs: number,
    reason: string,
  ): void {
    if (!cfg.toolProgressAckEnabled) return;
    if (turn.toolProgressSpoken) return;
    if (cfg.toolProgressAckAfterMs <= 0) return;
    if (elapsedMs < cfg.toolProgressAckAfterMs) return;
    playToolProgressAck(turn, reason);
  }

  function playToolProgressAck(turn: VoiceTurn, reason: string): boolean {
    if (!cfg.toolProgressAckEnabled) return false;
    if (turn.toolProgressSpoken) return false;
    if (!toolProgressPcm) {
      prewarmToolProgressAck();
      return false;
    }
    if (audioPlaybackActive || audioResponseStarted || responseInFlight) {
      return false;
    }
    const now = Date.now();
    markTurnFirstAudio(turn, now);
    player.beginResponse();
    const pcmMs = Math.ceil(
      (toolProgressPcm.byteLength / (cfg.sampleRate * 2)) * 1000,
    );
    estimatedPlaybackUntil =
      Math.max(estimatedPlaybackUntil, now + cfg.playbackPrebufferMs) + pcmMs;
    suppressMicUntil = estimatedPlaybackUntil + cfg.echoSuppressionMs;
    audioPlaybackActive = true;
    turn.toolProgressSpoken = true;
    player.write(toolProgressPcm);
    player.finishSoon(Math.max(900, pcmMs + 350));
    if (listening) {
      hud.set("speaking");
      voiceLevel = Math.max(voiceLevel, rms16(toolProgressPcm));
    }
    log(`played local tool progress ack (${reason}, ${pcmMs}ms)`);
    return true;
  }

  async function playLocalSpeech(
    turn: VoiceTurn,
    text: string,
    reason: string,
  ): Promise<boolean> {
    const pcm = await loadSpeechPcm(text, "final");
    if (!pcm) return false;
    const audioDeadline = Date.now() + 5_000;
    while (audioPlaybackActive && Date.now() < audioDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const now = Date.now();
    markTurnFirstAudio(turn, now);
    player.beginResponse();
    const pcmMs = Math.ceil((pcm.byteLength / (cfg.sampleRate * 2)) * 1000);
    estimatedPlaybackUntil =
      Math.max(estimatedPlaybackUntil, now + cfg.playbackPrebufferMs) + pcmMs;
    suppressMicUntil = estimatedPlaybackUntil + cfg.echoSuppressionMs;
    audioPlaybackActive = true;
    player.write(pcm);
    player.finishSoon(Math.max(900, pcmMs + 350));
    turn.assistantText = text;
    turn.responseDoneAt = Date.now();
    turn.responseDone = true;
    if (turn.injectId && lastProbe?.id === turn.injectId) {
      markProbe({
        id: turn.injectId,
        status: "done",
        doneMs: turn.responseDoneAt - lastProbe.at,
        transcript: text,
      });
    }
    lastLatency = computeTurnLatency(turn, turn.responseDoneAt);
    log(`latency local_speech_done: ${formatLatency(lastLatency)}`);
    syncState();
    if (listening) {
      hud.set("speaking");
      voiceLevel = Math.max(voiceLevel, rms16(pcm));
    }
    log(`played local final speech (${reason}, ${pcmMs}ms): ${text}`);
    scheduleVoiceCapture(turn);
    return true;
  }

  async function speakTurnTextLocally(turn: VoiceTurn): Promise<void> {
    if (turn.localTextSpoken) return;
    turn.localTextSpoken = true;
    turn.pendingTools++;
    try {
      const speech = completeShortSentence(turn.assistantText, 18);
      if (!(await playLocalSpeech(turn, speech, "vision_text"))) {
        turn.responseDoneAt = Date.now();
        turn.responseDone = true;
        scheduleVoiceCapture(turn);
      }
    } finally {
      turn.pendingTools = Math.max(0, turn.pendingTools - 1);
    }
  }

  function playAssistantAudio(
    pcm: Buffer,
    meta: { itemId?: string; contentIndex: number; responseId?: string },
  ): void {
    const now = Date.now();
    const itemId = meta.itemId ?? activeAssistantAudioItemId;
    if (
      !audioResponseStarted ||
      (itemId && itemId !== activeAssistantAudioItemId)
    ) {
      player.beginResponse();
      audioResponseStarted = true;
      audioPlaybackActive = true;
      assistantAudioStartedAt = now;
      interruptsThisResponse = 0;
      if (activeTurn) {
        activeTurn.responseDone = false;
        markTurnFirstAudio(activeTurn, now);
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
  }

  function clearVoiceTurnTimers(turn: VoiceTurn): void {
    if (turn.fallbackTimer) {
      clearTimeout(turn.fallbackTimer);
      turn.fallbackTimer = null;
    }
    if (turn.responseTimer) {
      clearTimeout(turn.responseTimer);
      turn.responseTimer = null;
    }
    if (turn.captureTimer) {
      clearTimeout(turn.captureTimer);
      turn.captureTimer = null;
    }
  }

  function resetResponseActivity(clearTurn = false): void {
    clearHeldAssistantAudio();
    responseInFlight = false;
    audioResponseStarted = false;
    audioPlaybackActive = false;
    assistantAudioStartedAt = 0;
    interruptsThisResponse = 0;
    interruptHighFrames = 0;
    activeAssistantAudioItemId = null;
    activeAssistantAudioContentIndex = 0;
    estimatedPlaybackUntil = 0;
    suppressMicUntil = 0;
    dropCanceledAudioUntil = 0;
    acceptedInterruptUntil = 0;
    holdAudioForCurrentResponse = false;
    autoIdlePending = false;
    if (autoIdleTimer) {
      clearTimeout(autoIdleTimer);
      autoIdleTimer = null;
    }
    if (clearTurn && activeTurn) {
      clearVoiceTurnTimers(activeTurn);
      activeTurn = null;
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

  function scheduleVoiceResponse(
    turn: VoiceTurn,
    includeMemory = true,
  ): void {
    if (turn.responseRequested || turn.responseTimer) return;
    const waitMs = Math.max(0, cfg.actionClassifyWaitMs);
    if (waitMs <= 0) {
      void requestVoiceResponse(turn, includeMemory);
      return;
    }
    turn.responseTimer = setTimeout(() => {
      turn.responseTimer = null;
      void requestVoiceResponse(turn, includeMemory);
    }, waitMs);
  }

  function requestVoiceResponseNow(
    turn: VoiceTurn,
    includeMemory = true,
    opts: { queueIfActive?: boolean } = {},
  ): void {
    if (turn.responseTimer) {
      clearTimeout(turn.responseTimer);
      turn.responseTimer = null;
    }
    void requestVoiceResponse(turn, includeMemory, opts);
  }

  function markSpeechStopped(turn: VoiceTurn): void {
    if (turn.speechStoppedAt != null) return;
    turn.speechStoppedAt = Date.now();
    if (listening) hud.set("thinking");
    void analyzeSpeakerTurn(turn);
  }

  async function handleUserTranscript(transcript: string): Promise<void> {
    const text = transcript.trim();
    if (!text) return;
    const turn = ensureVoiceTurn();
    turn.userText = text;
    turn.transcriptAt = Date.now();
    if (isLikelyNoiseTranscript(text)) {
      cancelNoiseTurn(turn, text);
      return;
    }
    const needsTool = likelyNeedsTool(text);
    if (needsTool && maybeRerouteLateActionTurn(turn, text)) {
      return;
    }
    if (!needsTool && likelyNeedsMemoryRecall(text) && maybeRerouteLateMemoryTurn(turn, text)) {
      return;
    }
    if (needsTool) {
      turn.actionCandidate = true;
      if (!turn.responseDone) holdAudioForCurrentResponse = true;
    }
    log("heard:", text);
    if (turn.fallbackTimer) {
      clearTimeout(turn.fallbackTimer);
      turn.fallbackTimer = null;
    }
    if (cfg.backgroundTranscription) {
      if (!turn.responseRequested) {
        requestVoiceResponseNow(turn, false);
        return;
      }
      if (turn.responseDone) scheduleVoiceCapture(turn);
      return;
    }
    await requestVoiceResponse(turn);
  }

  function maybeRerouteLateActionTurn(turn: VoiceTurn, text: string): boolean {
    if (!cfg.backgroundTranscription) return false;
    if (!turn.responseRequested) return false;
    if (turn.responseToolCandidate) return false;
    if (turn.sawToolCall) return false;
    if (turn.firstAudioAt || audioResponseStarted) return false;
    log("late transcript upgraded to tool turn:", text.slice(0, 160));
    clearHeldAssistantAudio();
    dropCanceledAudioUntil = Date.now() + 1500;
    dropCurrentResponseAudio = true;
    client.cancelResponse();
    turn.actionCandidate = true;
    turn.responseRequested = false;
    turn.responseDone = false;
    turn.responseCreateAt = null;
    turn.responseToolCandidate = false;
    holdAudioForCurrentResponse = false;
    setTimeout(() => {
      if (activeTurn !== turn || turn.responseRequested || turn.responseDone) return;
      requestVoiceResponseNow(turn, false, { queueIfActive: true });
    }, 120);
    return true;
  }

  function maybeRerouteLateMemoryTurn(turn: VoiceTurn, text: string): boolean {
    if (!cfg.backgroundTranscription) return false;
    if (!engramRecallEnabled()) return false;
    if (!turn.responseRequested) return false;
    if (turn.responseToolCandidate) return false;
    if (turn.sawToolCall) return false;
    if (turn.firstAudioAt || audioResponseStarted) return false;
    // AI-driven: never blurt a canned cached answer for memory questions. Route to
    // a real recall turn so the model actually answers what was asked (e.g. "how do
    // you know" must explain, not just name the song).
    const fastMemory = cfg.aiDriven ? undefined : fastMemorySpeech(text);
    if (fastMemory) {
      log("late transcript answered from memory primer:", text.slice(0, 160));
      clearHeldAssistantAudio();
      dropCurrentResponseAudio = true;
      client.cancelResponse();
      turn.responseDone = false;
      turn.responseCreateAt = null;
      turn.responseToolCandidate = false;
      holdAudioForCurrentResponse = false;
      setTimeout(() => {
        if (activeTurn !== turn || turn.firstAudioAt) return;
        turn.responseDone = false;
        turn.responseCreateAt = Date.now();
        void playLocalSpeech(turn, fastMemory, "memory_fast_late");
      }, 250);
      return true;
    }
    log("late transcript upgraded to memory turn:", text.slice(0, 160));
    clearHeldAssistantAudio();
    dropCanceledAudioUntil = Date.now() + 1500;
    dropCurrentResponseAudio = true;
    client.cancelResponse();
    turn.responseRequested = false;
    turn.responseDone = false;
    turn.responseCreateAt = null;
    turn.responseToolCandidate = false;
    holdAudioForCurrentResponse = false;
    setTimeout(() => {
      if (activeTurn !== turn || turn.responseRequested || turn.responseDone) return;
      requestVoiceResponseNow(turn, true, { queueIfActive: true });
    }, 120);
    return true;
  }

  function handleUserTranscriptCompleted(transcript: string): void {
    const text = transcript.trim();
    const turn = activeTurn;
    if (!turn) return;
    turn.transcriptCompletedAt = Date.now();
    if (text && isLikelyNoiseTranscript(text)) {
      cancelNoiseTurn(turn, text);
      return;
    }
    if (text || turn.userText.trim() || turn.partialUserText.trim()) return;
    log("empty transcript; canceling silent/noise voice turn");
    cancelNoiseTurn(turn, "(empty transcript)");
  }

  function isLikelyNoiseTranscript(text: string): boolean {
    return isTranscriptNoise(text, { likelyNeedsTool });
  }

  function cancelNoiseTurn(turn: VoiceTurn, transcript: string): void {
    log(`noise transcript ignored: ${transcript}`);
    if (turn.responseTimer) {
      clearTimeout(turn.responseTimer);
      turn.responseTimer = null;
    }
    if (turn.fallbackTimer) {
      clearTimeout(turn.fallbackTimer);
      turn.fallbackTimer = null;
    }
    if (turn.responseRequested && !turn.sawToolCall) {
      dropCanceledAudioUntil = Date.now() + 1500;
      client.cancelResponse();
      clearHeldAssistantAudio();
      player.flush();
      audioPlaybackActive = false;
      audioResponseStarted = false;
      assistantAudioStartedAt = 0;
      activeAssistantAudioItemId = null;
      estimatedPlaybackUntil = 0;
      suppressMicUntil = 0;
    }
    turn.responseDone = true;
    turn.captured = true;
    clearVoiceTurnTimers(turn);
    if (activeTurn === turn) activeTurn = null;
    clearHeldAssistantAudio();
    if (listening && !modelIsBusy()) hud.set("listening");
    syncState();
  }

  function handleUserTranscriptDelta(delta: string): void {
    const text = delta.trim();
    if (!text) return;
    const turn = ensureVoiceTurn();
    turn.partialUserText = `${turn.partialUserText}${delta}`
      .replace(/\s+/g, " ")
      .trimStart()
      .slice(-1000);
    if (!likelyNeedsTool(turn.partialUserText)) return;
    if (!turn.actionCandidate) {
      log("partial transcript suggests action:", turn.partialUserText);
    }
    turn.actionCandidate = true;
    if (!turn.responseDone) holdAudioForCurrentResponse = true;
    if (cfg.backgroundTranscription && turn.inputCommitted && !turn.responseRequested) {
      requestVoiceResponseNow(turn, false);
    }
  }

  async function handleInjectedText(): Promise<void> {
    const request = readInjectRequest();
    clearInjectRequest();
    if (!request) return;
    const text = request.text.trim();
    lastProbe = {
      id: request.id,
      text,
      at: request.at,
      status: "queued",
    };
    syncState();
    if (!text) {
      markProbe({
        id: request.id,
        status: "rejected",
        message: "Empty injected text.",
      });
      return;
    }
    if (modelIsBusy() && !(await waitForModelIdle())) {
      markProbe({
        id: request.id,
        status: "rejected",
        message: "Daemon is busy with another turn.",
      });
      return;
    }
    markProbe({ id: request.id, status: "running" });
    const ready = await waitForRealtimeReady();
    if (!ready) {
      markProbe({
        id: request.id,
        status: "error",
        message: "Realtime session did not become ready.",
      });
      return;
    }
    if (modelIsBusy() && !(await waitForModelIdle())) {
      markProbe({
        id: request.id,
        status: "rejected",
        message: "Daemon became busy before injected turn could start.",
      });
      return;
    }

    const now = Date.now();
    markProbe({ id: request.id, turnStartMs: now - request.at });
    const turn = beginVoiceTurn(now);
    turn.injectId = request.id;
    turn.userText = text;
    turn.partialUserText = text;
    turn.transcriptAt = now;
    turn.inputCommitted = true;
    turn.actionCandidate = likelyNeedsTool(text);
    markSpeechStopped(turn);
    if (listening) hud.set("thinking");
    log("injected:", text);
    client.addUserText(text);
    requestVoiceResponseNow(turn, likelyNeedsMemoryRecall(text) && !turn.actionCandidate);
  }

  async function requestVoiceResponse(
    turn: VoiceTurn,
    includeMemory = true,
    opts: { queueIfActive?: boolean } = {},
  ): Promise<void> {
    if (turn.responseRequested) return;
    turn.responseRequested = true;
    turn.responseDone = false;
    const intentText = turn.userText || turn.partialUserText;
    const toolCandidate = turn.actionCandidate || likelyNeedsTool(intentText);
    turn.responseToolCandidate = toolCandidate;
    const fastMemory =
      !cfg.aiDriven && !toolCandidate ? fastMemorySpeech(intentText) : undefined;
    if (fastMemory) {
      turn.responseCreateAt = Date.now();
      await playLocalSpeech(turn, fastMemory, "memory_fast");
      return;
    }
    const favoriteSongAction =
      !cfg.aiDriven && toolCandidate
        ? favoriteSongAppAction(intentText, extractFavoriteSong(voiceMemoryPrimer) ?? "")
        : undefined;
    if (favoriteSongAction) {
      await runDeterministicAction(turn, favoriteSongAction);
      return;
    }
    let memoryContext = "";
    if (includeMemory && engramRecallEnabled() && turn.userText.trim()) {
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
    // AI-driven still honors high-confidence tool preferences; it only leaves
    // ambiguous multi-step actions to the model.
    const preferredTool = toolCandidate
      ? preferredToolForAction(intentText)
      : undefined;
    const directAction =
      toolCandidate && !cfg.aiDriven ? deterministicAction(intentText) : undefined;
    if (directAction) {
      await runDeterministicAction(turn, directAction);
      return;
    }
    const needsToolBudget = toolCandidate;
    const toolSelectionInstructions =
      "Silent tool-selection turn: call the appropriate tool only. Do not produce spoken audio or message text before the tool call. After intermediate tool results, continue silently until complete or blocked.";
    const responseInstructions =
      memoryContext || toolCandidate
        ? currentInstructions(
            [memoryContext, toolCandidate ? toolSelectionInstructions : ""]
              .filter(Boolean)
              .join("\n\n"),
          )
        : undefined;
    if (toolCandidate) playToolAck(turn, preferredTool ?? "tool");
    holdAudioForCurrentResponse = false;
    turn.responseCreateAt = Date.now();
    client.createResponse(responseInstructions, {
      maxOutputTokens: needsToolBudget
        ? cfg.maxToolCallTokens
        : cfg.shortReplyTokens,
      toolChoice: preferredTool
        ? { type: "function", name: preferredTool }
        : toolCandidate
          ? "required"
          : "auto",
      outputModalities: toolCandidate ? ["text"] : ["audio"],
      queueIfActive: opts.queueIfActive,
    });
  }

  async function runDeterministicAction(
    turn: VoiceTurn,
    action: DeterministicAction,
  ): Promise<void> {
    turn.sawToolCall = true;
    turn.pendingTools++;
    playToolAck(turn, action.name);
    if (listening) hud.set("thinking", action.name.replace(/_/g, " "));
    const toolStartedAt = Date.now();
    const result = await tools.exec(action.name, action.args);
    const toolMs = Date.now() - toolStartedAt;
    turn.pendingTools = Math.max(0, turn.pendingTools - 1);
    const output = toolOutput(result);
    const images = toolImages(result);
    recordAction({
      tool: action.name,
      direct: true,
      ms: toolMs,
      toolCallCount: turn.toolCallCount,
      output,
    });
    turn.responseDone = false;
    turn.responseCreateAt = Date.now();
    if (images.length > 0) {
      for (const image of images) client.sendImageInput(image.path, image.prompt);
      turn.localTextSpeech = true;
      client.createResponse(
        currentInstructions(
          "A local Mac observation has already run and the image is attached. Answer aloud in one complete sentence of eight words or fewer. End with a period. Do not read file paths.",
        ),
        {
          queueIfActive: true,
          maxOutputTokens: cfg.maxOutputTokens,
          toolChoice: "none",
          outputModalities: ["audio"],
        },
      );
      return;
    }
    const speech = finalToolSpeech(action.name, output);
    if (await playLocalSpeech(turn, speech, action.name)) return;
    client.createResponse(
      currentInstructions(
        [
          `A local Mac action already ran via ${action.name}.`,
          `Tool output:\n${output.slice(0, 1200)}`,
          finalToolInstructions(action.name, output),
        ].join("\n\n"),
      ),
      {
        queueIfActive: true,
        maxOutputTokens: cfg.maxOutputTokens,
        toolChoice: "none",
        outputModalities: ["audio"],
      },
    );
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

  function maybeAutoIdleAfterTurn(reason: string): void {
    if (!cfg.autoIdleAfterTurn || !listening) return;
    if (modelIsBusy()) {
      autoIdlePending = true;
      return;
    }
    if (!autoIdlePending && reason === "audio idle") return;
    autoIdlePending = false;
    if (autoIdleTimer) clearTimeout(autoIdleTimer);
    autoIdleTimer = setTimeout(() => {
      autoIdleTimer = null;
      if (!cfg.autoIdleAfterTurn || !listening || modelIsBusy()) {
        autoIdlePending = true;
        return;
      }
      log(`auto idle after turn (${reason})`);
      stopListening();
    }, 350);
  }

  function captureVoiceTurn(turn: VoiceTurn): void {
    if (turn.captured) return;
    if (turn.injectId) {
      if (!turn.responseDone || turn.pendingTools > 0 || responseInFlight) {
        scheduleVoiceCapture(turn, 500);
        return;
      }
      turn.captured = true;
      clearVoiceTurnTimers(turn);
      if (activeTurn === turn) activeTurn = null;
      return;
    }
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
        user: "the user",
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

  function requestLiveInstructionUpdate(): void {
    if (instructionUpdateTimer) return;
    instructionUpdateTimer = setTimeout(() => {
      instructionUpdateTimer = null;
      const inputTurnPending =
        localSpeechOpen ||
        Boolean(activeTurn && !activeTurn.inputCommitted && !activeTurn.responseDone);
      if (inputTurnPending || modelIsBusy()) {
        requestLiveInstructionUpdate();
        return;
      }
      updateLiveInstructions();
    }, 350);
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
      requestLiveInstructionUpdate();
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
      requestLiveInstructionUpdate();
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
      if (!result.recognized && cfg.speakerProactiveIdentify) {
        queueUnknownSpeakerPrompt(result.match);
      }
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

  function rememberMicChunk(
    b64: string,
    level: number,
    durationMs: number,
  ): void {
    micRing.push({ b64, level, durationMs });
    micRingMs += durationMs;
    while (micRingMs > cfg.interruptBufferMs && micRing.length > 1) {
      const old = micRing.shift()!;
      micRingMs -= old.durationMs;
    }
  }

  function resetLocalSpeechGate(): void {
    localSpeechOpen = false;
    localSpeechHighFrames = 0;
    localSpeechSilenceMs = 0;
    localSpeechOpenedAt = 0;
    localSpeechSentToServer = false;
  }

  function localSpeechThreshold(): number {
    const dynamic =
      localNoiseFloor > 0 ? localNoiseFloor * cfg.localVadNoiseRatio : 0;
    return Math.max(cfg.localVadMinLevel, dynamic);
  }

  function localSpeechCloseThreshold(openThreshold: number): number {
    const ratio = Math.max(0.55, Math.min(1.2, cfg.localVadEndRatio));
    const floorBased =
      localNoiseFloor > 0 ? localNoiseFloor * Math.max(1.2, cfg.localVadNoiseRatio * 0.5) : 0;
    return Math.max(cfg.localVadMinLevel * 0.9, floorBased, openThreshold * ratio);
  }

  function updateLocalNoiseFloor(level: number, threshold: number): void {
    if (!cfg.localVadEnabled || localSpeechOpen || modelIsBusy()) return;
    if (level <= 0) return;
    if (level >= threshold * 0.7) return;
    localNoiseFloor =
      localNoiseFloor === 0 ? level : localNoiseFloor * 0.985 + level * 0.015;
  }

  function sendMicChunkToServer(
    b64: string,
    level: number,
    durationMs: number,
  ): void {
    if (localSpeechOpen) localSpeechSentToServer = true;
    captureSpeakerChunk(b64, level, durationMs);
    client.appendAudio(b64, durationMs);
  }

  function flushMicRingToServer(): void {
    for (const chunk of micRing) {
      sendMicChunkToServer(chunk.b64, chunk.level, chunk.durationMs);
    }
    micRing.length = 0;
    micRingMs = 0;
  }

  function shouldForwardMicChunk(level: number, durationMs: number): boolean {
    if (!cfg.localVadEnabled) return true;
    const threshold = localSpeechThreshold();
    if (localSpeechOpen) {
      const closeThreshold = localSpeechCloseThreshold(threshold);
      const openMs = localSpeechOpenedAt
        ? Date.now() - localSpeechOpenedAt
        : 0;
      if (level >= closeThreshold) localSpeechSilenceMs = 0;
      else localSpeechSilenceMs += durationMs;

      const maxOpenReached =
        cfg.localVadMaxOpenMs > 0 && openMs > cfg.localVadMaxOpenMs;
      if (localSpeechSilenceMs > cfg.localVadEndMs || maxOpenReached) {
        const turn = activeTurn;
        const tooShort =
          cfg.localVadMinOpenMs > 0 &&
          openMs < cfg.localVadMinOpenMs &&
          !maxOpenReached;
        const shouldCommit =
          localSpeechSentToServer && !turn?.inputCommitted && !tooShort;
        const closedSilenceMs = localSpeechSilenceMs;
        if (turn && !tooShort) markSpeechStopped(turn);
        resetLocalSpeechGate();
        log(
          `local vad closed: silence=${closedSilenceMs}ms close=${closeThreshold.toFixed(3)} floor=${localNoiseFloor.toFixed(3)} open=${openMs}ms max=${maxOpenReached} short=${tooShort} commit=${shouldCommit}`,
        );
        if (tooShort) {
          client.clearAudio();
          if (turn) {
            clearVoiceTurnTimers(turn);
            turn.captured = true;
            turn.responseDone = true;
            if (activeTurn === turn) activeTurn = null;
          }
          if (listening && !modelIsBusy()) hud.set("listening");
          return false;
        }
        if (shouldCommit) {
          if (client.commitAudio()) {
            if (turn) {
              turn.inputCommitted = true;
              if (cfg.backgroundTranscription) scheduleVoiceResponse(turn, false);
            }
          } else {
            if (turn && activeTurn === turn && !turn.responseRequested)
              activeTurn = null;
            if (listening && !modelIsBusy()) hud.set("listening");
          }
        }
        return false;
      }
      return true;
    }

    if (level >= threshold) localSpeechHighFrames++;
    else {
      localSpeechHighFrames = 0;
      updateLocalNoiseFloor(level, threshold);
    }

    if (localSpeechHighFrames < cfg.localVadStartFrames) return false;

    localSpeechOpen = true;
    localSpeechOpenedAt = Date.now();
    localSpeechHighFrames = 0;
    localSpeechSilenceMs = 0;
    if (activeTurn && activeTurn.speechStoppedAt == null) {
      activeTurn.speechStartedAt ??= Date.now();
    } else {
      beginVoiceTurn(Date.now());
    }
    if (listening) hud.set("hearing");
    log(
      `local vad opened: level=${level.toFixed(3)} threshold=${threshold.toFixed(3)} close=${localSpeechCloseThreshold(threshold).toFixed(3)} floor=${localNoiseFloor.toFixed(3)}`,
    );
    flushMicRingToServer();
    return false;
  }

  function assistantIsAudible(now: number): boolean {
    return (
      audioPlaybackActive ||
      audioResponseStarted &&
      (estimatedPlaybackUntil > now || player.playedMs() > 0)
    );
  }

  function modelIsBusy(): boolean {
    return (
      responseInFlight ||
      audioResponseStarted ||
      audioPlaybackActive ||
      Boolean(activeTurn && activeTurn.responseRequested && !activeTurn.responseDone) ||
      Boolean(activeTurn && activeTurn.pendingTools > 0)
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
    audioPlaybackActive = false;
    player.flush();
    for (const chunk of micRing)
      client.appendAudio(chunk.b64, chunk.durationMs);
    micRing.length = 0;
    micRingMs = 0;
    if (listening) hud.set("hearing", "interrupted");
    return true;
  }

  let voiceLevel = 0;
  let peakLevel = 0;
  let lastPeakLevel = 0;
  let micLastSignalAt = 0;
  let micObservedAt = 0;
  let micChunkCount = 0;
  const mic = new MicCapture(
    cfg.micIndex,
    cfg.sampleRate,
    (b64, lvl, durationMs) => {
      if (!listening) return;
      rememberMicChunk(b64, lvl, durationMs);
      const now = Date.now();
      if (now < suppressMicUntil) {
        resetLocalSpeechGate();
        if (tryInterrupt(lvl)) return;
        if (now < acceptedInterruptUntil) client.appendAudio(b64);
        return;
      }
      if (modelIsBusy()) {
        resetLocalSpeechGate();
        if (tryInterrupt(lvl)) return;
        if (now < acceptedInterruptUntil) client.appendAudio(b64);
        return;
      }
      interruptHighFrames = 0;
      if (!shouldForwardMicChunk(lvl, durationMs)) return;
      sendMicChunkToServer(b64, lvl, durationMs);
    },
    (lvl) => {
      micObservedAt = Date.now();
      micChunkCount++;
      if (lvl >= 0.01) micLastSignalAt = micObservedAt;
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
      localVadEnabled: cfg.localVadEnabled,
      localVadMinLevel: cfg.localVadMinLevel,
      audioPlayer: cfg.audioPlayer,
      maxOutputTokens: cfg.maxOutputTokens,
      shortReplyTokens: cfg.shortReplyTokens,
      maxToolCallTokens: cfg.maxToolCallTokens,
      toolAudioHoldMs: cfg.toolAudioHoldMs,
      playbackGain: cfg.playbackGain,
      toolLocalAckEnabled: cfg.toolLocalAckEnabled,
      toolLocalAckText: cfg.toolLocalAckText,
      toolLocalAckModel: cfg.toolLocalAckModel,
      toolProgressAckEnabled: cfg.toolProgressAckEnabled,
      toolProgressAckText: cfg.toolProgressAckText,
      toolProgressAckAfterMs: cfg.toolProgressAckAfterMs,
      actionClassifyWaitMs: cfg.actionClassifyWaitMs,
      toolLoopMaxCalls: cfg.toolLoopMaxCalls,
      toolLoopMaxMs: cfg.toolLoopMaxMs,
      runShellFastWaitMs: cfg.runShellFastWaitMs,
      webFetchTimeoutMs: cfg.webFetchTimeoutMs,
      browserScreenshotTimeoutMs: cfg.browserScreenshotTimeoutMs,
      dispatchLaunchTimeoutMs: cfg.dispatchLaunchTimeoutMs,
      autoIdleAfterTurn: cfg.autoIdleAfterTurn,
      cameraEnabled: cfg.cameraEnabled,
      cameraIndex: cfg.cameraIndex,
      cameraWarmupMs: cfg.cameraWarmupMs,
      cameraAutoRecognize: cfg.cameraAutoRecognize,
      cameraAutoIntervalMs: cfg.cameraAutoIntervalMs,
      speakerRecognitionEnabled: cfg.speakerRecognitionEnabled,
      speakerProactiveIdentify: cfg.speakerProactiveIdentify,
      interruptMinLevel: cfg.interruptMinLevel,
      interruptFrames: cfg.interruptFrames,
      micPeakLevel: lastPeakLevel,
      micLastSignalAt: micLastSignalAt || undefined,
      micObservedAt: micObservedAt || undefined,
      micChunkCount,
      lastLatency,
      lastAction,
      lastProbe,
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
    realtimeFatalError = "";
    resetLocalSpeechGate();
    micRing.length = 0;
    micRingMs = 0;
    micLastSignalAt = 0;
    micObservedAt = 0;
    micChunkCount = 0;
    if (!client.connected) client.connect();
    suppressMicUntil = Math.max(suppressMicUntil, Date.now() + 300);
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
        `mic peak level (post-gain, 0..1): ${lastPeakLevel.toFixed(3)} ${lastPeakLevel < 0.01 ? "← quiet/no local signal" : ""}`,
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
    resetLocalSpeechGate();
    micRing.length = 0;
    micRingMs = 0;
    ignoredServerSpeechActive = false;
    resetResponseActivity(true);
    if (instructionUpdateTimer) {
      clearTimeout(instructionUpdateTimer);
      instructionUpdateTimer = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
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
    resetResponseActivity(true);
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
    `up (pid ${process.pid}, model ${cfg.model}, vad ${cfg.vad}@${cfg.vadThreshold}, local_vad=${cfg.localVadEnabled ? `${cfg.localVadMinLevel}/${cfg.localVadNoiseRatio}x/${cfg.localVadStartFrames}f` : "off"}, voice ${cfg.voice})`,
  );

  process.on("SIGUSR2", () => toggle());
  process.on("SIGUSR1", () => {
    void handleInjectedText();
  });
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
  await new Promise<void>(() => {
    /* shutdown exits the process explicitly */
  });
}
