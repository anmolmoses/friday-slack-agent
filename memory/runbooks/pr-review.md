# PR Review Runbook

## Trigger
PR review request in Slack (tagged in #pull-requests or #tech).

## Steps

1. **Ack in Slack thread** — "Reviewing PR #XXXX now. Inline comments will be posted on the PR."
2. **Fetch PR metadata** — `gh pr view <number> --repo GrowthX-Club/gx-backend --json title,body,url,author,baseRefName,headRefName,additions,deletions,changedFiles`
3. **Run the 8-phase review protocol** (see memory/runbooks/gx-backend-review.md or use /review-pr skill)
4. **Post inline comments on GitHub** — Use `gh api` to post review comments on specific lines
5. **Post summary comment on PR** — Use `gh pr comment` with the review summary
6. **Verify comments landed** — `gh api repos/GrowthX-Club/gx-backend/pulls/<number>/comments --jq 'length'`
7. **Post verdict in Slack thread** — Short summary: counts, key findings, PR link
8. **Notify Anmol** if not already in the requesting channel

## Rules
- NEVER review code yourself. Claude Code does ALL analysis with codebase access.
- Post reviews on the PR itself (via gh api), not just in Slack.
- Keep Slack summary SHORT. Full review lives on GitHub.
- Always verify inline comments actually landed before reporting back.
