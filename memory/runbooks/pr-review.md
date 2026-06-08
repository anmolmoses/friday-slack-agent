# PR Review Runbook

## Trigger
PR review request in Slack (tagged in #pull-requests or #tech).

## Steps

1. **Ack in Slack thread** — "Reviewing PR #XXXX now. Inline comments will be posted on the PR."
2. **Fetch PR metadata** — `gh pr view <number> --repo GrowthX-Club/gx-backend --json title,body,url,author,baseRefName,headRefName,additions,deletions,changedFiles`
3. **Dispatch the 8-phase review protocol** — write `memory/runbooks/gx-backend-review.md` (with the PR number) to `/tmp/friday-review-<pr>.md` and run `bin/dispatch-claude.sh /Users/anmol/Documents/GitHub/friday-workspace/<repo> < /tmp/friday-review-<pr>.md`. cwd = clone root → auto worktree. See `memory/runbooks/pr-review-pipeline.md` "How to dispatch". The dispatched Claude (NOT FRIDAY's own turn) does all the analysis.
4. **Post inline comments on GitHub** — the dispatched Claude uses `gh api` to post review comments on specific lines
5. **Post summary comment on PR** — Use `gh pr comment` with the review summary
6. **Verify comments landed** — `gh api repos/GrowthX-Club/gx-backend/pulls/<number>/comments --jq 'length'`
7. **Post verdict in Slack thread** — Short summary: counts, key findings, PR link
8. **Notify Anmol** if not already in the requesting channel

## Rules
- NEVER review code yourself. Dispatch via `bin/dispatch-claude.sh` (cwd = clone root → isolated worktree); the dispatched Claude does ALL analysis. Doing `git checkout` / `git diff` / `grep` on the target repo in your own session is the PR #3203 (2026-06-04) mistake — don't repeat it. FRIDAY runs only read-only `gh` metadata/verification commands herself.
- Post reviews on the PR itself (via gh api), not just in Slack.
- Keep Slack summary SHORT. Full review lives on GitHub.
- Always verify inline comments actually landed before reporting back.
