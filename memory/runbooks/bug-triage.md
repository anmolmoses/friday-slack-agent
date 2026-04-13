# Bug Triage Runbook

## Trigger
Someone @mentions Anmol in Slack #bugs-backlog (C05557KKV37).

## Steps

1. **Ack in Slack thread** — "Got it — I'll be looking into this"
2. **Classify** — Severity (critical/high/medium/low), Domain (backend/frontend/infra/db), one-line title
3. **Determine assignee** — Backend/infra/db bugs -> build agent. Frontend/UI bugs -> frontend agent.
4. **Determine repo** — Backend: gx-backend. Frontend: gx-client-next.
5. **Execute fix** via Claude Code:
   - cd into LOCAL repo (NEVER clone)
   - Fresh pull from main: `git checkout main && git pull origin main`
   - Create branch: `fix/<bug-slug>`
   - Fix the bug with full codebase access
   - Commit with descriptive message
   - Push + TWO PRs: fix/branch -> dev AND fix/branch -> main
6. **Post PR links** back in the Slack thread
7. **Notify Anmol** — Summary with bug title, severity, PR links

## Rules
- Repos are LOCAL — never clone. Use: /Users/anmol/Documents/GitHub/gx-backend or gx-client-next
- Branching: ALWAYS from main. TWO PRs (-> dev and -> main). No exceptions.
- Each repo has a claude.md — follow it.
