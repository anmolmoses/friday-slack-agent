// OpenAI Realtime API client (speech-to-speech over WebSocket).
//
// Targets the GA schema (model gpt-realtime-2): no OpenAI-Beta header; audio
// config is nested under session.audio.{input,output} with format objects
// {type:"audio/pcm", rate}. All event-type strings live in EVT so a docs drift
// is a one-line fix. Receive side is tolerant (accepts both GA
// `response.output_audio.delta` and legacy `response.audio.delta`).

import type { VoiceConfig } from "./config.ts";
import type { RealtimeTool } from "./tools.ts";

const log = (...a: unknown[]) => console.log("[voice:rt]", ...a);

// Centralized event-type strings — adjust here if the API schema shifts.
const EVT = {
  // client → server
  sessionUpdate: "session.update",
  audioAppend: "input_audio_buffer.append",
  itemCreate: "conversation.item.create",
  responseCreate: "response.create",
  responseCancel: "response.cancel",
  // server → client (audio out — accept both GA + legacy)
  audioDelta: ["response.output_audio.delta", "response.audio.delta"],
  speechStarted: "input_audio_buffer.speech_started",
  speechStopped: "input_audio_buffer.speech_stopped",
  fnArgsDone: "response.function_call_arguments.done",
  transcriptDone: "conversation.item.input_audio_transcription.completed",
  responseDone: "response.done",
  error: "error",
} as const;

export interface RealtimeCallbacks {
  onAudioDelta: (pcm: Buffer) => void;
  onSpeechStarted: () => void;
  onSpeechStopped?: () => void;
  onResponseDone?: () => void;
  onFunctionCall: (call: { callId: string; name: string; args: Record<string, unknown> }) => void;
  onUserTranscript?: (text: string) => void;
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
  private sent = 0;

  constructor(cfg: VoiceConfig, instructions: string, tools: RealtimeTool[], cb: RealtimeCallbacks) {
    this.cfg = cfg;
    this.instructions = instructions;
    this.tools = tools;
    this.cb = cb;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
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
    this.ws.addEventListener("error", (e) => log("ws error:", (e as ErrorEvent).message ?? e));
    this.ws.addEventListener("close", (e) => {
      log(`closed (${(e as CloseEvent).code})`);
      this.ws = null;
      this.cb.onClose?.();
    });
  }

  close(): void {
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
  }

  private send(obj: unknown): void {
    if (this.connected) this.ws!.send(JSON.stringify(obj));
  }

  private sendSessionUpdate(): void {
    const fmt = { type: "audio/pcm", rate: this.cfg.sampleRate };
    this.send({
      type: EVT.sessionUpdate,
      session: {
        type: "realtime",
        instructions: this.instructions,
        output_modalities: ["audio"],
        audio: {
          input: {
            format: fmt,
            // Lower threshold (built-in mic is quiet even with gain); 700ms trailing
            // silence ends the turn; create_response makes the model auto-reply.
            turn_detection: {
              type: this.cfg.vad,
              threshold: this.cfg.vadThreshold,
              prefix_padding_ms: 300,
              silence_duration_ms: this.cfg.vadSilenceMs,
              create_response: true,
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

  /** Stream a base64 PCM chunk from the mic. With server VAD, no manual commit. */
  appendAudio(base64: string): void {
    if (!this.connected) { return; }
    this.send({ type: EVT.audioAppend, audio: base64 });
    this.sent++;
    if (this.sent % 100 === 0) log(`sent ${this.sent} audio chunks to server (connected=${this.connected})`);
  }

  /** Return a tool result, then ask the model to continue (speak the outcome). */
  sendFunctionResult(callId: string, output: string): void {
    this.send({
      type: EVT.itemCreate,
      item: { type: "function_call_output", call_id: callId, output },
    });
    this.send({ type: EVT.responseCreate });
  }

  /** One-shot text prompt, useful for testing output audio without the mic. */
  sendText(text: string): void {
    this.send({
      type: EVT.itemCreate,
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    this.send({
      type: EVT.responseCreate,
      response: { output_modalities: ["audio"] },
    });
  }

  /** Barge-in: stop the in-flight spoken response. */
  cancelResponse(): void {
    this.send({ type: EVT.responseCancel });
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
      if (b64) { this.audioDeltas++; this.cb.onAudioDelta(Buffer.from(b64, "base64")); }
      return;
    }

    // Log every non-audio event so we can see the conversation flow.
    log("evt:", type);
    if (type === "session.updated" || type === "session.created") {
      const td = (msg.session as any)?.audio?.input?.turn_detection;
      log("  accepted turn_detection:", JSON.stringify(td));
    }

    switch (type) {
      case EVT.speechStarted:
        this.cb.onSpeechStarted();
        break;
      case EVT.speechStopped:
        this.cb.onSpeechStopped?.();
        break;
      case EVT.responseDone:
        log(`response done (${this.audioDeltas} audio chunks sent to speaker)`);
        this.audioDeltas = 0;
        this.cb.onResponseDone?.();
        break;
      case EVT.fnArgsDone: {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse((msg.arguments as string) || "{}"); } catch { /* keep {} */ }
        this.cb.onFunctionCall({
          callId: msg.call_id as string,
          name: msg.name as string,
          args,
        });
        break;
      }
      case EVT.transcriptDone:
        if (msg.transcript) this.cb.onUserTranscript?.(String(msg.transcript));
        break;
      case EVT.error:
        log("server error:", JSON.stringify(msg.error ?? msg));
        break;
      default:
        // ignore the many lifecycle events we don't act on
        break;
    }
  }
}
