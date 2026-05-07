import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

export interface Reminder {
  date: string; // YYYY-MM-DD
  text: string;
}

export interface DumpEntry {
  id: string; // YYYYMMDD-NNN
  ts: string; // ISO timestamp
  text: string;
  reminders: Reminder[];
  status: "open" | "done";
  doneAt?: string;
}

const ROOT = path.resolve(import.meta.dir, "..", "..", "memory", "dumps");

function ensureDir(): void {
  if (!existsSync(ROOT)) mkdirSync(ROOT, { recursive: true });
}

function fileFor(date: string): string {
  return path.join(ROOT, `${date}.json`);
}

function readDay(date: string): DumpEntry[] {
  ensureDir();
  const f = fileFor(date);
  if (!existsSync(f)) return [];
  try {
    return JSON.parse(readFileSync(f, "utf-8")) as DumpEntry[];
  } catch {
    return [];
  }
}

function writeDay(date: string, entries: DumpEntry[]): void {
  ensureDir();
  writeFileSync(fileFor(date), JSON.stringify(entries, null, 2));
}

/** IST date in YYYY-MM-DD form for a given Date (defaults to now). */
export function istDate(d: Date = new Date()): string {
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

export function addDump(text: string): DumpEntry {
  const today = istDate();
  const entries = readDay(today);
  const seq = String(entries.length + 1).padStart(3, "0");
  const entry: DumpEntry = {
    id: `${today.replace(/-/g, "")}-${seq}`,
    ts: new Date().toISOString(),
    text,
    reminders: parseReminders(text),
    status: "open",
  };
  entries.push(entry);
  writeDay(today, entries);
  return entry;
}

export function markDone(id: string): DumpEntry | null {
  const date = idToDate(id);
  if (!date) return null;
  const entries = readDay(date);
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) return null;
  entries[idx].status = "done";
  entries[idx].doneAt = new Date().toISOString();
  writeDay(date, entries);
  return entries[idx];
}

function idToDate(id: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})-\d{3}$/.exec(id);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** All open dumps from the last `lookbackDays` IST days, including today. */
export function openDumpsSince(lookbackDays: number): DumpEntry[] {
  ensureDir();
  const out: DumpEntry[] = [];
  const today = new Date();
  for (let i = 0; i <= lookbackDays; i++) {
    const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    const date = istDate(d);
    for (const e of readDay(date)) {
      if (e.status === "open") out.push(e);
    }
  }
  return out;
}

/** Reminders due on or before the given IST date. */
export function dueReminders(onOrBefore: string): Array<{ entry: DumpEntry; reminder: Reminder }> {
  ensureDir();
  const out: Array<{ entry: DumpEntry; reminder: Reminder }> = [];
  const files = readdirSync(ROOT).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    const date = f.replace(/\.json$/, "");
    for (const e of readDay(date)) {
      if (e.status === "done") continue;
      for (const r of e.reminders) {
        if (r.date <= onOrBefore) out.push({ entry: e, reminder: r });
      }
    }
  }
  return out;
}

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

function nextWeekday(target: number, from: Date): Date {
  const cur = from.getDay();
  let diff = target - cur;
  if (diff <= 0) diff += 7;
  const d = new Date(from);
  d.setDate(d.getDate() + diff);
  return d;
}

/**
 * Pull "remind me on X" / "remind me X" hints from free text.
 * Supports: weekday names, "tomorrow", "in N days", explicit YYYY-MM-DD.
 */
export function parseReminders(text: string): Reminder[] {
  const out: Reminder[] = [];
  const now = new Date();
  // Treat "now" in IST so weekday math matches the user's day.
  const istNow = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);

  const re =
    /remind\s+me\s+(?:on\s+|to\s+)?([a-z0-9-]+(?:\s+[a-z0-9-]+){0,3})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const phrase = m[1].toLowerCase().trim();
    const date = phraseToDate(phrase, istNow);
    if (!date) continue;
    out.push({ date, text: m[0] });
  }
  return out;
}

function phraseToDate(phrase: string, from: Date): string | null {
  // YYYY-MM-DD literal
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(phrase);
  if (iso) return iso[1];

  if (phrase.startsWith("tomorrow")) {
    const d = new Date(from);
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }

  // "in N days" / "in N day"
  const inDays = /^in\s+(\d+)\s+day/.exec(phrase);
  if (inDays) {
    const d = new Date(from);
    d.setDate(d.getDate() + parseInt(inDays[1], 10));
    return d.toISOString().slice(0, 10);
  }

  for (let i = 0; i < WEEKDAYS.length; i++) {
    if (phrase.startsWith(WEEKDAYS[i])) {
      return nextWeekday(i, from).toISOString().slice(0, 10);
    }
  }

  return null;
}
