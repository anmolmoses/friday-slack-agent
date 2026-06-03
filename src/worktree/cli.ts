#!/usr/bin/env bun
/**
 * Manual worktree ops — inspect and reclaim disk outside the bot loop.
 *
 *   bun run src/worktree/cli.ts list        # list all slack-* worktrees + disk
 *   bun run src/worktree/cli.ts reap        # disk-pressure LRU evict (clean only)
 *   bun run src/worktree/cli.ts reap --force # also force the reap regardless of cap
 *
 * Uses REPOS + WORKTREE_DISK_CAP_GB from the environment, same as the server.
 */
import path from "node:path";
import { loadConfig } from "../config.ts";
import { FileSessionStore } from "../session/store/file.ts";
import { WorktreeManager } from "./manager.ts";
import { reapWorktrees } from "./reaper.ts";

const GB = 1024 * 1024 * 1024;
const gb = (b: number) => `${(b / GB).toFixed(2)}GB`;

async function main() {
  const cmd = process.argv[2] ?? "list";
  const force = process.argv.includes("--force");

  const config = loadConfig();
  const store = new FileSessionStore(
    path.resolve(import.meta.dir, "..", "..", "memory", "sessions.json"),
  );
  const manager = new WorktreeManager(config.repos);

  const sessions = await store.getAll();
  const activity = new Map<string, number>();
  for (const [tid, s] of sessions) activity.set(tid, s.lastActivity);

  if (cmd === "list") {
    const all = await manager.listAllWorktrees(activity);
    const total = all.reduce((sum, w) => sum + w.diskBytes, 0);
    console.log(`${all.length} worktree(s), ${gb(total)} total (cap ${gb(config.worktree.diskCapBytes)})\n`);
    for (const w of all.sort((a, b) => b.diskBytes - a.diskBytes)) {
      const age = Math.round((Date.now() - w.lastActivity) / 3600_000);
      console.log(
        `${w.dirty ? "DIRTY" : "clean"}  ${gb(w.diskBytes).padStart(8)}  ${age}h  ${w.repoName}  ${w.branch ?? "?"}  ${w.path}`,
      );
    }
    return;
  }

  if (cmd === "reap") {
    const result = await reapWorktrees(manager, store, {
      // --force collapses the cap to 0 so every clean worktree is reclaimed.
      diskCapBytes: force ? 0 : config.worktree.diskCapBytes,
    });
    console.log(
      `Reaped ${result.evicted.length} worktree(s): ${gb(result.totalBefore)} -> ${gb(result.totalAfter)}`,
    );
    if (result.keptDirty.length > 0) {
      console.log(`Kept ${result.keptDirty.length} dirty worktree(s):`);
      for (const w of result.keptDirty) console.log(`  ${w.path}`);
    }
    return;
  }

  console.error(`Unknown command: ${cmd}. Use "list" or "reap".`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
