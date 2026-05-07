export interface Task {
  text: string;
  done: boolean;
}

export interface Topic {
  title: string;
  done: boolean;
  tasks: Task[];
}

export type StandupStatus =
  | "awaiting-input"   // kickoff posted in #friday-test, waiting on Anmol's input
  | "drafting"         // Friday is composing / iterating on a draft
  | "approved"         // Anmol said ship-it; waiting on focus-bot thread (or already known) before posting
  | "posted"           // Final message landed in the standup thread
  | "skipped";         // No reply / explicitly cancelled

export interface PendingStandup {
  date: string;                 // YYYY-MM-DD (IST)
  fridayTestThreadTs?: string;  // root ts of the kickoff thread Friday opened
  focusBotThreadTs?: string;    // root ts of the focus bot's standup post
  status: StandupStatus;
  approvedAt?: string;          // ISO when Anmol approved
  postedAt?: string;            // ISO when Friday posted to standup thread
  finalText?: string;           // The exact text that was approved + posted
}

export interface StandupSections {
  yesterday: Topic[];
  today: Topic[];
}

export interface StandupHistoryEntry {
  date: string;
  sections: StandupSections;
  finalText: string;
  postedTo?: { channel: string; ts: string };
  postedAt?: string;
}

export interface StandupState {
  current?: PendingStandup;
  history: Record<string, StandupHistoryEntry>;
}

export const FRIDAY_TEST_CHANNEL = "C0AUYJHK6UW";
export const STANDUP_CHANNEL = "C099U3UP2AK";
export const FOCUS_BOT_ID = "B0B1TSCBGTB";
