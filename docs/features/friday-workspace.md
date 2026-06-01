# Friday's Workspace

Friday operates on **her own clones** of the target repos, kept separate from Anmol's personal checkouts. This stops her git activity (fetches, `slack/<thread>` branches, worktrees) from touching the repos Anmol works in by hand.

## Layout

```
/Users/anmol/Documents/GitHub/
  gx-client-expo/                 ← Anmol's checkout (HIS — Friday never touches)
  gx-backend/                     ← Anmol's checkout
  ...
  friday-workspace/               ← Friday's workspace (HERS)
    gx-client-expo/               ← Friday's clone
    gx-backend/
    gx-client-next/
    gx-admin-client/
    gx-talent-client/
    Built-at-GrowthX/
    slack-lookup/
```

Each entry under `friday-workspace/` is a full, independent `git clone` of the same origin as Anmol's copy — its own `.git`, its own branches, its own worktrees.

## How the bot uses it

- **`REPOS` in `.env`** points `path` at the workspace clones (e.g. `…/friday-workspace/gx-backend`). This is the single source of truth `WorktreeManager` reads.
- **Worktrees** are created inside the clone, at `<clone>/.claude/worktrees/slack-<threadId>`, on a `slack/<threadId>` branch off `origin/main`.
- **Freshness is automatic** — `WorktreeManager.createWorktree` runs `git fetch origin` before branching, so every thread bases off the latest `origin/main`. No separate sync daemon needed. (A periodic `git fetch` across all clones is a possible future nicety, not a requirement.)
- **PRs** are pushed from the clone's `slack/<threadId>` branch to the shared origin — same remote Anmol's copy uses, so PRs land in the normal GitHub repo.

## Operational notes

- **Changing `REPOS` requires a bot restart** to take effect (config is read at startup).
- **Building/running an app** (not just reading/editing code) needs per-repo setup in the clone that a bare `git clone` doesn't bring: `pnpm install`, `.env`/secrets, and for mobile EAS login. Code review and most edits work without it; `ota`/builds do not until the clone is provisioned.
- **Adding a repo later:** `git clone <origin> /Users/anmol/Documents/GitHub/friday-workspace/<name>`, then add an entry to `REPOS` and restart.
- **`.env` backups** from repointing are saved as `.env.bak.<timestamp>` in the project root.
