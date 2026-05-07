// Voice-route config. Read entirely from env (Bun auto-loads .env), so the
// voice daemon shares the same OPENAI_API_KEY / SLACK_BOT_TOKEN / REPOS the
// Slack bot already uses — no new secrets, no separate config file.

export interface VoiceRepo {
  name: string;
  path: string;
}

export type VoiceNoiseReduction = "near_field" | "far_field" | "off";

export interface VoiceConfig {
  openaiApiKey: string;
  /** Realtime model. "gpt-realtime-2" is what the user calls "Realtime Voice 2". */
  model: string;
  /** TTS voice. GA voices: cedar, marin, alloy, echo, shimmer, … */
  voice: string;
  /** ffmpeg avfoundation audio device index (`ffmpeg -f avfoundation -list_devices true -i ""`). */
  micIndex: string;
  /** PCM sample rate for both directions. The Realtime API works natively at 24k. */
  sampleRate: number;
  /** server_vad = fast/literal endpointing; semantic_vad = model decides you're done. */
  vad: "server_vad" | "semantic_vad";
  /** Server VAD speech threshold (0..1). Mac mic input is quiet, so keep this low. */
  vadThreshold: number;
  /** Server VAD trailing silence before ending the turn. */
  vadSilenceMs: number;
  /** Mic gain multiplier — the built-in MacBook mic is quiet; x4 helps VAD trigger. */
  micGain: number;
  /** OpenAI input noise reduction before VAD/model. */
  inputNoiseReduction: VoiceNoiseReduction;
  /** Input audio transcription model for voice memory/latency traces. */
  transcriptionModel: string;
  /** Optional language hint for faster/more accurate input transcription. */
  transcriptionLanguage?: string;
  /** Optional prompt hint for domain words/names in input transcription. */
  transcriptionPrompt?: string;
  /** Let Realtime answer immediately while transcription finishes in the background. */
  backgroundTranscription: boolean;
  /** Local RMS gate before audio reaches server VAD; prevents room noise/self-talk loops. */
  localVadEnabled: boolean;
  /** Minimum local mic RMS level before opening the server audio stream. */
  localVadMinLevel: number;
  /** Also require speech to clear the learned room floor by this multiplier. */
  localVadNoiseRatio: number;
  /** Consecutive local chunks above threshold before opening speech. */
  localVadStartFrames: number;
  /** Keep sending quiet tail this long so server VAD can close the turn cleanly. */
  localVadEndMs: number;
  /** Drop local VAD segments shorter than this; noisy rooms often make sub-second false turns. */
  localVadMinOpenMs: number;
  /** End speech once the local RMS level falls below this fraction of the open threshold. */
  localVadEndRatio: number;
  /** Hard cap for one local speech segment; prevents noisy rooms from holding a turn open forever. */
  localVadMaxOpenMs: number;
  /** Master camera/vision feature switch. */
  cameraEnabled: boolean;
  /** ffmpeg avfoundation video device index. */
  cameraIndex: string;
  /** Camera capture width. */
  cameraWidth: number;
  /** Camera capture height. */
  cameraHeight: number;
  /** Milliseconds to let the camera auto-expose before saving a frame. */
  cameraWarmupMs: number;
  /** Refresh a low-duty background visual identity cache while listening. */
  cameraAutoRecognize: boolean;
  /** Milliseconds between background camera identity checks. */
  cameraAutoIntervalMs: number;
  /** Minimum confidence for using a background camera identity as likely. */
  cameraAutoMinConfidence: number;
  /** Local speaker recognition over mic samples already captured for voice. */
  speakerRecognitionEnabled: boolean;
  /** Minimum voice sample length before trying speaker recognition. */
  speakerMinSampleMs: number;
  /** Maximum mic audio retained per turn for speaker recognition. */
  speakerMaxSampleMs: number;
  /** Minimum confidence for using a speaker identity as likely. */
  speakerMinConfidence: number;
  /** Proactively ask unknown speakers to identify themselves. */
  speakerProactiveIdentify: boolean;
  /** Cooldown before proactively asking about an unknown speaker again. */
  speakerNoveltyCooldownMs: number;
  /** Drop mic frames briefly after speaker audio so Friday does not hear herself. */
  echoSuppressionMs: number;
  /** Local, noise-gated interruption toggle. Server auto-interrupt stays off. */
  interruptionEnabled: boolean;
  /** Local mic RMS level that must be sustained before interrupting. */
  interruptMinLevel: number;
  /** Consecutive local mic chunks above the threshold before interrupting. */
  interruptFrames: number;
  /** Recent mic audio to send when an interruption is accepted. */
  interruptBufferMs: number;
  /** Minimum gap between accepted interruptions. */
  interruptCooldownMs: number;
  /** Do not allow interruption this soon after assistant audio starts. */
  interruptMinAssistantMs: number;
  /** Maximum accepted interruptions during one assistant response. */
  interruptMaxPerResponse: number;
  /** Buffer this much output audio before starting playback to smooth network jitter. */
  playbackPrebufferMs: number;
  /** Scale output PCM before playback; useful when speaker bleed/noisy rooms clip responses. */
  playbackGain: number;
  /** Realtime max output tokens per response; caps spoken answer length. */
  maxOutputTokens: number | "inf";
  /** Tighter cap for ordinary non-tool voice replies. */
  shortReplyTokens: number | "inf";
  /** Larger first-pass cap so tool-call arguments are not clipped. */
  maxToolCallTokens: number | "inf";
  /** Hold initial audio briefly so pre-tool filler can be dropped if a tool call follows. */
  toolAudioHoldMs: number;
  /** Play a cached local voice acknowledgement immediately while tool selection runs silently. */
  toolLocalAckEnabled: boolean;
  /** Short acknowledgement phrase synthesized once and cached as PCM. */
  toolLocalAckText: string;
  /** OpenAI speech model used for cached local acknowledgement PCM. */
  toolLocalAckModel: string;
  /** Speak one cached progress cue if a multi-step tool loop keeps running. */
  toolProgressAckEnabled: boolean;
  /** Short progress phrase synthesized once and cached as PCM. */
  toolProgressAckText: string;
  /** Tool-loop elapsed milliseconds before the one-time progress cue is allowed. */
  toolProgressAckAfterMs: number;
  /** Let the model decide every action and narrate every result. Off = legacy regex/canned shortcuts. */
  aiDriven: boolean;
  /** Tiny wait after local endpointing for transcript deltas before choosing response budget. */
  actionClassifyWaitMs: number;
  /** Maximum tool calls a single voice turn may chain before reporting progress/blockage. */
  toolLoopMaxCalls: number;
  /** Maximum elapsed milliseconds a voice tool chain may run before reporting progress/blockage. */
  toolLoopMaxMs: number;
  /** Foreground shell grace before slow commands are kept in the background. */
  runShellFastWaitMs: number;
  /** Fetch timeout for voice web search/page text tools. */
  webFetchTimeoutMs: number;
  /** Timeout for Playwright URL screenshots in the voice path. */
  browserScreenshotTimeoutMs: number;
  /** Timeout for launching Terminal/Codex engineering dispatch. */
  dispatchLaunchTimeoutMs: number;
  /** Audio player backend for spoken responses. */
  audioPlayer: "auto" | "native" | "ffplay";
  /** Drop the WS when toggled off so an idle daemon costs nothing. */
  wsIdleOff: boolean;
  /** After one user turn completes, automatically return to idle/listening off. */
  autoIdleAfterTurn: boolean;
  /** Show the on-screen holographic HUD overlay. */
  hudEnabled: boolean;
  /** Localhost port the HUD page + SSE feed are served on. */
  hudPort: number;
  // Slack wiring for dispatch_to_claude (optional — tool disables itself if unset).
  slackBotToken?: string;
  slackVoiceChannel?: string;
  slackUserId?: string;
  /** Anthropic API key for Claude vision click-grounding (find_and_click). Optional. */
  anthropicApiKey?: string;
  /** Claude model used to ground click coordinates from a screenshot. */
  visionGroundingModel: string;
  /** Repos Friday can dispatch into, reused from the bot's REPOS env. */
  repos: VoiceRepo[];
  /** State/pid/log dir. */
  stateDir: string;
}

function bool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v == null || v === "") return def;
  return v === "1" || v.toLowerCase() === "true";
}

function noiseReduction(
  name: string,
  def: VoiceNoiseReduction,
): VoiceNoiseReduction {
  const v = process.env[name];
  return v === "near_field" || v === "far_field" || v === "off" ? v : def;
}

function outputTokenCap(name: string, def: number): number | "inf" {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  if (raw.toLowerCase() === "inf") return "inf";
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.max(1, Math.min(4096, Math.round(n)));
}

export function loadVoiceConfig(): VoiceConfig {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is required for the voice route (set it in .env).",
    );
  }

  let repos: VoiceRepo[] = [];
  try {
    const raw = JSON.parse(process.env.REPOS ?? "[]") as Array<{
      name: string;
      path: string;
    }>;
    repos = raw.map((r) => ({ name: r.name, path: r.path }));
  } catch {
    repos = [];
  }

  return {
    openaiApiKey: apiKey,
    model: process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2",
    voice: process.env.FRIDAY_VOICE ?? "shimmer",
    micIndex: process.env.FRIDAY_VOICE_MIC_INDEX ?? "0",
    sampleRate: 24000,
    vad: (process.env.FRIDAY_VOICE_VAD as VoiceConfig["vad"]) ?? "server_vad",
    vadThreshold: Number(process.env.FRIDAY_VOICE_VAD_THRESHOLD ?? "0.12"),
    vadSilenceMs: Number(process.env.FRIDAY_VOICE_VAD_SILENCE_MS ?? "450"),
    micGain: Number(process.env.FRIDAY_VOICE_MIC_GAIN ?? "4"),
    inputNoiseReduction: noiseReduction(
      "FRIDAY_VOICE_NOISE_REDUCTION",
      "far_field",
    ),
    transcriptionModel:
      process.env.FRIDAY_VOICE_TRANSCRIPTION_MODEL ??
      "gpt-4o-mini-transcribe",
    transcriptionLanguage: process.env.FRIDAY_VOICE_TRANSCRIPTION_LANGUAGE ?? "en",
    transcriptionPrompt: process.env.FRIDAY_VOICE_TRANSCRIPTION_PROMPT,
    backgroundTranscription: bool("FRIDAY_VOICE_BACKGROUND_TRANSCRIPTION", true),
    localVadEnabled: bool("FRIDAY_VOICE_LOCAL_VAD", true),
    localVadMinLevel: Number(process.env.FRIDAY_VOICE_LOCAL_VAD_MIN_LEVEL ?? "0.055"),
    localVadNoiseRatio: Number(
      process.env.FRIDAY_VOICE_LOCAL_VAD_NOISE_RATIO ?? "2.6",
    ),
    localVadStartFrames: Number(
      process.env.FRIDAY_VOICE_LOCAL_VAD_START_FRAMES ?? "8",
    ),
    localVadEndMs: Number(
      process.env.FRIDAY_VOICE_LOCAL_VAD_END_MS ??
        String(Number(process.env.FRIDAY_VOICE_VAD_SILENCE_MS ?? "450") + 100),
    ),
    localVadMinOpenMs: Number(
      process.env.FRIDAY_VOICE_LOCAL_VAD_MIN_OPEN_MS ?? "500",
    ),
    localVadEndRatio: Number(
      process.env.FRIDAY_VOICE_LOCAL_VAD_END_RATIO ?? "0.9",
    ),
    localVadMaxOpenMs: Number(
      process.env.FRIDAY_VOICE_LOCAL_VAD_MAX_OPEN_MS ?? "10000",
    ),
    cameraEnabled: bool("FRIDAY_VOICE_CAMERA", false),
    cameraIndex: process.env.FRIDAY_VOICE_CAMERA_INDEX ?? "0",
    cameraWidth: Number(process.env.FRIDAY_VOICE_CAMERA_WIDTH ?? "1280"),
    cameraHeight: Number(process.env.FRIDAY_VOICE_CAMERA_HEIGHT ?? "720"),
    cameraWarmupMs: Number(process.env.FRIDAY_VOICE_CAMERA_WARMUP_MS ?? "1500"),
    cameraAutoRecognize: bool(
      "FRIDAY_VOICE_CAMERA_AUTO_RECOGNIZE",
      false,
    ),
    cameraAutoIntervalMs: Number(
      process.env.FRIDAY_VOICE_CAMERA_AUTO_INTERVAL_MS ?? "8000",
    ),
    cameraAutoMinConfidence: Number(
      process.env.FRIDAY_VOICE_CAMERA_AUTO_MIN_CONFIDENCE ?? "0.78",
    ),
    speakerRecognitionEnabled: bool(
      "FRIDAY_VOICE_SPEAKER_RECOGNITION",
      false,
    ),
    speakerMinSampleMs: Number(
      process.env.FRIDAY_VOICE_SPEAKER_MIN_SAMPLE_MS ?? "900",
    ),
    speakerMaxSampleMs: Number(
      process.env.FRIDAY_VOICE_SPEAKER_MAX_SAMPLE_MS ?? "5000",
    ),
    speakerMinConfidence: Number(
      process.env.FRIDAY_VOICE_SPEAKER_MIN_CONFIDENCE ?? "0.72",
    ),
    speakerProactiveIdentify: bool(
      "FRIDAY_VOICE_SPEAKER_PROACTIVE_IDENTIFY",
      false,
    ),
    speakerNoveltyCooldownMs: Number(
      process.env.FRIDAY_VOICE_SPEAKER_NOVELTY_COOLDOWN_MS ?? "60000",
    ),
    echoSuppressionMs: Number(
      process.env.FRIDAY_VOICE_ECHO_SUPPRESSION_MS ?? "2500",
    ),
    interruptionEnabled: bool("FRIDAY_VOICE_INTERRUPTION", false),
    interruptMinLevel: Number(
      process.env.FRIDAY_VOICE_INTERRUPT_MIN_LEVEL ?? "0.75",
    ),
    interruptFrames: Number(process.env.FRIDAY_VOICE_INTERRUPT_FRAMES ?? "40"),
    interruptBufferMs: Number(
      process.env.FRIDAY_VOICE_INTERRUPT_BUFFER_MS ?? "650",
    ),
    interruptCooldownMs: Number(
      process.env.FRIDAY_VOICE_INTERRUPT_COOLDOWN_MS ?? "8000",
    ),
    interruptMinAssistantMs: Number(
      process.env.FRIDAY_VOICE_INTERRUPT_MIN_ASSISTANT_MS ?? "1500",
    ),
    interruptMaxPerResponse: Number(
      process.env.FRIDAY_VOICE_INTERRUPT_MAX_PER_RESPONSE ?? "1",
    ),
    playbackPrebufferMs: Number(
      process.env.FRIDAY_VOICE_PLAYBACK_PREBUFFER_MS ?? "120",
    ),
    playbackGain: Number(process.env.FRIDAY_VOICE_PLAYBACK_GAIN ?? "1"),
    maxOutputTokens: outputTokenCap("FRIDAY_VOICE_MAX_OUTPUT_TOKENS", 192),
    shortReplyTokens: outputTokenCap("FRIDAY_VOICE_SHORT_REPLY_TOKENS", 96),
    maxToolCallTokens: outputTokenCap(
      "FRIDAY_VOICE_MAX_TOOL_CALL_TOKENS",
      512,
    ),
    toolAudioHoldMs: Number(process.env.FRIDAY_VOICE_TOOL_AUDIO_HOLD_MS ?? "1200"),
    toolLocalAckEnabled: bool("FRIDAY_VOICE_TOOL_LOCAL_ACK", true),
    toolLocalAckText: process.env.FRIDAY_VOICE_TOOL_LOCAL_ACK_TEXT ?? "On it.",
    toolLocalAckModel:
      process.env.FRIDAY_VOICE_TOOL_LOCAL_ACK_MODEL ?? "tts-1",
    toolProgressAckEnabled: bool("FRIDAY_VOICE_TOOL_PROGRESS_ACK", true),
    toolProgressAckText:
      process.env.FRIDAY_VOICE_TOOL_PROGRESS_ACK_TEXT ??
      "Still working through it.",
    toolProgressAckAfterMs: Number(
      process.env.FRIDAY_VOICE_TOOL_PROGRESS_ACK_AFTER_MS ?? "4500",
    ),
    aiDriven: bool("FRIDAY_VOICE_AI_DRIVEN", true),
    actionClassifyWaitMs: Number(
      process.env.FRIDAY_VOICE_ACTION_CLASSIFY_WAIT_MS ?? "250",
    ),
    toolLoopMaxCalls: Number(
      process.env.FRIDAY_VOICE_TOOL_LOOP_MAX_CALLS ?? "5",
    ),
    toolLoopMaxMs: Number(
      process.env.FRIDAY_VOICE_TOOL_LOOP_MAX_MS ?? "20000",
    ),
    runShellFastWaitMs: Number(
      process.env.FRIDAY_VOICE_RUN_SHELL_FAST_WAIT_MS ?? "400",
    ),
    webFetchTimeoutMs: Number(
      process.env.FRIDAY_VOICE_WEB_FETCH_TIMEOUT_MS ?? "3500",
    ),
    browserScreenshotTimeoutMs: Number(
      process.env.FRIDAY_VOICE_BROWSER_SCREENSHOT_TIMEOUT_MS ?? "6500",
    ),
    dispatchLaunchTimeoutMs: Number(
      process.env.FRIDAY_VOICE_DISPATCH_LAUNCH_TIMEOUT_MS ?? "3000",
    ),
    audioPlayer:
      process.env.FRIDAY_VOICE_PLAYER === "native" ||
      process.env.FRIDAY_VOICE_PLAYER === "ffplay"
        ? process.env.FRIDAY_VOICE_PLAYER
        : "auto",
    wsIdleOff: bool("FRIDAY_VOICE_WS_IDLE_OFF", true),
    autoIdleAfterTurn: bool("FRIDAY_VOICE_AUTO_IDLE_AFTER_TURN", false),
    hudEnabled: bool("FRIDAY_VOICE_HUD", true),
    hudPort: Number(process.env.FRIDAY_VOICE_HUD_PORT ?? "3030"),
    // Deliberately NOT ANTHROPIC_API_KEY: that name makes the Claude CLI bill
    // the metered API instead of the Max subscription, and the spawner/dispatch
    // paths inherit the whole env. Keep voice-vision's key under its own name.
    anthropicApiKey:
      process.env.FRIDAY_VISION_ANTHROPIC_KEY ?? process.env.ANTHROPIC_API_KEY,
    visionGroundingModel:
      process.env.FRIDAY_VOICE_VISION_MODEL ?? "claude-sonnet-4-6",
    slackBotToken: process.env.SLACK_BOT_TOKEN,
    slackVoiceChannel: process.env.SLACK_VOICE_CHANNEL,
    slackUserId: process.env.SLACK_USER_ID,
    repos,
    stateDir: "/tmp/friday-voice",
  };
}
