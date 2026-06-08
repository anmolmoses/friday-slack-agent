// Daemon pid + state files under /tmp/friday-voice. The CLI (`toggle`/`stop`/
// `status`) talks to a running daemon purely through these files + signals —
// no socket, no port. Keeps the toggle path dead simple for the HUD hotkey.

import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";

export interface DaemonState {
  pid: number;
  listening: boolean;
  wsConnected: boolean;
  model: string;
  voice?: string;
  interruptionEnabled?: boolean;
  noiseReduction?: string;
  transcriptionModel?: string;
  backgroundTranscription?: boolean;
  localVadEnabled?: boolean;
  localVadMinLevel?: number;
  audioPlayer?: string;
  maxOutputTokens?: number | "inf";
  shortReplyTokens?: number | "inf";
  maxToolCallTokens?: number | "inf";
  toolAudioHoldMs?: number;
  playbackGain?: number;
  toolLocalAckEnabled?: boolean;
  toolLocalAckText?: string;
  toolLocalAckModel?: string;
  toolProgressAckEnabled?: boolean;
  toolProgressAckText?: string;
  toolProgressAckAfterMs?: number;
  actionClassifyWaitMs?: number;
  toolLoopMaxCalls?: number;
  toolLoopMaxMs?: number;
  runShellFastWaitMs?: number;
  webFetchTimeoutMs?: number;
  browserScreenshotTimeoutMs?: number;
  dispatchLaunchTimeoutMs?: number;
  autoIdleAfterTurn?: boolean;
  cameraEnabled?: boolean;
  cameraIndex?: string;
  cameraWarmupMs?: number;
  cameraAutoRecognize?: boolean;
  cameraAutoIntervalMs?: number;
  speakerRecognitionEnabled?: boolean;
  speakerProactiveIdentify?: boolean;
  interruptMinLevel?: number;
  interruptFrames?: number;
  micPeakLevel?: number;
  micLastSignalAt?: number;
  micObservedAt?: number;
  micChunkCount?: number;
  lastLatency?: VoiceLatencyState;
  lastAction?: VoiceActionState;
  lastProbe?: VoiceProbeState;
  lastVision?: VoiceVisionState;
  lastSpeaker?: VoiceSpeakerState;
  startedAt: number;
  updatedAt: number;
}

export interface VoiceLatencyState {
  at: number;
  speechMs?: number;
  stopToTranscriptMs?: number;
  memoryRecallMs?: number;
  transcriptToResponseCreateMs?: number;
  responseCreateToFirstAudioMs?: number;
  stopToFirstAudioMs?: number;
  stopToDoneMs?: number;
  firstAudioToDoneMs?: number;
}

export interface VoiceActionState {
  at: number;
  tool: string;
  direct?: boolean;
  ms?: number;
  toolCallCount?: number;
  summary: string;
  backgroundJobId?: string;
}

export interface VoiceInjectRequest {
  id: string;
  text: string;
  at: number;
}

export interface VoiceProbeState {
  id: string;
  text: string;
  at: number;
  status: "queued" | "running" | "done" | "rejected" | "error";
  turnStartMs?: number;
  firstAudioMs?: number;
  doneMs?: number;
  responseCount?: number;
  transcript?: string;
  message?: string;
}

export interface VoiceVisionState {
  at: number;
  summary: string;
  matchName?: string;
  confidence?: number;
  imagePath?: string;
}

export interface VoiceSpeakerState {
  at: number;
  summary: string;
  matchName?: string;
  confidence?: number;
  sampleMs?: number;
  unknownPromptPending?: boolean;
}

const STATE_DIR = "/tmp/friday-voice";
const PID_FILE = path.join(STATE_DIR, "daemon.pid");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const INJECT_FILE = path.join(STATE_DIR, "inject.json");
export const LOG_FILE = path.join(STATE_DIR, "daemon.log");
export const SHORTCUT_LOG_FILE = path.join(STATE_DIR, "shortcut.log");
export const READINESS_FILE = path.join(STATE_DIR, "readiness.json");

export function ensureStateDir(): void {
  mkdirSync(STATE_DIR, { recursive: true });
}

export function writePid(pid: number): void {
  ensureStateDir();
  writeFileSync(PID_FILE, String(pid));
}

export function readPid(): number | null {
  try {
    const pid = Number(readFileSync(PID_FILE, "utf8").trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function clearPid(): void {
  try {
    rmSync(PID_FILE, { force: true });
  } catch {
    /* ignore */
  }
}

/** True if a process with this pid is alive (signal 0 = existence check). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The pid of a live daemon, or null (also cleans up a stale pidfile). */
export function runningDaemonPid(): number | null {
  const pid = readPid();
  if (pid == null) return null;
  if (isAlive(pid)) return pid;
  clearPid();
  return null;
}

export function writeState(state: DaemonState): void {
  ensureStateDir();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function readState(): DaemonState | null {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as DaemonState;
  } catch {
    return null;
  }
}

export function writeInjectRequest(request: VoiceInjectRequest): void {
  ensureStateDir();
  writeFileSync(INJECT_FILE, JSON.stringify(request, null, 2));
}

export function readInjectRequest(): VoiceInjectRequest | null {
  try {
    const parsed = JSON.parse(readFileSync(INJECT_FILE, "utf8")) as VoiceInjectRequest;
    if (
      !parsed ||
      typeof parsed.id !== "string" ||
      typeof parsed.text !== "string" ||
      typeof parsed.at !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearInjectRequest(): void {
  try {
    rmSync(INJECT_FILE, { force: true });
  } catch {
    /* ignore */
  }
}

export { STATE_DIR, PID_FILE, STATE_FILE, INJECT_FILE };
