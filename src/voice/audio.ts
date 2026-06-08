// Local audio I/O via ffmpeg/ffplay (both already on this Mac; no sox).
//   capture: avfoundation mic → raw s16le PCM mono @ 24k → onChunk(base64)
//   playback: feed s16le PCM @ 24k to ffplay's stdin (low-delay flags)

import type { Subprocess } from "bun";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, statSync } from "node:fs";

const log = (...a: unknown[]) => console.log("[voice:audio]", ...a);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLAYER_SRC = path.join(__dirname, "audio-player.swift");
const PLAYER_BIN = "/tmp/friday-voice/friday-audio-player";

function ensureNativePlayer(): string | null {
  try {
    const fresh =
      existsSync(PLAYER_BIN) &&
      statSync(PLAYER_BIN).mtimeMs >= statSync(PLAYER_SRC).mtimeMs;
    if (fresh) return PLAYER_BIN;
    log("compiling audio-player.swift...");
    const result = Bun.spawnSync(
      ["swiftc", "-O", PLAYER_SRC, "-o", PLAYER_BIN],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (result.exitCode !== 0) {
      log(
        "swiftc audio-player failed:",
        result.stderr.toString().slice(0, 600),
      );
      return null;
    }
    return PLAYER_BIN;
  } catch (err) {
    log(
      "native player unavailable:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** Amplify a little-endian s16 PCM buffer in place by `gain` (clamped). */
export function amplify16(buf: Uint8Array, gain: number): void {
  if (gain === 1) return;
  const n = Math.floor(buf.byteLength / 2);
  const dv = new DataView(buf.buffer, buf.byteOffset, n * 2);
  for (let i = 0; i < n; i++) {
    let s = dv.getInt16(i * 2, true) * gain;
    if (s > 32767) s = 32767;
    else if (s < -32768) s = -32768;
    dv.setInt16(i * 2, s, true);
  }
}

/** RMS amplitude (0..1) of a little-endian signed-16 PCM buffer. */
export function rms16(buf: Uint8Array): number {
  const n = Math.floor(buf.byteLength / 2);
  if (n === 0) return 0;
  const dv = new DataView(buf.buffer, buf.byteOffset, n * 2);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = dv.getInt16(i * 2, true) / 32768;
    sum += s * s;
  }
  return Math.min(1, Math.sqrt(sum / n) * 2.2); // *2.2 = gentle gain so speech reads well
}

export class MicCapture {
  private proc: Subprocess<"ignore", "pipe", "pipe"> | null = null;
  private micIndex: string;
  private rate: number;
  private onChunk: (base64: string, level: number, durationMs: number) => void;
  private onLevel?: (level: number) => void;
  private gain: number;
  private stopped = false;

  constructor(
    micIndex: string,
    rate: number,
    onChunk: (base64: string, level: number, durationMs: number) => void,
    onLevel?: (level: number) => void,
    gain = 1,
  ) {
    this.micIndex = micIndex;
    this.rate = rate;
    this.onChunk = onChunk;
    this.onLevel = onLevel;
    this.gain = gain;
  }

  start(): void {
    if (this.proc) return;
    this.stopped = false;
    // ":<idx>" = no video, audio device <idx>. Raw signed-16 LE mono PCM to stdout.
    this.proc = Bun.spawn(
      [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "avfoundation",
        "-i",
        `:${this.micIndex}`,
        "-ac",
        "1",
        "-ar",
        String(this.rate),
        "-f",
        "s16le",
        "-",
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    void this.pump();
    void this.drainStderr();
  }

  private async pump(): Promise<void> {
    if (!this.proc) return;
    const reader = this.proc.stdout.getReader();
    let chunks = 0,
      bytes = 0;
    const tick = setInterval(() => {
      if (this.stopped) {
        clearInterval(tick);
        return;
      }
      log(`mic: ${chunks} chunks, ${(bytes / 1024).toFixed(0)} KB captured`);
    }, 2000);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || this.stopped) break;
        if (value && value.byteLength) {
          chunks++;
          bytes += value.byteLength;
          amplify16(value, this.gain); // boost the quiet built-in mic so VAD triggers
          const level = rms16(value);
          const durationMs = Math.ceil(
            (value.byteLength / (this.rate * 2)) * 1000,
          );
          this.onLevel?.(level);
          this.onChunk(
            Buffer.from(value).toString("base64"),
            level,
            durationMs,
          );
        }
      }
    } catch {
      // reader cancelled on stop()
    } finally {
      clearInterval(tick);
      if (chunks === 0 && !this.stopped) {
        log(
          "mic: NO audio captured — likely Microphone permission denied for this process",
        );
      }
    }
  }

  private async drainStderr(): Promise<void> {
    if (!this.proc) return;
    try {
      const err = await new Response(this.proc.stderr).text();
      const t = err.trim();
      if (t && !this.stopped) log("ffmpeg:", t.slice(0, 400));
    } catch {
      /* ignore */
    }
  }

  stop(): void {
    this.stopped = true;
    try {
      this.proc?.kill();
    } catch {
      /* ignore */
    }
    this.proc = null;
  }
}

export class Player {
  private proc: Subprocess<"pipe", "ignore", "pipe"> | null = null;
  private rate: number;
  private prebufferMs: number;
  private prebufferBytes: number;
  private backend: "auto" | "native" | "ffplay";
  private gain: number;
  private queue: Buffer[] = [];
  private queuedBytes = 0;
  private started = false;
  private prebufferTimer: ReturnType<typeof setTimeout> | null = null;
  private finishTimer: ReturnType<typeof setTimeout> | null = null;
  private playbackStartedAt = 0;
  private writtenMs = 0;
  private writtenBytes = 0;
  private writtenChunks = 0;
  private activeBackend = "";
  private closing = false;
  private onIdle?: () => void;

  constructor(
    rate: number,
    prebufferMs = 350,
    backend: "auto" | "native" | "ffplay" = "auto",
    gain = 1,
    onIdle?: () => void,
  ) {
    this.rate = rate;
    this.prebufferMs = prebufferMs;
    this.backend = backend;
    this.gain = Number.isFinite(gain) ? Math.max(0.05, Math.min(2, gain)) : 1;
    this.onIdle = onIdle;
    this.prebufferBytes = Math.max(
      1,
      Math.round((rate * 2 * prebufferMs) / 1000),
    );
  }

  private spawn(): void {
    const nativePlayer =
      this.backend === "ffplay" ? null : ensureNativePlayer();
    if (this.backend === "native" && !nativePlayer)
      log("native player requested but unavailable; falling back to ffplay");
    const args = nativePlayer
      ? [nativePlayer, String(this.rate)]
      : [
          "ffplay",
          "-hide_banner",
          "-loglevel",
          "error",
          "-nodisp",
          "-autoexit",
          "-f",
          "s16le",
          "-ar",
          String(this.rate),
          "-ch_layout",
          "mono",
          "-i",
          "-",
        ];
    this.activeBackend = nativePlayer ? "native" : "ffplay";
    log(`player spawn: ${this.activeBackend} rate=${this.rate}`);
    this.closing = false;
    this.proc = Bun.spawn(args, {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
    });
    const proc = this.proc;
    const backend = this.activeBackend;
    void this.drainStderr(proc);
    void proc.exited
      .then((code) => {
        log(`player exit: ${backend || "unknown"} code=${code}`);
        if (this.proc === proc) {
          this.proc = null;
          this.started = false;
          this.closing = false;
          this.playbackStartedAt = 0;
          this.writtenMs = 0;
          this.writtenBytes = 0;
          this.writtenChunks = 0;
          this.activeBackend = "";
          this.onIdle?.();
        }
      })
      .catch(() => {});
  }

  private async drainStderr(
    proc: Subprocess<"pipe", "ignore", "pipe">,
  ): Promise<void> {
    try {
      const err = await new Response(proc.stderr).text();
      const t = err.trim();
      if (t) log(`${this.activeBackend || "player"}:`, t.slice(0, 400));
    } catch {
      /* ignore */
    }
  }

  private writeNow(pcm: Buffer): void {
    if (this.closing) {
      try {
        this.proc?.kill();
      } catch {
        /* ignore */
      }
      this.proc = null;
      this.started = false;
      this.closing = false;
      this.playbackStartedAt = 0;
      this.writtenMs = 0;
      this.writtenBytes = 0;
      this.writtenChunks = 0;
    }
    if (!this.proc) this.spawn();
    if (!this.playbackStartedAt) this.playbackStartedAt = Date.now();
    this.writtenMs += Math.ceil((pcm.byteLength / (this.rate * 2)) * 1000);
    this.writtenBytes += pcm.byteLength;
    this.writtenChunks++;
    const output = this.gain === 1 ? pcm : Buffer.from(pcm);
    if (this.gain !== 1) amplify16(output, this.gain);
    try {
      this.proc!.stdin.write(output);
      this.proc!.stdin.flush();
    } catch {
      log("player write failed; respawning");
      this.spawn();
      try {
        this.proc!.stdin.write(output);
        this.proc!.stdin.flush();
      } catch {
        /* drop */
      }
    }
  }

  private startQueued(): void {
    if (this.started || this.queue.length === 0) return;
    if (this.prebufferTimer) {
      clearTimeout(this.prebufferTimer);
      this.prebufferTimer = null;
    }
    this.started = true;
    const chunks = this.queue;
    this.queue = [];
    this.queuedBytes = 0;
    for (const chunk of chunks) this.writeNow(chunk);
  }

  /** Append a PCM chunk to the speaker. Buffers a short pre-roll for smooth speech. */
  write(pcm: Buffer): void {
    if (this.finishTimer) {
      clearTimeout(this.finishTimer);
      this.finishTimer = null;
    }
    if (this.started) {
      this.writeNow(pcm);
      return;
    }
    this.queue.push(pcm);
    this.queuedBytes += pcm.byteLength;
    if (this.queuedBytes >= this.prebufferBytes) {
      this.startQueued();
    } else if (!this.prebufferTimer) {
      this.prebufferTimer = setTimeout(
        () => this.startQueued(),
        this.prebufferMs,
      );
    }
  }

  /** Reset playback accounting at the beginning of a new assistant audio item. */
  beginResponse(): void {
    this.playbackStartedAt = 0;
    this.writtenMs = 0;
    this.writtenBytes = 0;
    this.writtenChunks = 0;
  }

  /** Approximate how much assistant audio actually reached the speakers. */
  playedMs(): number {
    if (!this.playbackStartedAt) return 0;
    return Math.max(
      0,
      Math.min(this.writtenMs, Date.now() - this.playbackStartedAt),
    );
  }

  /** Let queued audio drain, then close ffplay so the next response gets fresh pre-roll. */
  finishSoon(delayMs = 2500): void {
    if (this.finishTimer) clearTimeout(this.finishTimer);
    this.finishTimer = setTimeout(() => {
      this.startQueued();
      const hadProc = Boolean(this.proc);
      try {
        log(
          `player finish: backend=${this.activeBackend || "unknown"} chunks=${this.writtenChunks} bytes=${this.writtenBytes} ms=${this.writtenMs}`,
        );
        this.proc?.stdin.end();
      } catch {
        /* ignore */
      }
      this.closing = hadProc;
      if (!hadProc) {
        this.started = false;
        this.playbackStartedAt = 0;
        this.writtenMs = 0;
        this.writtenBytes = 0;
        this.writtenChunks = 0;
        this.onIdle?.();
      }
      this.finishTimer = null;
    }, delayMs);
  }

  /** Stop playback immediately and drop any queued audio. */
  flush(): void {
    if (this.prebufferTimer) {
      clearTimeout(this.prebufferTimer);
      this.prebufferTimer = null;
    }
    if (this.finishTimer) {
      clearTimeout(this.finishTimer);
      this.finishTimer = null;
    }
    this.queue = [];
    this.queuedBytes = 0;
    this.started = false;
    this.closing = false;
    this.playbackStartedAt = 0;
    this.writtenMs = 0;
    this.writtenBytes = 0;
    this.writtenChunks = 0;
    try {
      this.proc?.stdin.end();
    } catch {
      /* ignore */
    }
    try {
      this.proc?.kill();
    } catch {
      /* ignore */
    }
    this.proc = null;
  }
}

/** Fire a system-sound cue (on/off toggle feedback). Non-fatal, fire-and-forget. */
export function cue(kind: "on" | "off"): void {
  const sound =
    kind === "on"
      ? "/System/Library/Sounds/Tink.aiff"
      : "/System/Library/Sounds/Bottle.aiff";
  try {
    Bun.spawn(["afplay", sound], {
      stdout: "ignore",
      stderr: "ignore",
    }).unref();
  } catch {
    /* ignore */
  }
}
