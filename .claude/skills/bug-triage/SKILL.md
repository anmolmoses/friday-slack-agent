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

## When you do NOT need to ask Anmol

**Anmol has pre-authorized the following — work directly, do not "loop Anmol" or wait:**

- **UD** (`U01AG6F9W69`) tags Friday in #bugs-backlog or any channel. UD is Anmol's boss; UD reporting bugs IS the trigger. Pick the repo, dispatch, fix, raise PRs.
- The bug-report bot (`U0ANDM5M62Z`) posts a structured report.
- Pranav (`U03PNSJ33S5`) or Alok (`U04U7RS55PS`) reports a bug.

If you find yourself drafting "Looping Anmol — will pick up once he confirms" for a UD-flagged bug, DELETE that message and just start working. Anmol will be happier seeing PRs than seeing you wait.

## When you DO need to stop and ask Anmol

When one of these triggers fires, do **NOT** post the question in the originating Slack thread (the bug-backlog thread, the PR review thread, etc.). The thread author isn't Anmol and shouldn't see investigation scaffolding — only outcomes.

**Instead, wrap your blocking question in a sentinel as your final assistant text:**

```
<ask-anmol>
What I tried: <one-line summary of investigation steps you ran>
Why I'm blocked: <the specific obstacle>
Question: <what you need from Anmol to proceed>
</ask-anmol>
```

`hooks/dispatch-followup.sh` detects this and:
- DMs Anmol (`U0AKP5PAWEB`) the question + originating thread URL + the tmux session name.
- **Suppresses** the post to the originating Slack thread — it stays clean.

Synonym tags also recognized (case-insensitive): `<cant-resolve>...</cant-resolve>`, `<needs-input>...</needs-input>`. Pick whichever fits.

Triggers for this routing:
- A `fix/*` branch already exists for this bug, or there's a large WIP branch you'd conflict with.
- The "fix" would change product behavior, copy, or design — not just code.
- The bug spans multiple repos and the root cause isn't clear *after* a real investigation (escalation ladder in step 5).
- You hit step 7 of the escalation ladder (asking for HAR / repro / which client) — DM Anmol, NOT the thread.
- You're confident you need a credential, login, env var, or product decision Anmol controls.

**Do NOT use `<ask-anmol>` for:**
- A clean deliverable (PRs raised, fix shipped) — that goes to the originating thread as before.
- A question the *thread* itself needs answered (e.g. UD asks "what was the root cause?" — reply in-thread).
- Reporting tooling problems with a workaround already in motion — log to the dispatch log, keep working.

## Available repos (LOCAL — never clone)

All product repos live under `/Users/anmol/Documents/GitHub/`. Pick the right one:

!`ls -1 /Users/anmol/Documents/GitHub/ | grep -E '^(gx-|GrowthX-)' | sed 's|^|/Users/anmol/Documents/GitHub/|'`

Typical mapping (verify by reading the bug, never assume):
- **gx-admin-client** — admin panel / internal tools UI
- **gx-client-next** — public website / member-facing web app (Next.js)
- **gx-talent-client** — talent / careers site
- **gx-client-expo** — mobile app (Expo / React Native)
- **GrowthX-iOS** — native iOS app
- **gx-backend** — APIs, jobs, server-side logic, DB

If the bug spans multiple repos (e.g. a UI bug whose data comes from the API), fix where the root cause lives and call out the cross-repo touchpoints in the PR.

## Repo capabilities (skills / agents / commands)

Before dispatching, consult `/Users/anmol/Documents/GitHub/Friday/docs/repo-capabilities.md` to see what specialized skills, agents, and commands the target repo has. The dispatched Claude process loads them automatically but won't always reach for them — name them explicitly in your dispatch prompt.

Quick reference (verify against the doc — it's the source of truth):
- **gx-client-expo** — skills: `platform-check` (run FIRST on any expo bug), `new-feature`, `new-screen`, `new-component`, `new-api`, `design-match`, `ui-review` (run AFTER UI changes), `ota`. Agents: `code-architect`, `tdd`, `clean-code`, `ui-reviewer`, `token-auditor`, `perf-auditor`.
- **gx-backend** — agents: `build` (most backend), `memberships-eng` (Razorpay / onboarding / subscription state), `memberships-ops`, `content` (any member-facing copy), `designer-fe`, `pm`, `audit`, `provocateur`, `retention`, `strategy-founder`. Commands: `/raise-pr`, `/review-pr`, `/doc-sync`, `/mission`.
- **gx-client-next** — commands: `/raise-pr`, `/review-pr`. No specialized agents.
- **gx-admin-client / gx-talent-client / GrowthX-iOS** — nothing repo-specific. Follow the repo's `CLAUDE.md`.

When the repo has a `/raise-pr` command, prefer it over hand-rolling the PR via `gh pr create` in step 9.

## Steps

1. **Read the bug**
   - Fetch the Slack thread (`bin/slack-read-url.sh <url>` from `/Users/anmol/Documents/GitHub/Friday`).
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

     1. **Strong frontend signals → `gx-client-next`** (web) / `gx-client-expo` (mobile). Triggers (any one):
        - The reporter says **"FE"**, **"the UI"**, **"the form"**, **"the modal"**, **"the screen"**, **"the page"**, **"the toast"**, **"the button"**, **"the dropdown"**, **"after refresh"**, **"on save"**, **"after submit"**.
        - The reporter says **"X disappears"**, **"X is gone"**, **"X gets removed"**, **"value resets"**, **"field empties"** — almost always a render/cache/payload bug on the client.
        - A `growthx.club/...` URL is shared with no backend stack trace.
        - Phrases like **"why FE removes it"** / **"why FE says it's saved"** are explicit FE accusations. **Do NOT investigate backend first to "rule it out."** Go to the named repo.
     2. **Mobile** ("iOS app", "Android app", "Expo", "React Native", phone status bar in screenshot) → `gx-client-expo`.
     3. **Native iOS** ("Swift", "Xcode", "TestFlight") → `GrowthX-iOS`.
     4. **Admin** ("/admin/...", "admin panel") → `gx-admin-client`.
     5. **Strong backend signals → `gx-backend`**: 500 error, stack trace, "API returns wrong X", missing field in API response, webhook didn't fire, cron didn't run, payment didn't process, DB write didn't happen.
     6. **"Logs" / "New Relic" / "Sentry" alone is NOT a routing signal.** Logs are a *data source*, not a hint about which repo to fix. The bug can be on the FE even when the user wants you to read backend logs.

   If the reporter explicitly names a repo or surface, that overrides the rules above.

   State your routing reasoning in ONE sentence before moving on.

3. **Check for prior work**
   ```bash
   cd /Users/anmol/Documents/GitHub/<repo>
   git fetch origin --prune
   git branch -a | grep -iE 'fix/.*<keyword>'
   git status
   ```
   If a `fix/` branch already exists for this bug (local or remote) or the working tree has uncommitted changes related to it, **resume that branch** instead of starting a new one. Never silently discard in-progress work.

4. **Fresh branch (only if no prior work)**
   ```bash
   cd /Users/anmol/Documents/GitHub/<repo>
   git checkout main && git pull origin main
   git checkout -b fix/<short-kebab-slug>
   ```

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

- Repos are LOCAL. NEVER clone. Use `/Users/anmol/Documents/GitHub/<repo>`.
- Always branch from `main`, fresh from `origin/main`.
- TWO PRs per fix: one targeting `dev`, one targeting `main`. No exceptions.
- If you can't reproduce or locate the bug after a real investigation, say so in the Slack thread with what you tried — don't guess-fix.
- Never bypass hooks (`--no-verify`), never force-push, never amend pushed commits.
- One bug, one branch, one fix. If the report contains multiple unrelated bugs, fix each on its own branch with its own PR pair.
