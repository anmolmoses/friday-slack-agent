/**
 * A live `slack-*` worktree on disk, as reported by `git worktree list`.
 * This is ground truth — it includes worktrees whose owning session has
 * already been evicted from the store (e.g. left behind by a crashed process),
 * which is exactly what the reaper needs to find and reclaim.
 */
export interface WorktreeInfo {
  repoName: string;
  /** Absolute path to the worktree directory. */
  path: string;
  /** The thread that owns it, parsed from the `slack-<threadId>` dir name. */
  threadId: string;
  /** Branch checked out in the worktree (e.g. `slack/<threadId>`). */
  branch: string | null;
  /** Whether it has uncommitted changes (never auto-evicted when true). */
  dirty: boolean;
  /** Disk used by the worktree, in bytes. */
  diskBytes: number;
  /**
   * Last-touched time (ms epoch) for LRU ordering. Sourced from the owning
   * session's `lastActivity` when known, else the worktree dir's mtime.
   */
  lastActivity: number;
}

export type ProvisionLevel = "light" | "full";
