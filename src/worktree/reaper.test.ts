import { describe, it, expect } from "bun:test";
import { reapWorktrees } from "./reaper.ts";
import { InMemorySessionStore } from "../session/store/memory.ts";
import { createSession } from "../session/types.ts";
import type { WorktreeInfo } from "./types.ts";

const GB = 1024 * 1024 * 1024;

/**
 * Minimal stub standing in for WorktreeManager. We only exercise the reaper's
 * decision logic (which to evict), so we record removals instead of touching
 * git. Typed via `as` because the reaper only calls these two methods.
 */
function makeManager(worktrees: WorktreeInfo[]) {
  const removed: string[] = [];
  const manager = {
    async listAllWorktrees() {
      return worktrees;
    },
    async removeWorktree(_repo: string, threadId: string) {
      removed.push(threadId);
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { manager: manager as any, removed };
}

function wt(over: Partial<WorktreeInfo>): WorktreeInfo {
  return {
    repoName: "repo",
    path: `/repo/.claude/worktrees/slack-${over.threadId ?? "t"}`,
    threadId: "t",
    branch: "slack/t",
    dirty: false,
    diskBytes: 5 * GB,
    lastActivity: 0,
    ...over,
  };
}

describe("reapWorktrees", () => {
  it("keeps everything when under the disk cap", async () => {
    const { manager, removed } = makeManager([
      wt({ threadId: "a", diskBytes: 3 * GB }),
      wt({ threadId: "b", diskBytes: 3 * GB }),
    ]);
    const store = new InMemorySessionStore();

    const r = await reapWorktrees(manager, store, { diskCapBytes: 20 * GB });

    expect(removed).toEqual([]);
    expect(r.evicted).toHaveLength(0);
    expect(r.totalBefore).toBe(6 * GB);
  });

  it("evicts least-recently-used clean worktrees until under the cap", async () => {
    const { manager, removed } = makeManager([
      wt({ threadId: "old", diskBytes: 8 * GB, lastActivity: 100 }),
      wt({ threadId: "mid", diskBytes: 8 * GB, lastActivity: 200 }),
      wt({ threadId: "new", diskBytes: 8 * GB, lastActivity: 300 }),
    ]);
    const store = new InMemorySessionStore();

    // 24GB total, 10GB cap -> must drop 2 LRU (old, then mid).
    const r = await reapWorktrees(manager, store, { diskCapBytes: 10 * GB });

    expect(removed).toEqual(["old", "mid"]);
    expect(r.evicted.map((w) => w.threadId)).toEqual(["old", "mid"]);
    expect(r.totalAfter).toBe(8 * GB);
  });

  it("never evicts dirty worktrees, even under pressure", async () => {
    const { manager, removed } = makeManager([
      wt({ threadId: "dirty", diskBytes: 30 * GB, dirty: true, lastActivity: 1 }),
      wt({ threadId: "clean", diskBytes: 5 * GB, lastActivity: 2 }),
    ]);
    const store = new InMemorySessionStore();

    const r = await reapWorktrees(manager, store, { diskCapBytes: 10 * GB });

    // Only the clean one is eligible; dirty is reported as held.
    expect(removed).toEqual(["clean"]);
    expect(r.keptDirty.map((w) => w.threadId)).toEqual(["dirty"]);
  });

  it("clears the worktree pointer on a still-live session it evicts", async () => {
    const path = "/repo/.claude/worktrees/slack-live";
    const { manager } = makeManager([
      wt({ threadId: "live", path, diskBytes: 30 * GB, lastActivity: 1 }),
    ]);
    const store = new InMemorySessionStore();
    const session = createSession("live", "C01");
    session.worktreePath = path;
    session.worktreeProvisioned = true;
    await store.set("live", session);

    await reapWorktrees(manager, store, { diskCapBytes: 10 * GB });

    const after = await store.get("live");
    expect(after?.worktreePath).toBeNull();
    expect(after?.worktreeProvisioned).toBe(false);
  });
});
