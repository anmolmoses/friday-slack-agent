// OpenAI Realtime API client (speech-to-speech over WebSocket).
//
// Targets the GA schema (model gpt-realtime-2): no OpenAI-Beta header; audio
// config is nested under session.audio.{input,output} with format objects
// {type:"audio/pcm", rate}. All event-type strings live in EVT so a docs drift
// is a one-line fix. Receive side is tolerant (accepts both GA
// `response.output_audio.delta` and legacy `response.audio.delta`).

import { readFileSync } from "node:fs";
import path from "node:path";
import type { VoiceConfig } from "./config.ts";
import type { RealtimeTool } from "./tools.ts";

const log = (...a: unknown[]) => console.log("[voice:rt]", ...a);

type OutputTokenCap = number | "inf" | null;
const PRE_READY_AUDIO_BUFFER_MS = 4000;
type RealtimeOutputModality = "audio" | "text";

export type RealtimeToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; name: string }
  | { type: "mcp"; server_label: string; name?: string };

export interface ResponseOptions {
  instructions?: string;
  queueIfActive?: boolean;
  maxOutputTokens?: OutputTokenCap;
  toolChoice?: RealtimeToolChoice;
  outputModalities?: RealtimeOutputModality[];
}

function imageMime(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

// Centralized event-type strings — adjust here if the API schema shifts.
const EVT = {
  // client → server
  sessionUpdate: "session.update",
  audioAppend: "input_audio_buffer.append",
  audioCommit: "input_audio_buffer.commit",
    itemCreate: "conversation.item.create",
    itemTruncate: "conversation.item.truncate",
    audioClear: "input_audio_buffer.clear",
    responseCreate: "response.create",
    responseCancel: "response.cancel",
  // server → client (audio out — accept both GA + legacy)
  audioDelta: ["response.output_audio.delta", "response.audio.delta"],
  audioTranscriptDone: [
    "response.output_audio_transcript.done",
    "response.audio_transcript.done",
  ],
  textDelta: ["response.output_text.delta", "response.text.delta"],
  textDone: ["response.output_text.done", "response.text.done"],
  outputItemAdded: "response.output_item.added",
  responseCreated: "response.created",
  speechStarted: "input_audio_buffer.speech_started",
  speechStopped: "input_audio_buffer.speech_stopped",
  audioCommitted: "input_audio_buffer.committed",
  fnArgsDone: "response.function_call_arguments.done",
  transcriptDelta: "conversation.item.input_audio_transcription.delta",
  transcriptDone: "conversation.item.input_audio_transcription.completed",
  responseDone: "response.done",
  error: "error",
} as const;

export interface RealtimeCallbacks {
  onAudioDelta: (
    pcm: Buffer,
    meta: { itemId?: string; contentIndex: number; responseId?: string },
  ) => void;
  onSpeechStarted: () => void;
  onSpeechStopped?: () => void;
  onInputCommitted?: () => void;
  onResponseDone?: (meta: {
    audioChunks: number;
    expectedAudio: boolean;
  }) => void;
  onResponseCreated?: () => void;
  onFunctionCall: (call: {
    callId: string;
    name: string;
    args: Record<string, unknown>;
  }) => void;
  onFunctionCallStarted?: (call: {
    itemId?: string;
    name?: string;
    responseId?: string;
  }) => void;
  onUserTranscript?: (text: string) => void;
  onUserTranscriptDelta?: (delta: string) => void;
  onUserTranscriptCompleted?: (text: string) => void;
  onAssistantTranscript?: (text: string) => void;
  onAssistantText?: (text: string) => void;
  onError?: (error: unknown) => void;
  onOpen?: () => void;
  onClose?: () => void;
}

export class RealtimeClient {
  private cfg: VoiceConfig;
  private instructions: string;
  private tools: RealtimeTool[];
  private cb: RealtimeCallbacks;
  private ws: WebSocket | null = null;
  private audioDeltas = 0;
  private textDeltas = "";
  private sent = 0;
  private currentAssistantItemId: string | null = null;
  private responseActive = false;
  private sessionReady = false;
  private queuedResponse:
    | {
        instructions?: string;
        maxOutputTokens: OutputTokenCap;
        toolChoice?: RealtimeToolChoice;
        outputModalities?: RealtimeOutputModality[];
      }
    | undefined = undefined;
  private droppedAudioBeforeReady = 0;
  private pendingInputAudioMs = 0;
  private preReadyAudio: Array<{ audio: string; durationMs: number }> = [];
  private preReadyAudioMs = 0;
  private preReadyCommit = false;
  private activeResponseExpectedAudio = false;
  private activeResponseHadFunctionCall = false;
  private activeResponseAssistantItemId: string | null = null;
  private suppressedAssistantItemIds = new Set<string>();

  constructor(
    cfg: VoiceConfig,
    instructions: string,
    tools: RealtimeTool[],
    cb: RealtimeCallbacks,
  ) {
    this.cfg = cfg;
    this.instructions = instructions;
    this.tools = tools;
    this.cb = cb;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get ready(): boolean {
    return this.connected && this.sessionReady;
  }

  connect(): void {
    if (this.ws) return;
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.cfg.model)}`;
    // Bun supports custom headers on the WebSocket constructor.
    this.ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.cfg.openaiApiKey}` },
    } as unknown as string[]);

    this.ws.addEventListener("open", () => {
      log(`connected (${this.cfg.model})`);
      this.sendSessionUpdate();
      this.cb.onOpen?.();
    });
    this.ws.addEventListener("message", (e) => this.onMessage(e));
    this.ws.addEventListener("error", (e) =>
      log("ws error:", (e as ErrorEvent).message ?? e),
    );
    this.ws.addEventListener("close", (e) => {
      log(`closed (${(e as CloseEvent).code})`);
      this.ws = null;
      this.sessionReady = false;
      this.preReadyAudio = [];
      this.preReadyAudioMs = 0;
      this.preReadyCommit = false;
      this.cb.onClose?.();
    });
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.responseActive = false;
    this.sessionReady = false;
    this.queuedResponse = undefined;
    this.activeResponseExpectedAudio = false;
    this.activeResponseHadFunctionCall = false;
    this.activeResponseAssistantItemId = null;
    this.suppressedAssistantItemIds.clear();
    this.preReadyAudio = [];
    this.preReadyAudioMs = 0;
    this.preReadyCommit = false;
  }

  private send(obj: unknown): void {
    if (this.connected) this.ws!.send(JSON.stringify(obj));
  }

  private sendSessionUpdate(): void {
    const fmt = { type: "audio/pcm", rate: this.cfg.sampleRate };
    const inputNoiseReduction =
      this.cfg.inputNoiseReduction === "off"
        ? null
        : { type: this.cfg.inputNoiseReduction };
    const inputTranscription =
      this.cfg.transcriptionModel === "off"
        ? null
        : {
            model: this.cfg.transcriptionModel,
            ...(this.cfg.transcriptionLanguage
              ? { language: this.cfg.transcriptionLanguage }
              : {}),
            ...(this.cfg.transcriptionPrompt
              ? { prompt: this.cfg.transcriptionPrompt }
              : {}),
          };
    this.send({
      type: EVT.sessionUpdate,
      session: {
        type: "realtime",
        instructions: this.instructions,
        output_modalities: ["audio"],
        audio: {
          input: {
            format: fmt,
            noise_reduction: inputNoiseReduction,
            transcription: inputTranscription,
            // When the local RMS gate is enabled, the daemon owns endpointing and
            // commits the audio buffer manually. Keeping server VAD active here can
            // race with session.update and produce empty-buffer commits.
            turn_detection: this.cfg.localVadEnabled
              ? null
              : {
                  type: this.cfg.vad,
                  threshold: this.cfg.vadThreshold,
                  prefix_padding_ms: 300,
                  silence_duration_ms: this.cfg.vadSilenceMs,
                  create_response: false,
                  interrupt_response: false,
                },
          },
          output: { format: fmt, voice: this.cfg.voice },
        },
        tools: this.tools,
        tool_choice: "auto",
      },
    });
  }

  /** Update live session instructions without reconnecting the Realtime socket. */
  updateInstructions(instructions: string): void {
    this.instructions = instructions;
    if (this.connected) this.sendSessionUpdate();
  }

  /** Stream a base64 PCM chunk from the mic. */
  appendAudio(base64: string, durationMs?: number): void {
    const estimatedMs = durationMs ?? this.estimatePcmDurationMs(base64);
    if (!this.sessionReady) {
      this.queuePreReadyAudio(base64, estimatedMs);
      return;
    }
    this.send({ type: EVT.audioAppend, audio: base64 });
    this.pendingInputAudioMs += estimatedMs;
    this.sent++;
    if (this.sent % 100 === 0)
      log(
        `sent ${this.sent} audio chunks to server (connected=${this.connected})`,
      );
  }

  /** Manually close the current input audio turn after local endpointing. */
  commitAudio(): boolean {
    if (!this.ready) {
      if (this.preReadyAudioMs < 120) return false;
      this.preReadyCommit = true;
      log(
        `queued input commit until configured session.updated is accepted (${Math.round(this.preReadyAudioMs)}ms buffered)`,
      );
      return true;
    }
    if (this.pendingInputAudioMs < 120) {
      log(
        `skipping input commit: only ${Math.round(this.pendingInputAudioMs)}ms buffered`,
      );
      this.clearAudio();
      return false;
    }
    this.send({ type: EVT.audioCommit });
    this.pendingInputAudioMs = 0;
    return true;
  }

  clearAudio(): void {
    this.preReadyAudio = [];
    this.preReadyAudioMs = 0;
    this.preReadyCommit = false;
    if (!this.ready) return;
    this.send({ type: EVT.audioClear });
    this.pendingInputAudioMs = 0;
  }

  private queuePreReadyAudio(audio: string, durationMs: number): void {
    this.preReadyAudio.push({ audio, durationMs });
    this.preReadyAudioMs += durationMs;
    this.droppedAudioBeforeReady++;
    let droppedMs = 0;
    while (
      this.preReadyAudioMs > PRE_READY_AUDIO_BUFFER_MS &&
      this.preReadyAudio.length > 1
    ) {
      const dropped = this.preReadyAudio.shift()!;
      this.preReadyAudioMs -= dropped.durationMs;
      droppedMs += dropped.durationMs;
    }
    if (this.droppedAudioBeforeReady % 50 === 1) {
      log(
        `buffering mic audio until configured session.updated is accepted (${Math.round(this.preReadyAudioMs)}ms buffered${droppedMs > 0 ? `, dropped oldest ${Math.round(droppedMs)}ms` : ""})`,
      );
    }
  }

  private flushPreReadyAudio(): void {
    if (this.preReadyAudio.length === 0) return;
    const queued = this.preReadyAudio;
    const queuedMs = this.preReadyAudioMs;
    const commit = this.preReadyCommit;
    this.preReadyAudio = [];
    this.preReadyAudioMs = 0;
    this.preReadyCommit = false;
    log(
      `flushing ${queued.length} buffered mic chunks after session.updated (${Math.round(queuedMs)}ms${commit ? ", commit queued" : ""})`,
    );
    for (const chunk of queued) {
      this.send({ type: EVT.audioAppend, audio: chunk.audio });
      this.pendingInputAudioMs += chunk.durationMs;
      this.sent++;
    }
    if (commit && this.pendingInputAudioMs >= 120) {
      this.send({ type: EVT.audioCommit });
      this.pendingInputAudioMs = 0;
    }
  }

  /** Return a tool result, then ask the model to continue (speak the outcome). */
  sendFunctionResult(
    callId: string,
    output: string,
    createResponse = true,
    responseOpts: ResponseOptions = {},
  ): void {
    this.send({
      type: EVT.itemCreate,
      item: { type: "function_call_output", call_id: callId, output },
    });
    if (createResponse)
      this.createResponse(responseOpts.instructions, {
        queueIfActive: true,
        maxOutputTokens:
          responseOpts.maxOutputTokens === undefined
            ? this.cfg.maxOutputTokens
            : responseOpts.maxOutputTokens,
        toolChoice: responseOpts.toolChoice,
        outputModalities: responseOpts.outputModalities,
      });
  }

  /** Attach a local image file as a user input item in the Realtime conversation. */
  sendImageInput(file: string, prompt?: string): void {
    const b64 = readFileSync(file).toString("base64");
    const content: Array<Record<string, string>> = [];
    if (prompt?.trim()) {
      content.push({ type: "input_text", text: prompt.trim() });
    }
    content.push({
      type: "input_image",
      image_url: `data:${imageMime(file)};base64,${b64}`,
    });
    this.send({
      type: EVT.itemCreate,
      item: { type: "message", role: "user", content },
    });
  }

  /** Ask the model to respond, optionally with per-turn memory context. */
  createResponse(
    instructions?: string,
    opts: ResponseOptions = {},
  ): void {
    const maxOutputTokens =
      opts.maxOutputTokens === undefined
        ? this.cfg.maxOutputTokens
        : opts.maxOutputTokens;
    if (!this.connected) return;
    if (!this.sessionReady) {
      this.queuedResponse = {
        instructions,
        maxOutputTokens,
        toolChoice: opts.toolChoice,
        outputModalities: opts.outputModalities,
      };
      log("queued response.create until configured session.updated is accepted");
      return;
    }
    if (this.responseActive) {
      if (!opts.queueIfActive) {
        log("ignored duplicate response.create while another response is active");
        return;
      }
      this.queuedResponse = {
        instructions,
        maxOutputTokens,
        toolChoice: opts.toolChoice,
        outputModalities: opts.outputModalities,
      };
      log("queued response.create while another response is active");
      return;
    }
    this.responseActive = true;
    this.activeResponseExpectedAudio = this.responseExpectsAudio(opts);
    this.activeResponseHadFunctionCall = false;
    log(
      `sending response.create (instructions=${instructions ? `${instructions.length} chars` : "session"}, max=${maxOutputTokens ?? "uncapped"}, modalities=${JSON.stringify(opts.outputModalities ?? ["audio"])}, toolChoice=${opts.toolChoice ? JSON.stringify(opts.toolChoice) : "session"}, queueIfActive=${Boolean(opts.queueIfActive)})`,
    );
    const response = {
      output_modalities: opts.outputModalities ?? ["audio"],
      ...(maxOutputTokens == null ? {} : { max_output_tokens: maxOutputTokens }),
      ...(instructions ? { instructions } : {}),
      ...(opts.toolChoice ? { tool_choice: opts.toolChoice } : {}),
    };
    this.send({
      type: EVT.responseCreate,
      response,
    });
  }

  private responseExpectsAudio(opts: ResponseOptions): boolean {
    const modalities = opts.outputModalities ?? ["audio"];
    return modalities.includes("audio");
  }

  private flushQueuedResponse(): void {
    if (!this.queuedResponse || this.responseActive) return;
    const queued = this.queuedResponse;
    this.queuedResponse = undefined;
    this.createResponse(queued.instructions, {
      maxOutputTokens: queued.maxOutputTokens,
      toolChoice: queued.toolChoice,
      outputModalities: queued.outputModalities,
    });
  }

  /** Add a text user item to the conversation without starting a response. */
  addUserText(text: string): void {
    this.send({
      type: EVT.itemCreate,
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
  }

  /** One-shot text prompt, useful for testing output audio without the mic. */
  sendText(
    text: string,
    opts: ResponseOptions = {},
  ): void {
    this.addUserText(text);
    this.createResponse(opts.instructions, opts);
  }

  /** Stop the in-flight spoken response. */
  cancelResponse(): void {
    this.send({ type: EVT.responseCancel });
  }

  /** Synchronize server conversation state with what the user actually heard. */
  truncateResponseAudio(
    itemId: string,
    audioEndMs: number,
    contentIndex = 0,
  ): void {
    this.send({
      type: EVT.itemTruncate,
      item_id: itemId,
      content_index: contentIndex,
      audio_end_ms: Math.max(0, Math.floor(audioEndMs)),
    });
  }

  private estimatePcmDurationMs(base64: string): number {
    const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
    const bytes = Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
    return Math.ceil((bytes / (this.cfg.sampleRate * 2)) * 1000);
  }

  private onMessage(e: MessageEvent): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof e.data === "string" ? e.data : String(e.data));
    } catch {
      return;
    }
    const type = msg.type as string;

    if ((EVT.audioDelta as readonly string[]).includes(type)) {
      const b64 = (msg.delta ?? msg.audio) as string | undefined;
      const itemId =
        typeof msg.item_id === "string"
          ? msg.item_id
          : (this.currentAssistantItemId ?? undefined);
      const contentIndex =
        typeof msg.content_index === "number" ? msg.content_index : 0;
      if (
        (itemId && this.suppressedAssistantItemIds.has(itemId)) ||
        (!itemId &&
          this.currentAssistantItemId &&
          this.suppressedAssistantItemIds.has(this.currentAssistantItemId))
      ) {
        return;
      }
      if (b64) {
        this.audioDeltas++;
        this.cb.onAudioDelta(Buffer.from(b64, "base64"), {
          itemId,
          contentIndex,
          responseId:
            typeof msg.response_id === "string" ? msg.response_id : undefined,
        });
      }
      return;
    }

    if ((EVT.audioTranscriptDone as readonly string[]).includes(type)) {
      const itemId =
        typeof msg.item_id === "string"
          ? msg.item_id
          : this.currentAssistantItemId;
      if (itemId && this.suppressedAssistantItemIds.has(itemId)) return;
      if (msg.transcript)
        this.cb.onAssistantTranscript?.(String(msg.transcript));
      return;
    }

    if ((EVT.textDelta as readonly string[]).includes(type)) {
      if (typeof msg.delta === "string") this.textDeltas += msg.delta;
      return;
    }

    if ((EVT.textDone as readonly string[]).includes(type)) {
      const text =
        (typeof msg.text === "string" && msg.text) ||
        (typeof msg.delta === "string" && msg.delta) ||
        this.textDeltas;
      this.textDeltas = "";
      if (text.trim()) this.cb.onAssistantText?.(text);
      return;
    }

    // Log every non-audio event so we can see the conversation flow.
    log("evt:", type);
    if (type === "session.updated" || type === "session.created") {
      const td = (msg.session as any)?.audio?.input?.turn_detection;
      log("  accepted turn_detection:", JSON.stringify(td));
    }

    switch (type) {
      case EVT.outputItemAdded: {
        const item = msg.item as
          | { id?: unknown; type?: unknown; role?: unknown; name?: unknown }
          | undefined;
        if (item?.role === "assistant" && typeof item.id === "string") {
          if (!this.activeResponseAssistantItemId) {
            this.activeResponseAssistantItemId = item.id;
          } else if (item.id !== this.activeResponseAssistantItemId) {
            this.suppressedAssistantItemIds.add(item.id);
            log(`suppressing extra assistant audio item ${item.id}`);
          }
          this.currentAssistantItemId = item.id;
        }
        if (item?.type === "function_call") {
          this.activeResponseHadFunctionCall = true;
          this.cb.onFunctionCallStarted?.({
            itemId: typeof item.id === "string" ? item.id : undefined,
            name: typeof item.name === "string" ? item.name : undefined,
            responseId:
              typeof msg.response_id === "string" ? msg.response_id : undefined,
          });
        }
        break;
      }
      case EVT.responseCreated:
        this.responseActive = true;
        this.activeResponseAssistantItemId = null;
        this.suppressedAssistantItemIds.clear();
        this.textDeltas = "";
        this.cb.onResponseCreated?.();
        break;
      case "session.updated":
        this.sessionReady = true;
        this.droppedAudioBeforeReady = 0;
        this.flushPreReadyAudio();
        this.flushQueuedResponse();
        break;
      case EVT.speechStarted:
        this.cb.onSpeechStarted();
        break;
      case EVT.speechStopped:
        this.cb.onSpeechStopped?.();
        break;
      case EVT.audioCommitted:
        this.pendingInputAudioMs = 0;
        this.cb.onInputCommitted?.();
        break;
      case EVT.responseDone:
        const audioChunks = this.audioDeltas;
        const expectedAudio =
          this.activeResponseExpectedAudio && !this.activeResponseHadFunctionCall;
        log(`response done (${audioChunks} audio chunks sent to speaker)`);
        this.audioDeltas = 0;
        this.textDeltas = "";
        this.activeResponseExpectedAudio = false;
        this.activeResponseHadFunctionCall = false;
        this.activeResponseAssistantItemId = null;
        this.suppressedAssistantItemIds.clear();
        this.currentAssistantItemId = null;
        this.responseActive = false;
        this.cb.onResponseDone?.({ audioChunks, expectedAudio });
        this.flushQueuedResponse();
        break;
      case EVT.fnArgsDone: {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse((msg.arguments as string) || "{}");
        } catch {
          /* keep {} */
        }
        this.cb.onFunctionCall({
          callId: msg.call_id as string,
          name: msg.name as string,
          args,
        });
        break;
      }
      case EVT.transcriptDelta:
        if (msg.delta) this.cb.onUserTranscriptDelta?.(String(msg.delta));
        break;
      case EVT.transcriptDone:
        if (msg.transcript) this.cb.onUserTranscript?.(String(msg.transcript));
        this.cb.onUserTranscriptCompleted?.(String(msg.transcript ?? ""));
        break;
      case EVT.error:
        log("server error:", JSON.stringify(msg.error ?? msg));
        this.pendingInputAudioMs = 0;
        this.cb.onError?.(msg.error ?? msg);
        break;
      default:
        // ignore the many lifecycle events we don't act on
        break;
    }
  }
}
