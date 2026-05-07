import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RepoConfig } from "../config.ts";
import type { ProvisionLevel, WorktreeInfo } from "./types.ts";

/**
 * Relative path to the per-repo provisioning script we look for when no
 * explicit `setupScript` is configured. example-backend / example-admin /
 * example-web ship one; it does branch resolution + env copy + MCP
 * migration + `npm install`, takes `--path <abs>` / `--base <ref>`, and
 * prints the worktree's absolute path on its final line.
 */
const DEFAULT_SETUP_SCRIPT = "scripts/setup-worktree.sh";

/** Where a thread's worktree lives inside the repo clone. */
const WORKTREE_SUBDIR = ".claude/worktrees";

export class WorktreeManager {
  private repos: RepoConfig[];

  constructor(repos: RepoConfig[]) {
    this.repos = repos;
  }

  /**
   * Create (or reuse) a worktree in the target repo for a thread.
   *
   * - `light` (default): a raw `git worktree add` checkout — instant, isolated
   *   branch + git state, enough for reads, edits, and PR-branch checkouts.
   * - `full`: runs the repo's setup-worktree.sh so the worktree is runnable
   *   (env files, MCPs, `npm install`). Falls back to light if no script.
   *
   * Idempotent: if the worktree dir already exists, it's reused. Requesting
   * `full` on an existing light worktree upgrades it (the setup script skips
   * the `git worktree add` step and just provisions). Returns the path.
   */
  async createWorktree(
    repoName: string,
    threadId: string,
    baseRef?: string,
    level: ProvisionLevel = "light",
  ): Promise<string> {
    const repo = this.getRepo(repoName);
    if (!repo) {
      throw new Error(`Unknown repo: ${repoName}`);
    }

    const worktreePath = this.getWorktreePath(repoName, threadId);
    const branchName = `slack/${threadId}`;
    const base = baseRef ?? repo.defaultBase;

    if (level === "full" && this.setupScriptPath(repo)) {
      await this.provisionFull(repo, branchName, worktreePath, base);
      return worktreePath;
    }

    // Light path — raw git. Skip the add if the worktree already exists.
    if (!(await this.worktreeExists(repoName, threadId))) {
      await this.runGit(["fetch", "origin", "--prune"], repo.path);
      await this.addWorktreeLight(repo.path, worktreePath, branchName, base);
    }
    return worktreePath;
  }

  /**
   * Upgrade an existing (light) worktree to full provisioning by running the
   * repo's setup script. No-op (returns false) if the repo has no script.
   * Safe to call repeatedly — the script is idempotent.
   */
  async upgradeWorktree(
    repoName: string,
    threadId: string,
    baseRef?: string,
  ): Promise<boolean> {
    const repo = this.getRepo(repoName);
    if (!repo) throw new Error(`Unknown repo: ${repoName}`);
    if (!this.setupScriptPath(repo)) return false;

    const worktreePath = this.getWorktreePath(repoName, threadId);
    const branchName = `slack/${threadId}`;
    const base = baseRef ?? repo.defaultBase;
    await this.provisionFull(repo, branchName, worktreePath, base);
    return true;
  }

  /**
   * Remove a worktree and its branch. Guards against ever touching anything
   * outside the repo's worktree dir (defends the user's checkouts and the clone
   * root). Tolerant of an already-deleted dir or branch; always prunes after.
   */
  async removeWorktree(repoName: string, threadId: string): Promise<void> {
    const repo = this.getRepo(repoName);
    if (!repo) {
      throw new Error(`Unknown repo: ${repoName}`);
    }

    const worktreePath = this.getWorktreePath(repoName, threadId);
    this.assertInsideWorktreeDir(repo, worktreePath);
    const branchName = `slack/${threadId}`;

    // Force-remove the worktree (ignore "not a working tree" if already gone).
    try {
      await this.runGit(
        ["worktree", "remove", worktreePath, "--force"],
        repo.path,
      );
    } catch (err) {
      console.warn(
        `[worktree] remove ${worktreePath} failed (continuing): ${(err as Error).message}`,
      );
    }

    // Clean up the branch (may already be deleted).
    try {
      await this.runGit(["branch", "-D", branchName], repo.path);
    } catch {
      /* branch already gone */
    }

    // Clear any dangling administrative refs left behind.
    await this.pruneDangling(repoName);
  }

  /** Remove git's record of worktrees whose dir vanished (crash cleanup). */
  async pruneDangling(repoName: string): Promise<void> {
    const repo = this.getRepo(repoName);
    if (!repo) return;
    try {
      await this.runGit(["worktree", "prune"], repo.path);
    } catch (err) {
      console.warn(`[worktree] prune ${repoName} failed: ${(err as Error).message}`);
    }
  }

  /**
   * List every `slack-*` worktree in a repo, with dirty status, disk usage,
   * and last-activity (caller supplies a threadId→lastActivity map from the
   * session store so eviction can be LRU even for sessions still alive).
   */
  async listWorktrees(
    repoName: string,
    activityByThread?: Map<string, number>,
  ): Promise<WorktreeInfo[]> {
    const repo = this.getRepo(repoName);
    if (!repo) return [];

    let raw: string;
    try {
      raw = await this.runGit(["worktree", "list", "--porcelain"], repo.path);
    } catch {
      return [];
    }

    const prefix = join(repo.path, WORKTREE_SUBDIR) + "/slack-";
    const out: WorktreeInfo[] = [];

    // `--porcelain` emits blank-line-separated records: `worktree <path>`,
    // `HEAD <sha>`, `branch refs/heads/<name>`.
    for (const block of raw.split("\n\n")) {
      const lines = block.split("\n");
      const pathLine = lines.find((l) => l.startsWith("worktree "));
      if (!pathLine) continue;
      const path = pathLine.slice("worktree ".length).trim();
      if (!path.startsWith(prefix)) continue;

      const branchLine = lines.find((l) => l.startsWith("branch "));
      const branch = branchLine
        ? branchLine.slice("branch ".length).replace("refs/heads/", "").trim()
        : null;
      const threadId = path.slice(prefix.length);

      const [dirty, diskBytes, mtime] = await Promise.all([
        this.isWorktreeDirty(path).catch(() => false),
        this.diskUsage(path),
        this.dirMtime(path),
      ]);

      out.push({
        repoName,
        path,
        threadId,
        branch,
        dirty,
        diskBytes,
        lastActivity: activityByThread?.get(threadId) ?? mtime,
      });
    }
    return out;
  }

  /** List `slack-*` worktrees across every configured repo. */
  async listAllWorktrees(
    activityByThread?: Map<string, number>,
  ): Promise<WorktreeInfo[]> {
    const all = await Promise.all(
      this.repos.map((r) => this.listWorktrees(r.name, activityByThread)),
    );
    return all.flat();
  }

  /** Check if a worktree directory exists for a thread. */
  async worktreeExists(repoName: string, threadId: string): Promise<boolean> {
    const worktreePath = this.getWorktreePath(repoName, threadId);
    try {
      const { stat } = await import("node:fs/promises");
      const s = await stat(worktreePath);
      return s.isDirectory();
    } catch {
      return false;
    }
  }

  /** Check if a worktree has uncommitted changes. */
  async isWorktreeDirty(worktreePath: string): Promise<boolean> {
    const output = await this.runGit(["status", "--porcelain"], worktreePath);
    return output.trim().length > 0;
  }

  /** Get the worktree path for a thread (without creating it). */
  getWorktreePath(repoName: string, threadId: string): string {
    const repo = this.getRepo(repoName);
    if (!repo) {
      throw new Error(`Unknown repo: ${repoName}`);
    }
    return join(repo.path, WORKTREE_SUBDIR, `slack-${threadId}`);
  }

  /** Find a repo config by name. */
  getRepo(name: string): RepoConfig | undefined {
    return this.repos.find((r) => r.name === name);
  }

  // ---- internals ----------------------------------------------------------

  /** Resolve the setup script's absolute path, or null if the repo has none. */
  private setupScriptPath(repo: RepoConfig): string | null {
    const rel = repo.setupScript ?? DEFAULT_SETUP_SCRIPT;
    const abs = join(repo.path, rel);
    return existsSync(abs) ? abs : null;
  }

  /**
   * Mirror the setup script's three-case branch resolution for the light path:
   *  A) local branch exists        -> check it out
   *  B) only origin/<branch> exists -> track it
   *  C) neither                     -> new branch off base, --no-track
   */
  private async addWorktreeLight(
    repoPath: string,
    worktreePath: string,
    branchName: string,
    base: string,
  ): Promise<void> {
    if (await this.refExists(repoPath, branchName)) {
      await this.runGit(["worktree", "add", worktreePath, branchName], repoPath);
    } else if (await this.refExists(repoPath, `origin/${branchName}`)) {
      await this.runGit(
        ["worktree", "add", worktreePath, "-b", branchName, `origin/${branchName}`],
        repoPath,
      );
    } else {
      // --no-track: base is a remote ref like origin/main; without this the new
      // branch silently tracks it and `git status` reads ahead/behind forever.
      await this.runGit(
        ["worktree", "add", "--no-track", "-b", branchName, worktreePath, base],
        repoPath,
      );
    }
  }

  /** Run the repo's setup-worktree.sh to fully provision the worktree. */
  private async provisionFull(
    repo: RepoConfig,
    branchName: string,
    worktreePath: string,
    base: string,
  ): Promise<void> {
    const script = this.setupScriptPath(repo);
    if (!script) throw new Error(`No setup script for repo ${repo.name}`);

    const args = [script, branchName, "--path", worktreePath, "--base", base];
    const proc = Bun.spawn(["bash", ...args], {
      cwd: repo.path,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      // The worktree dir was created before any failing provisioning step
      // (npm install needing a token, etc.). We know its path (we passed
      // --path), so fail soft: the caller still gets an editable worktree.
      console.warn(
        `[worktree] setup-worktree.sh for ${repo.name} exited ${exitCode} ` +
          `(worktree usable but maybe not fully provisioned): ${stderr.trim()}`,
      );
    }
  }

  private async refExists(repoPath: string, ref: string): Promise<boolean> {
    try {
      await this.runGit(["rev-parse", "--verify", "--quiet", ref], repoPath);
      return true;
    } catch {
      return false;
    }
  }

  /** Disk used by a directory in bytes (via `du -sk`); 0 if unreadable. */
  private async diskUsage(path: string): Promise<number> {
    try {
      const out = await this.runRaw(["du", "-sk", path]);
      const kb = parseInt(out.split(/\s+/)[0] ?? "0", 10);
      return Number.isFinite(kb) ? kb * 1024 : 0;
    } catch {
      return 0;
    }
  }

  private async dirMtime(path: string): Promise<number> {
    try {
      const { stat } = await import("node:fs/promises");
      return (await stat(path)).mtimeMs;
    } catch {
      return 0;
    }
  }

  /**
   * Defence-in-depth: refuse to operate on any path that isn't strictly inside
   * `<repo>/.claude/worktrees/`. Stops a malformed threadId from ever pointing
   * `git worktree remove` at the clone root or one of the user's checkouts.
   */
  private assertInsideWorktreeDir(repo: RepoConfig, path: string): void {
    const base = join(repo.path, WORKTREE_SUBDIR) + "/slack-";
    if (!path.startsWith(base) || path.includes("..")) {
      throw new Error(`Refusing to operate on unsafe worktree path: ${path}`);
    }
  }

  /** Run a git command and return stdout. Throws on non-zero exit. */
  private async runGit(args: string[], cwd: string): Promise<string> {
    return this.runRaw(["git", ...args], cwd);
  }

  private async runRaw(argv: string[], cwd?: string): Promise<string> {
    const proc = Bun.spawn(argv, {
      ...(cwd ? { cwd } : {}),
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`${argv[0]} ${argv[1]} failed: ${stderr.trim()}`);
    }
    return await new Response(proc.stdout).text();
  }
}
