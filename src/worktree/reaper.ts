import type { SessionStore } from "../session/store/interface.ts";
import type { WorktreeManager } from "./manager.ts";
import type { WorktreeInfo } from "./types.ts";

export interface ReapResult {
  /** Total worktree disk before reaping, in bytes. */
  totalBefore: number;
  /** Total worktree disk after reaping, in bytes. */
  totalAfter: number;
  /** Worktrees removed this cycle. */
  evicted: WorktreeInfo[];
  /** Dirty worktrees kept despite pressure (need attention). */
  keptDirty: WorktreeInfo[];
}

const GB = 1024 * 1024 * 1024;
const fmt = (b: number) => `${(b / GB).toFixed(2)}GB`;

/**
 * Disk-pressure LRU reaper. Keeps every `slack-*` worktree until their combined
 * disk crosses `diskCapBytes`, then evicts least-recently-used CLEAN worktrees
 * until back under the cap. Dirty (uncommitted) worktrees are never evicted —
 * they're surfaced in `keptDirty` instead. Always prunes git's dangling
 * worktree refs first (reclaims those left by crashed processes for free).
 *
 * Operates on `git worktree list` ground truth, not the session store, so it
 * reclaims orphans whose session was already evicted. When a removed worktree
 * still has a live session, that session's `worktreePath` is cleared so the
 * next message recreates it on demand.
 */
export async function reapWorktrees(
  worktreeManager: WorktreeManager,
  store: SessionStore,
  opts: { diskCapBytes: number },
): Promise<ReapResult> {
  // Build a threadId -> lastActivity map so still-alive sessions order by real
  // activity rather than dir mtime.
  const sessions = await store.getAll();
  const activityByThread = new Map<string, number>();
  for (const [threadId, s] of sessions) {
    activityByThread.set(threadId, s.lastActivity);
  }

  const worktrees = await worktreeManager.listAllWorktrees(activityByThread);
  const totalBefore = worktrees.reduce((sum, w) => sum + w.diskBytes, 0);

  const keptDirty = worktrees.filter((w) => w.dirty);

  if (totalBefore <= opts.diskCapBytes) {
    return { totalBefore, totalAfter: totalBefore, evicted: [], keptDirty };
  }

  // Over cap: evict clean worktrees, least-recently-used first, until under it.
  const evictable = worktrees
    .filter((w) => !w.dirty)
    .sort((a, b) => a.lastActivity - b.lastActivity);

  const evicted: WorktreeInfo[] = [];
  let total = totalBefore;

  for (const w of evictable) {
    if (total <= opts.diskCapBytes) break;
    try {
      await worktreeManager.removeWorktree(w.repoName, w.threadId);
      // Don't kill the session — just drop its stale pointer so the next
      // message rebuilds the worktree.
      const session = sessions.get(w.threadId);
      if (session && session.worktreePath === w.path) {
        session.worktreePath = null;
        session.worktreeProvisioned = false;
        await store.set(w.threadId, session);
      }
      evicted.push(w);
      total -= w.diskBytes;
    } catch (err) {
      console.warn(
        `[reaper] failed to evict ${w.path}: ${(err as Error).message}`,
      );
    }
  }

  if (evicted.length > 0) {
    console.log(
      `[reaper] evicted ${evicted.length} worktree(s), ` +
        `${fmt(totalBefore)} -> ${fmt(total)} (cap ${fmt(opts.diskCapBytes)})`,
    );
  }
  if (total > opts.diskCapBytes && keptDirty.length > 0) {
    console.warn(
      `[reaper] still over cap (${fmt(total)}): ${keptDirty.length} dirty ` +
        `worktree(s) held — commit/push to free them: ` +
        keptDirty.map((w) => w.path).join(", "),
    );
  }

  return { totalBefore, totalAfter: total, evicted, keptDirty };
}
