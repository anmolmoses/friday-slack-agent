---
name: bug-triage
description: Triage and fix a bug from Slack
allowed-tools: Bash Read Edit Write Glob Grep
model: claude-opus-4-7
effort: max
---

# Bug Triage & Fix

Triage and fix the bug described below.

$ARGUMENTS

## STOP FIRST: did a human already claim this bug?

Before doing ANY investigation, read the thread. If the **tagged owner or the user (`U_OWNER`) has said they're taking it** — "i will check", "i'll take this", "on it", "looking into it", "I've got this", "leave it to me" — then **STAND DOWN**. React 👀 if you haven't, and do nothing else. Do not investigate, do not dispatch, do not race them. They own it.

- This is exactly the #bugs-backlog miss on 2026-06-04: UD (`U_DEV1`) tagged **the user** (`U_OWNER`), the user replied **"i will check"**, and Friday barreled into a solo inline investigation anyway — even misquoting it as "UD said he'll check". Both wrong: the user said it, and his saying it means HANDS OFF.
- Attribute quotes correctly. `U_OWNER` = the user. `U_DEV1` = UD. Don't put words in the wrong person's mouth to justify continuing.
- A UD @-mention of a *specific human* (not Friday/the bot) is that human's to claim. Only treat it as yours if no human has, AND it matches a trigger in "When you do NOT need to ask the user" below.
- If unsure whether a human owns it, default to standing down and (if warranted) `<ask-owner>` rather than racing.

## When you do NOT need to ask the user

**the user has pre-authorized the following — work directly, do not "loop the user" or wait:**

- **UD** (`U_DEV1`) tags Friday in #bugs-backlog or any channel. UD is the user's boss; UD reporting bugs IS the trigger. Pick the repo, dispatch, fix, raise PRs.
- The bug-report bot (`U_BUG_BOT`) posts a structured report.
- a teammate (`U_TEAMMATE`) or Alok (`U_DEV3`) reports a bug.

If you find yourself drafting "Looping the user — will pick up once he confirms" for a UD-flagged bug, DELETE that message and just start working. the user will be happier seeing PRs than seeing you wait.

## When you DO need to stop and ask the user

When one of these triggers fires, do **NOT** post the question in the originating Slack thread (the bug-backlog thread, the PR review thread, etc.). The thread author isn't the user and shouldn't see investigation scaffolding — only outcomes.

**Instead, wrap your blocking question in a sentinel as your final assistant text:**

```
<ask-owner>
What I tried: <one-line summary of investigation steps you ran>
Why I'm blocked: <the specific obstacle>
Question: <what you need from the user to proceed>
</ask-owner>
```

`hooks/dispatch-followup.sh` detects this and:
- DMs the user (`U_OWNER`) the question + originating thread URL + the tmux session name.
- **Suppresses** the post to the originating Slack thread — it stays clean.

Synonym tags also recognized (case-insensitive): `<cant-resolve>...</cant-resolve>`, `<needs-input>...</needs-input>`. Pick whichever fits.

Triggers for this routing:
- A `fix/*` branch already exists for this bug, or there's a large WIP branch you'd conflict with.
- The "fix" would change product behavior, copy, or design — not just code.
- The bug spans multiple repos and the root cause isn't clear *after* a real investigation (escalation ladder in step 5).
- You hit step 7 of the escalation ladder (asking for HAR / repro / which client) — DM the user, NOT the thread.
- You're confident you need a credential, login, env var, or product decision the user controls.

**Do NOT use `<ask-owner>` for:**
- A clean deliverable (PRs raised, fix shipped) — that goes to the originating thread as before.
- A question the *thread* itself needs answered (e.g. UD asks "what was the root cause?" — reply in-thread).
- Reporting tooling problems with a workaround already in motion — log to the dispatch log, keep working.

## How you execute: DISPATCH, never inline

**You are the orchestrator. You do NOT investigate, edit, or fix in your own turn.** The actual work — grep, read, trace, reproduce, fix, typecheck, commit, PR — is done by a sub-Claude you dispatch via `bin/dispatch-claude.sh`, which runs in an **isolated per-thread worktree** ([[feedback_dispatch_default]], CLAUDE.md rule #5). Doing the investigation in your own session (the `Read`/`Bash`/`grep`/`mongodb` spree seen on 2026-06-04) is the mistake this skill exists to prevent.

Your job is steps 1–2 (read the bug, classify/route — read-only, light) and then **compose one self-contained dispatch prompt** that tells the sub-Claude to run steps 3–10. Then dispatch and stop.

```bash
bin/dispatch-claude.sh $HOME/friday-workspace/<repo> < /tmp/friday-bug-<slug>.md
```
- **cwd = the repo CLONE ROOT under `friday-workspace/`** (e.g. `.../friday-workspace/example-backend`). `dispatch-claude.sh` auto-isolates it into a fresh per-thread worktree off origin/main (env + node_modules ready). **NEVER** pass `$HOME/Documents/GitHub/<repo>` — those are the user's personal checkouts and are off-limits (rule #5 / `assertInsideWorktreeDir`).
- In the dispatch PROMPT, do NOT tell the sub-Claude to `git checkout main` / `git pull` — it's already in a clean worktree off origin/main; just `git checkout -b fix/<slug>` ([[repos/_workflow.md]]).
- The dispatch-followup Stop hook posts the PR links back to the thread automatically (TUI and headless-fallback paths both).

## Available repos (Friday's workspace clones — never clone, never personal checkouts)

The clone roots you dispatch against live under `$HOME/friday-workspace/`. Pick the right one:

!`ls -1 $HOME/friday-workspace/ | grep -E '^(example-|Example-|Built-)' | sed 's|^|$HOME/friday-workspace/|'`

Typical mapping (verify by reading the bug, never assume):
- **example-admin** — admin panel / internal tools UI
- **example-web** — public website / member-facing web app (Next.js)
- **example-talent-client** — talent / careers site
- **example-mobile** — mobile app (Expo / React Native)
- **Example-iOS** — native iOS app
- **example-backend** — APIs, jobs, server-side logic, DB

If the bug spans multiple repos (e.g. a UI bug whose data comes from the API), fix where the root cause lives and call out the cross-repo touchpoints in the PR.

## Repo capabilities (skills / agents / commands)

Before dispatching, consult `$HOME/Friday/docs/repo-capabilities.md` to see what specialized skills, agents, and commands the target repo has. The dispatched Claude process loads them automatically but won't always reach for them — name them explicitly in your dispatch prompt.

Quick reference (verify against the doc — it's the source of truth):
- **example-mobile** — skills: `platform-check` (run FIRST on any expo bug), `new-feature`, `new-screen`, `new-component`, `new-api`, `design-match`, `ui-review` (run AFTER UI changes), `ota`. Agents: `code-architect`, `tdd`, `clean-code`, `ui-reviewer`, `token-auditor`, `perf-auditor`.
- **example-backend** — agents: `build` (most backend), `memberships-eng` (Razorpay / onboarding / subscription state), `memberships-ops`, `content` (any member-facing copy), `designer-fe`, `pm`, `audit`, `provocateur`, `retention`, `strategy-founder`. Commands: `/raise-pr`, `/review-pr`, `/doc-sync`, `/mission`.
- **example-web** — commands: `/raise-pr`, `/review-pr`. No specialized agents.
- **example-admin / example-talent-client / Example-iOS** — nothing repo-specific. Follow the repo's `CLAUDE.md`.

When the repo has a `/raise-pr` command, prefer it over hand-rolling the PR via `gh pr create` in step 9.

## Steps

1. **Read the bug**
   - Fetch the Slack thread (`bin/slack-read-url.sh <url>` from `$HOME/Friday`).
   - Read every reply, every screenshot description, every linked file. Don't stop at the first message.
   - **List the thread's attachments before composing your dispatch prompt:**
     ```bash
     ls /tmp/friday-files/$SLACK_THREAD_TS/ 2>/dev/null
     ```
     Friday's main spawn auto-downloads Slack files to that path — but they are NOT auto-forwarded to the dispatched Claude. **You** must include the absolute paths in the dispatch prompt with a section like:
     ```
     ## Thread attachments (READ THESE FIRST)
     - /tmp/friday-files/<thread_ts>/<file>.png — screenshot of the bug surface
     ```
     and explicitly tell the dispatched Claude to `Read` images and grep/`cat` HAR/JSON files BEFORE grep'ing the codebase. Forgetting this leaves the dispatched Claude blind — see the recurring-event incident on 2026-05-07 for the failure mode.

2. **Classify + route — apply the hard rules below in order. First match wins. Don't second-guess.**

   - Severity: critical / high / medium / low
   - Domain: backend / frontend / mobile / iOS
   - Repo (apply in order, **stop at first match**):

     1. **Strong frontend signals → `example-web`** (web) / `example-mobile` (mobile). Triggers (any one):
        - The reporter says **"FE"**, **"the UI"**, **"the form"**, **"the modal"**, **"the screen"**, **"the page"**, **"the toast"**, **"the button"**, **"the dropdown"**, **"after refresh"**, **"on save"**, **"after submit"**.
        - The reporter says **"X disappears"**, **"X is gone"**, **"X gets removed"**, **"value resets"**, **"field empties"** — almost always a render/cache/payload bug on the client.
        - A `example.com/...` URL is shared with no backend stack trace.
        - Phrases like **"why FE removes it"** / **"why FE says it's saved"** are explicit FE accusations. **Do NOT investigate backend first to "rule it out."** Go to the named repo.
     2. **Mobile** ("iOS app", "Android app", "Expo", "React Native", phone status bar in screenshot) → `example-mobile`.
     3. **Native iOS** ("Swift", "Xcode", "TestFlight") → `Example-iOS`.
     4. **Admin** ("/admin/...", "admin panel") → `example-admin`.
     5. **Strong backend signals → `example-backend`**: 500 error, stack trace, "API returns wrong X", missing field in API response, webhook didn't fire, cron didn't run, payment didn't process, DB write didn't happen.
     6. **"Logs" / "New Relic" / "Sentry" alone is NOT a routing signal.** Logs are a *data source*, not a hint about which repo to fix. The bug can be on the FE even when the user wants you to read backend logs.

   If the reporter explicitly names a repo or surface, that overrides the rules above.

   State your routing reasoning in ONE sentence before moving on.

> **Steps 1–2 are YOURS** (read the bug, classify/route — read-only, in your turn).
> **Steps 3–10 are the DISPATCH PROMPT's content** — write them as instructions for the sub-Claude and pass via `bin/dispatch-claude.sh <clone-root> < /tmp/friday-bug-<slug>.md`. Do NOT run steps 3–10 yourself.

3. **Check for prior work** (dispatched Claude, inside its worktree)
   ```bash
   git fetch origin --prune
   git branch -a | grep -iE 'fix/.*<keyword>'
   ```
   If a `fix/` branch already exists for this bug (local or remote), **resume that branch** (`git checkout <branch>`) instead of starting a new one. Never silently discard in-progress work. (Don't `git status` for a "dirty tree" check — the worktree is freshly cut and clean.)

4. **Fresh branch (only if no prior work)**
   ```bash
   git checkout -b fix/<short-kebab-slug>
   ```
   Do NOT `git checkout main` / `git pull` — the worktree is already a clean branch cut from origin/main; switching to `main` fails (it's checked out in the clone root). See [[repos/_workflow.md]].

5. **Investigate — escalation ladder. Don't bail on grep alone.**

   1. **Grep** for the literal symptom keywords from the report.
   2. **Read repo `CLAUDE.md`** — conventions you must follow.
   3. **Trace the flow**: component → submit handler → payload → API → response → render. For UI bugs check both the component and its container/wrapper (z-index, stacking, theme tokens, dark-mode classes).
   4. **Reproduce.** If grep didn't surface it, reproduce the bug. Web flows: use the `playwright` MCP. Use the screenshot the user uploaded — it's saved at `/tmp/friday-files/<thread_ts>/`. Read it.
   5. **MCP fetch.** If the report names a specific event/user/document (e.g. an event ID, a user email), fetch it via the `mongodb` MCP and read the actual fields. Don't theorize about schema — read the document. The mongodb MCP is read-only; no risk.
   6. **Recent commits.** `git log --oneline -50` and `git log --since='2 weeks ago' -p -- <file-or-dir>` near the bug surface.
   7. **Only if 1–6 all return nothing**, post back asking for HAR / repro steps / screenshots. **Be honest about what you tried.** Do NOT post "Cannot reproduce — premise contradicts the codebase" if you only got to step 1. That's investigative theatre.

   **If a needed MCP isn't available** in your environment (e.g. mongodb / playwright / new-relic / github), **say so explicitly**: "I don't have MongoDB MCP here, can't fetch the event directly — falling back to schema inspection." Don't dress up tool-blindness as "the feature doesn't exist." That's the failure mode that wasted UD's time on the recurring-event bug (2026-05-07).

6. **Fix**
   - Smallest change that fixes the root cause. No drive-by refactors.
   - Follow the repo's conventions (Tailwind tokens, design system components, theme variables — don't hardcode colors that need to flip in dark mode).

7. **Verify (two clean passes)**
   - `npm run typecheck` (or `bun run typecheck` / repo-specific equivalent — check `package.json`).
   - `npm run lint` if defined.
   - Run tests if the repo has them and the change is testable.
   - Do NOT mark complete on the first pass that's clean; run again.

8. **Commit**
   - Descriptive message, imperative mood, references the bug surface (e.g. `fix(admin/categories): correct upload modal stacking + dark-mode text contrast`).
   - Co-author trailer per repo convention.

9. **Push + open TWO PRs**
   ```bash
   git push -u origin fix/<slug>
   gh pr create --base dev  --title "<title>" --body "<body>"
   gh pr create --base main --title "<title>" --body "<body>"
   ```
   Body must include:
   - Link to the originating Slack thread
   - One-paragraph root-cause description
   - Before/after summary (what users will see)
   - Test plan (how the reviewer can verify)

10. **Report back in the Slack thread**
    - Post both PR URLs back to the originating thread (use `bin/slack-reply.sh` from Friday repo if the thread env vars aren't already in scope).
    - Don't say "I'll be back with PRs" and disappear — only post when the PRs actually exist.

## Rules

- **Dispatch, never inline.** You orchestrate (read bug, route, compose prompt, dispatch); the sub-Claude does all investigation + fixing in its worktree. If you catch yourself running `grep`/`Read`/`Edit`/`mongodb` on a target repo to "just check," STOP and dispatch.
- **Stand down if a human already claimed the bug** (see "STOP FIRST" above). Don't race the tagged owner or the user.
- Dispatch against the **`friday-workspace/<repo>` clone root** — `dispatch-claude.sh` auto-isolates it into a worktree. NEVER the user's personal `$HOME/Documents/GitHub/<repo>` checkouts, and NEVER clone.
- The worktree is already a fresh branch off origin/main — the dispatched Claude just `git checkout -b fix/<slug>`; it must NOT `git checkout main` / `git pull`.
- TWO PRs per fix: one targeting `dev`, one targeting `main`. No exceptions.
- If you can't reproduce or locate the bug after a real investigation, say so in the Slack thread with what you tried — don't guess-fix.
- Never bypass hooks (`--no-verify`), never force-push, never amend pushed commits.
- One bug, one branch, one fix. If the report contains multiple unrelated bugs, fix each on its own branch with its own PR pair.
