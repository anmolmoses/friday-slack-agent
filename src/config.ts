export interface RepoConfig {
  name: string;
  path: string;
  defaultBase: string;
  /**
   * Provisioning script relative to the repo root, run for "full" worktrees
   * (build/frontend) to copy env files, migrate MCPs, and install deps. When
   * omitted, WorktreeManager auto-detects `scripts/setup-worktree.sh`. If no
   * script is found, full worktrees fall back to a light (raw-git) checkout.
   */
  setupScript?: string;
}

export interface Config {
  slack: {
    botToken: string;
    appToken: string;
    signingSecret: string;
  };
  claude: {
    maxTurns: number;
    /** Inactivity window (ms): kill only after this much silence (no stream events). */
    timeoutMs: number;
    /** Absolute ceiling (ms): kill regardless of activity. Catches runaway loops. */
    maxTimeoutMs: number;
    permissionMode: string;
  };
  /**
   * Which engine drives Friday's per-Slack-message brain (chat, memory writes,
   * doc writing, planning, deciding to dispatch). Coding is always handed off to
   * Claude via bin/dispatch-claude.sh regardless of this setting.
   *   "codex"  → `codex exec` on the ChatGPT subscription (default)
   *   "claude" → `claude -p` on the Max subscription (original behavior)
   * Flip with FRIDAY_BRAIN to revert instantly without code changes.
   */
  brain: {
    engine: "codex" | "claude";
    /** Codex model when engine=codex. Mirrors ~/.codex/config.toml default. */
    codexModel: string;
    /** Reasoning effort for the codex brain (overrides config.toml's xhigh). */
    codexReasoning: string;
  };
  repos: RepoConfig[];
  session: {
    staleTimeoutMs: number;
    cleanupIntervalMs: number;
  };
  worktree: {
    /**
     * Hard cap on total disk used by all `slack-*` worktrees across every repo.
     * The reaper evicts least-recently-used CLEAN worktrees until the total is
     * back under this cap. Dirty (uncommitted) worktrees are never evicted.
     */
    diskCapBytes: number;
  };
  http: {
    port: number;
    enabled: boolean;
  };
  redis?: {
    url: string;
  };
}

function required(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return val;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export function loadConfig(): Config {
  return {
    slack: {
      botToken: required("SLACK_BOT_TOKEN"),
      appToken: required("SLACK_APP_TOKEN"),
      signingSecret: optional("SLACK_SIGNING_SECRET", ""),
    },
    claude: {
      maxTurns: Number(optional("CLAUDE_MAX_TURNS", "25")),
      // Inactivity window: 10 min of silence (gives long single tool calls —
      // builds, sub-agent dispatch — room to finish). Resets on every event.
      timeoutMs: Number(optional("CLAUDE_TIMEOUT_MS", "600000")),
      // Absolute ceiling regardless of activity: 30 min per turn.
      maxTimeoutMs: Number(optional("CLAUDE_MAX_TIMEOUT_MS", "1800000")),
      permissionMode: optional("CLAUDE_PERMISSION_MODE", "bypassPermissions"),
    },
    brain: {
      engine:
        optional("FRIDAY_BRAIN", "codex") === "claude" ? "claude" : "codex",
      codexModel: optional("FRIDAY_CODEX_MODEL", "gpt-5.5"),
      codexReasoning: optional("FRIDAY_CODEX_REASONING", "medium"),
    },
    repos: JSON.parse(optional("REPOS", "[]")) as RepoConfig[],
    session: {
      staleTimeoutMs: Number(optional("SESSION_STALE_TIMEOUT_MS", "86400000")),
      cleanupIntervalMs: Number(
        optional("SESSION_CLEANUP_INTERVAL_MS", "900000")
      ),
    },
    worktree: {
      diskCapBytes:
        Number(optional("WORKTREE_DISK_CAP_GB", "20")) * 1024 * 1024 * 1024,
    },
    http: {
      port: Number(optional("HTTP_PORT", "3000")),
      enabled: optional("HTTP_ENABLED", "true") === "true",
    },
    redis: process.env.REDIS_URL ? { url: process.env.REDIS_URL } : undefined,
  };
}
