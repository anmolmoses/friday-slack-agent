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

## When to stop and ask Anmol

Some situations require Anmol's call before you write code. Whenever you hit one, do BOTH of these — don't pick one:

1. **Reply in the originating Slack thread** with the situation, the options, and what you're doing while you wait (e.g. "holding until I hear back").
2. **DM Anmol directly** at user ID `U0AKP5PAWEB` so he sees it outside the thread:
   ```bash
   bin/slack-dm.sh U0AKP5PAWEB "<short summary + link to thread + the question>"
   ```
   Always include the originating Slack thread URL in the DM so he can jump straight there.

Triggers that require this:
- A `fix/*` branch already exists (local or remote) for this bug, or there's a large WIP branch in the same area that a main-based fix would conflict with or duplicate.
- The bug surface spans multiple repos and it's not obvious where the root cause lives.
- The "fix" would require changing product behavior, copy, or design, not just code.
- You can't reproduce or locate the bug after a real investigation.

Don't quietly pick a path when one of these triggers fires.

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

2. **Classify**
   - Severity: critical / high / medium / low
   - Domain: backend / frontend / mobile / iOS
   - Pick the target repo from the list above based on concrete signals in the report (UI surface, error stacks, URLs, mentioned screens). State your reasoning in one sentence before moving on.

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

5. **Investigate**
   - Read the repo's `CLAUDE.md` (if present) before touching code — it encodes conventions you must follow.
   - Trace the bug to its root cause. Read the surrounding code, not just the line that looks wrong.
   - For UI bugs: identify the actual component file, check both the component and its container/wrapper for layering (z-index, stacking context) and theme tokens (dark mode classes / CSS vars).

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
