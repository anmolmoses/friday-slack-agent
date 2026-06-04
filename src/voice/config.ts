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
  /** Realtime model. "gpt-realtime-2" is what Anmol calls "Realtime Voice 2". */
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
  /** Drop the WS when toggled off so an idle daemon costs nothing. */
  wsIdleOff: boolean;
  /** Show the on-screen holographic HUD overlay. */
  hudEnabled: boolean;
  /** Localhost port the HUD page + SSE feed are served on. */
  hudPort: number;
  // Slack wiring for dispatch_to_claude (optional — tool disables itself if unset).
  slackBotToken?: string;
  slackVoiceChannel?: string;
  slackUserId?: string;
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
    vadThreshold: Number(process.env.FRIDAY_VOICE_VAD_THRESHOLD ?? "0.05"),
    vadSilenceMs: Number(process.env.FRIDAY_VOICE_VAD_SILENCE_MS ?? "700"),
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
    speakerNoveltyCooldownMs: Number(
      process.env.FRIDAY_VOICE_SPEAKER_NOVELTY_COOLDOWN_MS ?? "60000",
    ),
    echoSuppressionMs: Number(
      process.env.FRIDAY_VOICE_ECHO_SUPPRESSION_MS ?? "1200",
    ),
    interruptionEnabled: bool("FRIDAY_VOICE_INTERRUPTION", false),
    interruptMinLevel: Number(
      process.env.FRIDAY_VOICE_INTERRUPT_MIN_LEVEL ?? "0.35",
    ),
    interruptFrames: Number(process.env.FRIDAY_VOICE_INTERRUPT_FRAMES ?? "8"),
    interruptBufferMs: Number(
      process.env.FRIDAY_VOICE_INTERRUPT_BUFFER_MS ?? "650",
    ),
    interruptCooldownMs: Number(
      process.env.FRIDAY_VOICE_INTERRUPT_COOLDOWN_MS ?? "2500",
    ),
    interruptMinAssistantMs: Number(
      process.env.FRIDAY_VOICE_INTERRUPT_MIN_ASSISTANT_MS ?? "1500",
    ),
    interruptMaxPerResponse: Number(
      process.env.FRIDAY_VOICE_INTERRUPT_MAX_PER_RESPONSE ?? "1",
    ),
    playbackPrebufferMs: Number(
      process.env.FRIDAY_VOICE_PLAYBACK_PREBUFFER_MS ?? "350",
    ),
    wsIdleOff: bool("FRIDAY_VOICE_WS_IDLE_OFF", true),
    hudEnabled: bool("FRIDAY_VOICE_HUD", true),
    hudPort: Number(process.env.FRIDAY_VOICE_HUD_PORT ?? "3030"),
    slackBotToken: process.env.SLACK_BOT_TOKEN,
    slackVoiceChannel: process.env.SLACK_VOICE_CHANNEL,
    slackUserId: process.env.SLACK_USER_ID,
    repos,
    stateDir: "/tmp/friday-voice",
  };
}
