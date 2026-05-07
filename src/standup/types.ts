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
  | "awaiting-input"   // kickoff posted in #friday-test, waiting on the user's input
  | "drafting"         // Friday is composing / iterating on a draft
  | "approved"         // the user said ship-it; waiting on focus-bot thread (or already known) before posting
  | "posted"           // Final message landed in the standup thread
  | "skipped";         // No reply / explicitly cancelled

export interface PendingStandup {
  date: string;                 // YYYY-MM-DD (IST)
  fridayTestThreadTs?: string;  // root ts of the kickoff thread Friday opened
  focusBotThreadTs?: string;    // root ts of the focus bot's standup post
  status: StandupStatus;
  approvedAt?: string;          // ISO when the user approved
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

export const FRIDAY_TEST_CHANNEL = "C_SANDBOX";
export const STANDUP_CHANNEL = "C_STANDUP";
export const FOCUS_BOT_ID = "B0B1TSCBGTB";
