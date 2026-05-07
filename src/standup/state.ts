import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  PendingStandup,
  StandupHistoryEntry,
  StandupState,
} from "./types.ts";

const FILE = path.resolve(
  import.meta.dir,
  "..",
  "..",
  "memory",
  "standup.json",
);

function ensureDir(): void {
  const dir = path.dirname(FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function load(): StandupState {
  ensureDir();
  if (!existsSync(FILE)) return { history: {} };
  try {
    return JSON.parse(readFileSync(FILE, "utf-8")) as StandupState;
  } catch {
    return { history: {} };
  }
}

function save(state: StandupState): void {
  ensureDir();
  writeFileSync(FILE, JSON.stringify(state, null, 2));
}

export function getState(): StandupState {
  return load();
}

export function getPending(): PendingStandup | undefined {
  return load().current;
}

export function setPending(pending: PendingStandup | undefined): void {
  const state = load();
  if (pending) state.current = pending;
  else delete state.current;
  save(state);
}

export function updatePending(
  updater: (p: PendingStandup) => PendingStandup,
): PendingStandup | undefined {
  const state = load();
  if (!state.current) return undefined;
  state.current = updater(state.current);
  save(state);
  return state.current;
}

export function archive(entry: StandupHistoryEntry): void {
  const state = load();
  state.history[entry.date] = entry;
  delete state.current;
  save(state);
}

export function getHistory(date: string): StandupHistoryEntry | undefined {
  return load().history[date];
}

/** Most recent prior standup (excluding the given date), if any. */
export function getMostRecentPrior(beforeDate: string): StandupHistoryEntry | undefined {
  const state = load();
  const dates = Object.keys(state.history)
    .filter((d) => d < beforeDate)
    .sort()
    .reverse();
  return dates.length > 0 ? state.history[dates[0]] : undefined;
}
