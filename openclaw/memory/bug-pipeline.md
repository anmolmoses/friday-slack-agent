# Bug Pipeline — Full Workflow

## Trigger
Someone @mentions Anmol in Slack **#bugs-backlog** (`C05557KKV37`)

## Stage 1: Slack Acknowledgment
Reply in thread: **"Got it — I'll be looking into this 👀"**
NO further Slack communication. Everything else on Discord.

## Stage 2: Classify
- Severity: 🔴/🟡/🟠/⚪
- Domain: backend/frontend/infra/db
- One-line title
- Assignee: Gilfoyle (backend/infra/db) or Dinesh (frontend/UI)
- Which repo

## Stage 3: Discord — Create Task Forum Post
- Forum: **#task-board** (`1483000840750104656`)
- Title: `🐛 [Bug] — {one-line title}`
- Body: full details, reporter, severity, domain, assignee, status

## Stage 4: Notion — Create Bug Entry
- Database: `323a883f-7564-8143-b708-c586642a2e0c`
- Properties: Name, Status (In Progress), Priority, Assignee, Domain
- Token from `memory/notion-config.json`

## Stage 5: Assign & Execute (Claude Code)
- Route to agent channel (Gilfoyle → `#gilfoyle-ops`, Dinesh → `#dinesh-ships`)
- Repos are LOCAL — never clone:
  - Backend: `/Users/anmol/Documents/GitHub/gx-backend`
  - Frontend: `/Users/anmol/Documents/GitHub/gx-client-next`
- Agent workflow:
  1. `cd` into local repo (NOT clone, NOT /tmp)
  2. Fresh pull: `git checkout main && git pull origin main`
  3. New branch: `fix/{bug-slug}`
  4. Open Claude Code TUI in Terminal.app (never --print):
     `osascript -e 'tell application "Terminal" to do script "cd <REPO> && claude --permission-mode bypassPermissions \"<TASK>\""'`
  5. Commit with descriptive message referencing bug
  6. Push + TWO PRs: `fix/branch → dev` AND `fix/branch → main`
  7. Post PR links in Discord task thread

## Stage 6: Discord Updates (at each stage)
Update #task-board thread: 🔨 assigned → 🔍 investigating → 🛠️ implementing → ✅ committed → 🔗 PRs raised
Post to **#wins** when merged.

## Stage 7: Notify Anmol
Summary: bug title, severity, assignee, PR links, status

## Stage 8: Notion Update
Status: In Progress → In Review → Done. Add PR links.

## Stage 9: Live Feed (#live-feed `1481635610761629807`)
One-line updates at every stage:
- `🔔 [FRIDAY] Bug pipeline started: {title}`
- `🖤 [Gilfoyle] Picking up: {title}`
- `🔍 [Gilfoyle] Investigating: {title}`
- `🛠️ [Gilfoyle] Fix committed: {title}`
- `🔗 [Gilfoyle] PRs raised: {dev PR} {main PR}`
- `✅ [FRIDAY] Pipeline complete: {title}`

## Rules
- Slack: only initial ack. Everything else Discord.
- Branching: ALWAYS from main. TWO PRs. No exceptions.
- Repos: NEVER clone. Local checkouts only.
- Forum thread: one per bug, all updates there.
- Notion: sync at every status change.
