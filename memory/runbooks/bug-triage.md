# Bug Triage Runbook

> **Edit this file** with your own channel IDs, repo names, and reviewer
> conventions. The placeholders below are deliberately generic.

## Trigger
Someone @mentions the owner in Slack `<BUG_TRIAGE_CHANNEL>` (set this in
`FRIDAY_BUG_TRIAGE_CHANNELS` in `.env`).

## Steps

1. **Ack in Slack thread** — "Got it — I'll be looking into this"
2. **Classify** — Severity (critical/high/medium/low), Domain (backend/frontend/infra/db), one-line title
3. **Determine assignee** — Backend/infra/db bugs → `build` agent. Frontend/UI bugs → `frontend` agent.
4. **Determine repo** — Pick from your configured `REPOS` list in `.env` based on the bug surface.
5. **Execute fix** via Claude Code:
   - `cd` into the LOCAL repo (NEVER clone)
   - Fresh pull from main: `git checkout main && git pull origin main`
   - Create branch: `fix/<bug-slug>`
   - Fix the bug with full codebase access
   - Commit with descriptive message
   - Push + open PR(s). If your repo flow uses `dev` → `main`, open one PR against each base.
6. **Post PR links** back in the Slack thread
7. **Notify owner** — Summary with bug title, severity, PR links

## Rules
- Repos are LOCAL — paths come from `REPOS` in `.env`. Never clone.
- Branching: ALWAYS from `main`, fresh from `origin/main`.
- Each target repo has its own `CLAUDE.md` — follow it.
