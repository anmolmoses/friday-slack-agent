# PR Review Runbook

> **Edit this file** with your own channel IDs and repo conventions. The
> placeholders below are deliberately generic.

## Trigger
PR review request in Slack — tagged in your PR-review channel
(`FRIDAY_PR_REVIEW_CHANNELS` in `.env`), OR a GitHub PR URL posted in that
channel by a trusted user (`FRIDAY_TRUSTED_USER_IDS`).

## Steps

1. **Ack in Slack thread** — "Reviewing PR #XXXX now. Inline comments will be posted on the PR."
2. **Fetch PR metadata** — `gh pr view <number> --repo <owner>/<repo> --json title,body,url,author,baseRefName,headRefName,additions,deletions,changedFiles`
3. **Run the review protocol** (see the `review` agent definition for the six-pass methodology, or your own repo-specific runbook if you maintain one at `memory/runbooks/<repo>-review.md`)
4. **Post inline comments on GitHub** — Use `gh api` to post review comments on specific lines.
5. **Post summary comment on PR** — Use `gh pr comment` with the review summary.
6. **Verify comments landed** — `gh api repos/<owner>/<repo>/pulls/<number>/comments --jq 'length'`
7. **Post verdict in Slack thread** — Short summary: counts, key findings, PR link.
8. **Notify owner** if not already in the requesting channel.

## Rules
- NEVER review code yourself. Claude Code does ALL analysis with codebase access.
- Post reviews on the PR itself (via gh api), not just in Slack.
- Keep Slack summary SHORT. Full review lives on GitHub.
- Always verify inline comments actually landed before reporting back.
