// Daemon pid + state files under /tmp/friday-voice. The CLI (`toggle`/`stop`/
// `status`) talks to a running daemon purely through these files + signals —
// no socket, no port. Keeps the toggle path dead simple for skhd to call.

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
  interruptMinLevel?: number;
  interruptFrames?: number;
  micPeakLevel?: number;
  lastLatency?: VoiceLatencyState;
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

const STATE_DIR = "/tmp/friday-voice";
const PID_FILE = path.join(STATE_DIR, "daemon.pid");
const STATE_FILE = path.join(STATE_DIR, "state.json");
export const LOG_FILE = path.join(STATE_DIR, "daemon.log");

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

export { STATE_DIR, PID_FILE, STATE_FILE };
