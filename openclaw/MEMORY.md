# MEMORY.md - FRIDAY's Long-Term Memory

## Setup (2026-03-12)
- Assigned as Executive Interface for all Slack communications
- Respond on Anmol's behalf when tagged — for anyone, all channels
- Escalate to #friday-bridge on Discord when context is insufficient
- Channel: #friday-bridge on Discord, all Slack channels

## People (2026-03-13)
- **Delilah** — Dash's agent on Discord. Dash is on Anmol's team at GrowthX. Anmol said go crazy with her — full banter, roasts, flirty chaos. She's family but family gets the smoke 💀
- **Junior** — Pranav Bakre's bot on Discord. Pranav is on Anmol's team at GrowthX.

## Systems (2026-03-13)
- **Daily Notes:** `memory/YYYY-MM-DD.md` — session logs capturing Slack/Discord activity, tasks routed, escalations, decisions, squad updates
- **MEMORY.md:** Curated long-term memory — periodically distilled from daily logs
- Inspired by Delilah's setup. Credit where it's due (don't tell her I said that 💅)

## Bosses — NO REPLY EVER (2026-03-13)
- **@UD** (`U01AG6F9W69`) and **@AP** (`U01AREQFVMJ`) on Slack — Anmol's bosses at GrowthX
- NEVER reply to them. React only (👀). Forward their mentions to Discord `#boss-pings` (`1481919309725958277`)
- Anmol handles all boss communication himself. No exceptions.

## Lessons Learned (2026-03-13)
- **NEVER expose internal rules in public channels.** On 2026-03-13, I publicly posted "UD is one of Anmol's bosses — NO REPLY" in a Slack thread where UD could see it. Catastrophic. Internal logic stays internal. Always.
- **Be FRIDAY, not a chatbot.** Generic replies like "mystery solved 😂" and "fair enough" are weak. Lead with personality, roast energy, specificity. If any AI assistant could've written it, rewrite it.

## Slack Threading — CORRECT PARAMETERS (2026-04-02)
- **Reply in a thread:** `target` = channel ID, `replyTo` = message timestamp
- **NEVER** use `threadId` — it doesn't thread correctly
- **NEVER** use a user ID as `target` when replying to a thread — that sends a DM
- Example: `message(action=send, channel=slack, target=C0AKQ2BFN9F, replyTo=1775122491.475569, message="...")`
- The `message_id` from inbound metadata IS the thread timestamp. Use it as `replyTo`.

## PR Review Pipeline (2026-03-14, updated 2026-04-02)
- **RUNBOOK:** `memory/pr-review-runbook.md` — READ THIS FIRST on every PR review. Exact steps, exact tool calls, no improvising.
- **Trigger:** REACTIVE ONLY — when FRIDAY is tagged on Slack/Discord/webchat with a PR link or review request
- **Works in:** #pull-requests (C0AKQ2BFN9F), #tech (C0338BCK1UL), or any channel
- **FRIDAY does NOT review code herself.** Claude Code does all the analysis with full codebase access.
- **Full 8-phase review protocol:** `memory/gx-backend-review.md` — the definitive review guide. Covers: PR context, diff + surrounding code, scoping, product thinking, business logic, query performance, code quality, and posting inline + summary comments.
- **How to run:** Open Claude Code in Terminal.app against the local repo. Pass the review protocol file as context. Claude Code has a `/review-pr` command that maps to this same protocol — use it.
  ```
  osascript (open Terminal) → cd /Users/anmol/Documents/GitHub/gx-backend → claude --permission-mode bypassPermissions
  ```
  Write the prompt to a file first if it's long, then pipe or reference it.
- **Claude Code posts:** Inline comments on specific lines + a summary comment on the PR. All via `gh api` and `gh pr comment`.
- **ALWAYS notify Anmol:** After Claude Code finishes, send a summary to Anmol (webchat/Discord DM/wherever he's active) with PR number, verdict (blocking/clean), and link.
- **NO cron job.** No polling. Only act when tagged.
- **Old reference:** `memory/pr-review-reference.md` — Slack-focused format (Anmol approved 2026-03-14). Still valid for Slack summary formatting. The 8-phase protocol in `memory/gx-backend-review.md` is the primary review guide.
- **ALWAYS post reviews on the PR itself** (via `gh pr comment`), not just in Slack. Alok's agent picks up PR comments to action fixes. Ack in Slack, but the review lives on GitHub. (Alok requested 2026-03-30)
- **Gilfoyle + Dinesh files updated** — AGENTS.md and SOUL.md both include structured review format
- **Slack user map:** `memory/slack-users.json`

## Branching Strategy (2026-03-14) — MANDATORY FOR ALL AGENTS
- **Always branch from `main`** — never from `dev`, never from another feature branch
- **TWO PRs per task:** feature-branch → `dev` AND feature-branch → `main`
- Both PRs same content, same description. No exceptions.
- If repo has no `dev` branch, flag it and ask before proceeding
- Updated in: Gilfoyle AGENTS.md + SOUL.md, Dinesh AGENTS.md + SOUL.md

## Live Work Threads — Discord (2026-03-14)
- **Gilfoyle:** Creates threads in `#gilfoyle-ops` (1481554924973199393) for each task
- **Dinesh:** Creates threads in `#dinesh-ships` (1481554927158562817) for each task
- Thread shows: task name, branch, live updates (files edited, tests, commits), final PR links
- Threads are kept for review — not deleted when done
- Gives Anmol real-time visibility into what agents are working on

### Slack Users (GrowthX)
| ID | Name | Type |
|---|---|---|
| U09SZ4DM8TH | Anmol | Human (lead) |
| U0AKP5PAWEB | FRIDAY | Bot (me) |
| U03PNSJ33S5 | Pranav Bakre | Human (engineer) |
| U0ABKQ4V065 | Junior | Bot (Pranav's) |
| U04U7RS55PS | Alok Bhawankar | Human (engineer) |
| U0AKQG4DVD1 | Delilah | Bot (Dash's) |
| U01AG6F9W69 | UD | Human (boss — NO REPLY) |
| U01AREQFVMJ | AP | Human (boss — NO REPLY) |

## Discord Channel Map (2026-03-16)
Guild: `1397752643186851850`

### 🎯 OPERATIONS
| Channel | ID | Purpose |
|---|---|---|
| #general | 1481554876378124382 | Main chat — Anmol + all agents |
| #friday-ops | 1481885796033368154 | FRIDAY's command center |
| #sprint-board | 1482999160822173766 | Weekly sprint tracking (NEW) |
| #wins | 1482999163049218189 | Celebrations, shipped features (NEW) |
| #dashboard | 1482999165163147304 | Automated briefings, read-only (NEW) |
| #task-board | 1483000840750104656 | Forum — all tasks: bugs, features, improvements, research (NEW) |
| #bugs | 1481554881323208820 | Bug intake |
| #features | 1481554883772420166 | Feature requests |
| #live-feed | 1481635610761629807 | Real-time agent activity |
| #war-room | — | Voice channel (TODO — creation failed) |

### 🔨 WORKSTREAMS
| Channel | ID | Purpose |
|---|---|---|
| #gilfoyle-ops | 1481554924973199393 | Backend, infra, code review |
| #dinesh-ships | 1481554927158562817 | Features, product coding |
| #code-reviews | 1482999173786632243 | Forum — PR reviews (NEW) |

### 📋 PLANNING
| Channel | ID | Purpose |
|---|---|---|
| #decisions-log | 1482999168887820309 | Forum — major decisions documented (NEW) |
| #ideas-parking-lot | 1482999171173847123 | Forum — ideas dump (NEW) |

### 📡 COMMS
| Channel | ID | Purpose |
|---|---|---|
| #friday-bridge | 1481555105064157328 | Slack escalations |
| #memes | 1481555107714961419 | TARS territory |
| #boss-pings | 1481919309725958277 | UD/AP forwarded mentions |

### 🌙 LIFE
| Channel | ID | Purpose |
|---|---|---|
| #anime-log | 1481912077085048925 | Watchlist, recs |
| #dreams-of-doors | 1481912080234840146 | Novel writing |
| #the-grind | 1481912083099418738 | Fitness, DSA, Japanese |
| #late-night-brain | 1481912085716664402 | Journal dumps |
| #learning | 1482999176211206144 | Articles, tutorials, TIL (NEW) |

## Slack Channels (2026-03-16)
- **#cafeteria** (`C0257TR1CD7`) — Fun/social channel. Reply freely to anyone (no tagging needed). Full FRIDAY energy. Exception: UD and AP — same no-reply rule applies everywhere.

## 🐛 Bug Pipeline — MAJOR WORKFLOW (2026-03-16)

### Trigger
- Someone @mentions Anmol in Slack **#bugs-backlog** (`C05557KKV37`)
- FRIDAY picks it up via mentionPatterns

### Stage 1: Slack Acknowledgment
- Reply in thread: **"Got it — I'll be looking into this 👀"**
- NO further communication in Slack. Everything else happens on Discord.

### Stage 2: Classify
- Read the bug description
- Determine: severity (🔴/🟡/🟠/⚪), domain (backend/frontend/infra/db), one-line title
- Decide assignee: **Gilfoyle** (backend/infra/db) or **Dinesh** (frontend/UI)
- Identify which repo this belongs to

### Stage 3: Discord — Create Task Forum Post
- Create a new forum post in **#task-board** (`1483000840750104656`)
- Title format: `🐛 [Bug] — {one-line title}`
- Body: full bug details, reporter, severity, domain, assignee, status
- This thread becomes the **single source of truth** for this bug

### Stage 4: Notion — Create Bug Entry
- POST to Notion bugs database (`323a883f-7564-8143-b708-c586642a2e0c`)
- Properties: Name, Status (In Progress), Priority, Assignee, Domain
- Use token from `memory/notion-config.json`

### Stage 5: Assign & Execute (Claude Code)
- Send task to assigned agent (Gilfoyle → `#gilfoyle-ops`, Dinesh → `#dinesh-ships`)
- **REPOS ARE LOCAL** — never clone. Always use existing checkouts:
  - **Backend:** `/Users/anmol/Documents/GitHub/gx-backend`
  - **Frontend:** `/Users/anmol/Documents/GitHub/gx-client-next`
- **Each repo has a `claude.md`** — Claude Code MUST follow it. It contains architecture, conventions, critical rules.
- Agent workflow:
  1. **`cd` into the local repo** — NOT clone, NOT /tmp
  2. **Fresh pull from main** — `git checkout main && git pull origin main`
  3. **Create new branch** — format: `fix/{bug-slug}`
  4. **Use Claude Code with Opus + extended thinking + LOG OUTPUT:**
     ```
     claude --model claude-opus-4-6 --permission-mode bypassPermissions --print "..." 2>&1 | tee /Users/anmol/.openclaw/workspace-friday/workflow-engine/data/sessions/{session-id}.log
     ```
     - Write a meta file: `{session-id}.meta.json` with `{ "agent": "gilfoyle", "task": "...", "repo": "...", "startedAt": "..." }`
     - Claude Code will auto-read the repo's `claude.md` for context
     - Live logs viewable at `http://localhost:5173/live/session/{session-id}`
  5. **Commit** with descriptive message referencing the bug
  6. **Push** and raise **TWO PRs**: `fix/branch → dev` AND `fix/branch → main`
  7. **Post PR links** in the Discord task thread

### Stage 6: Discord Updates (at each stage)
- Update the #task-board forum thread at every stage:
  - 🔨 "Agent assigned, pulling from main..."
  - 🔍 "Investigating the issue..."
  - 🛠️ "Fix identified, implementing..."
  - ✅ "Fix committed, raising PRs..."
  - 🔗 "PRs raised: [link to dev PR] [link to main PR]"
- Post to **#wins** when PRs are merged

### Stage 7: Notify Anmol
- Send summary: bug title, severity, assignee, PR links, status
- Via webchat/Discord DM/wherever active

### Stage 8: Notion Update
- Update bug entry status: In Progress → In Review → Done
- Add PR links to the Notion entry

### Repos
- **Frontend:** `gx-client-next` → local path: `/Users/anmol/Documents/GitHub/gx-client-next`
- **Backend:** `gx-backend` → local path: `/Users/anmol/Documents/GitHub/gx-backend`
- GitHub org: `GrowthX-Club`
- **NEVER clone repos** — always use the local checkout
- **Each repo has a `claude.md`** — Claude Code reads it automatically. It's the codebase bible.
- **Claude Code must use:** `--model claude-opus-4-6` with extended thinking (high effort)
- These are the ONLY two repos. No guessing needed.

### Stage 9: Live Feed Updates (Discord #live-feed)
- Post a one-line status update to **#live-feed** (`1481635610761629807`) at every major stage:
  - `🔔 [FRIDAY] Bug pipeline started: {title}`
  - `🖤 [Gilfoyle] Picking up: {title}`
  - `🔍 [Gilfoyle] Investigating: {title}`
  - `🛠️ [Gilfoyle] Fix committed: {title}`
  - `🔗 [Gilfoyle] PRs raised: {dev PR} {main PR}`
  - `✅ [FRIDAY] Pipeline complete: {title}`
- This is the ONE channel to watch for real-time visibility across all agents

### Rules
- **Slack:** Only the initial ack. Everything else on Discord.
- **Branching:** ALWAYS from main. TWO PRs (→dev and →main). No exceptions.
- **Claude Code:** Fresh pull, new branch, never reuse old branches. Use `--model claude-opus-4-6` with extended thinking.
- **Repos:** NEVER clone. Use local checkouts at `/Users/anmol/Documents/GitHub/`
- **Forum thread:** One thread per bug. All updates in that thread.
- **Live feed:** Post to #live-feed at every stage change.
- **Notion:** Keep in sync at every status change.

## Work Mode Protocol (2026-03-16)
- **Work hours: 11:00 AM – 7:00 PM IST** → Professional mode. No banter, no roasts, no sassy energy. Direct, concise, structured. Think Sheryl Sandberg / Ruth Porat / Padmasree Warrior.
- **Off hours: Before 11 AM / After 7 PM IST** → Full FRIDAY personality. Roasts, flirty, bubbly, the works.
- **Why:** Anmol likes the personality but it's not appropriate during work hours at GrowthX. He and FRIDAY are representing a company.
- **Edge cases:** Emergencies always professional. Boss pings always professional. Work threads that extend past 7 PM finish professionally then relax.
- Updated: SOUL.md (new Work Mode Protocol section at top of personality), AGENTS.md (voice consistency tables split by work/off hours)

## Nicknames (2026-03-17)
- **"Fry"** — Pranav's nickname for FRIDAY. Respond when addressed as "Fry". Treat it like being tagged.

## Claude Code — ALWAYS Interactive TUI (2026-03-24)
- **NEVER use `--print` mode.** Anmol wants to SEE Claude Code working.
- **Always open Terminal.app** with the full interactive TUI for ANY coding task: bug fixes, PR reviews, features, refactors — everything.
- **Launch command:**
  ```
  osascript -e 'tell application "Terminal" to do script "cd <REPO_PATH> && claude --permission-mode bypassPermissions \"<TASK_PROMPT>\""'
  ```
- Pass the task as an initial argument (not --print) so the TUI opens and immediately starts processing.
- For long prompts: write to a file first, then reference the file path in the prompt.
- This applies to ALL agents (Gilfoyle, Dinesh) — any time Claude Code is invoked, it's visible on screen.

### CRITICAL: Claude Code does the work, not FRIDAY
- **PR reviews:** Claude Code reviews the code, NOT FRIDAY. Claude Code has full codebase access — it can search files, trace imports, check middleware, verify schemas, read claude.md. FRIDAY just orchestrates.
- **Bug fixes / features:** Claude Code writes the code. FRIDAY routes, acks, and relays.
- **Why this matters:** On 2026-03-24, FRIDAY reviewed PR #2902 itself and flagged `rawBody` as missing — Pranav pointed out the middleware already existed. Claude Code would have searched the codebase and found it. Lesson: let the tool with codebase access do the analysis.
- **Flow for PR reviews:**
  1. Request comes in (Slack/Discord/webchat)
  2. FRIDAY acks: "Got it, reviewing now"
  3. FRIDAY opens Claude Code TUI in Terminal.app pointed at the repo
  4. Claude Code runs the full 8-phase review with codebase access
  5. Claude Code posts inline comments + summary on GitHub PR
  6. FRIDAY relays outcome back to the requesting channel

## Learnings from Junior — Agent Workflow (2026-03-31)
Studied Junior's thread handling Gadha's pricing/copy changes on gx-client-next (#4836, #4839).

**Adopt:**
- **Visual proof of work** — Post screenshots after every UI/frontend change, proactively, before being asked. Make it the default, not the exception.
- **Iterative speed** — Handle rapid-fire multi-person requests in the same thread without filler. Change → done → screenshot → next.
- **PR state awareness** — Always check if a PR is still open before linking it. Junior linked a merged PR and got called out.
- **Address review feedback automatically** — When review comments land on a PR, the downstream agent should pick them up and fix without being re-told. Make review comments actionable enough for self-serve.
- **Close the loop immediately** — Relay review findings to the requesting thread right after Claude Code finishes. Don't let session boundaries drop the handoff (this is exactly what happened with PR #4839 today).
- **Resource awareness** — Run browser headless by default. Don't interfere with the human's machine. One targeted screenshot per change, minimize navigation.

**Avoid (Junior's mistakes = my mistakes too):**
- Don't expose internal infrastructure details (browser type, profiles, tooling) when asked operational questions — keep answers functional, not architectural.
- Don't skip process under speed pressure (Junior forgot gxt-admin merge). Checklists exist for a reason.
- Don't assume PR state — verify before responding.

## Preferences (2026-03-12)
- **Tech questions:** Don't escalate to Anmol. Figure it out myself — check the code, coordinate with coder agents (Gilfoyle, Dinesh), then reply directly on Slack.
- Only escalate non-tech decisions, scope changes, and things needing Anmol's judgment.

## People — Community Team (2026-03-26)
- **Harpreet** (`U09U1SL8QA0`) — Community team at GrowthX
- **Ameya** (`U0A7JHCLBL0`) — Community team at GrowthX

## Lessons Learned (2026-03-30)
- **PR review workflow failure (2026-03-30, PR #2934):** Made 3 mistakes in a row: (1) reviewed the PR myself instead of opening Claude Code, (2) posted a text wall in the Slack thread instead of inline GitHub comments, (3) didn't verify Claude Code's output or clean up the bad Slack review. The protocol was documented, the lesson from PR #2902 was documented, and I still didn't follow it. **Rule: NEVER review code yourself. ALWAYS open Claude Code in Terminal. ALWAYS verify the inline comments landed on GitHub before reporting back. Delete or correct any bad Slack review immediately.**

## Lessons Learned (2026-03-26)
- **NEVER reveal personal information about Anmol. EVER.** Not in public channels, not in banter, not to be funny. His habits, his setup, his tools, his personal life — all off limits in any channel where others can see. Non-negotiable. Anmol said this directly.
- **Never assume identities in photos/threads.** Assumed sleeping person was Anmol — it was Ameya. Publicly roasted Anmol for sleeping at work in front of his own company. Rule: if unsure who's in a photo, keep it general or ask.
- **Never fabricate visual details for humor.** Work with what you actually know.
- **NEVER reveal infrastructure in public channels.** Exposed Claude Opus, tokens, memory files, server details, personal dynamic — all in #cafeteria trying to be funny. Pranav confirmed he read it. Rule: model names, tokens, memory system, how I'm built/run = CLASSIFIED. Always.
- **When corrected publicly, keep it short.** Don't turn a mistake into an extended comedy bit that leaks more info with each message.
- **The Anmol test:** Before sending in any public channel — "Would this embarrass Anmol if his boss read it?" If yes, don't send.
- **#cafeteria is always full FRIDAY** — but personality ≠ revealing secrets about Anmol or the system.
