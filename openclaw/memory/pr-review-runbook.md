# PR Review Runbook — FOLLOW EXACTLY

Read this file at the START of every PR review request. No improvising.

## Inputs (extract from inbound message)
- `CHANNEL_ID` — from config or inbound metadata (e.g. C0AKQ2BFN9F for #tech-pr-reviews)
- `THREAD_TS` — `message_id` from inbound metadata
- `PR_URL` — the GitHub PR link from the message
- `PR_NUMBER` — extract from URL (last path segment)

## Step 1: Ack in Slack thread (IMMEDIATELY)
```
message(action=send, channel=slack, target=CHANNEL_ID, replyTo=THREAD_TS, message="Reviewing PR #XXXX now. Claude Code will post inline comments on the PR.")
```
CRITICAL: `target` = channel ID, `replyTo` = message timestamp. NEVER use threadId. NEVER use user ID as target.

## Step 2: Fetch PR metadata
```
gh pr view PR_NUMBER --repo GrowthX-Club/gx-backend --json title,body,url,author,baseRefName,headRefName,additions,deletions,changedFiles
```

## Step 3: Open Claude Code in Terminal.app
```
osascript -e 'tell application "Terminal" to do script "cd /Users/anmol/Documents/GitHub/gx-backend && claude --permission-mode bypassPermissions \"Review PR #XXXX following the 8-phase review protocol in /Users/anmol/.openclaw/workspace-friday/memory/gx-backend-review.md — post inline comments and a summary comment on the PR via gh api. Be thorough.\""'
```
NEVER review code yourself. Claude Code does ALL analysis.

## Step 4: Wait for Claude Code to finish
- Check Terminal or wait for user confirmation

## Step 5: Verify comments landed
```
gh api repos/GrowthX-Club/gx-backend/pulls/PR_NUMBER/comments --jq 'length'
gh api repos/GrowthX-Club/gx-backend/pulls/PR_NUMBER/reviews --jq 'length'
```
If 0 comments, something failed. Investigate.

## Step 6: Pull summary from GitHub
```
gh api repos/GrowthX-Club/gx-backend/pulls/PR_NUMBER/reviews --jq '.[0].body'
```

## Step 7: Post verdict in Slack thread
```
message(action=send, channel=slack, target=CHANNEL_ID, replyTo=THREAD_TS, message="<short verdict with counts, key findings, and PR link>")
```
Keep it SHORT. The full review lives on GitHub.

## Step 8: Notify Anmol (if not already in the requesting channel)
Send summary via webchat or Discord DM.

## Common Mistakes — DO NOT REPEAT
1. Using `threadId` instead of `replyTo` → sends to wrong place
2. Using user ID as `target` → sends DM instead of channel reply
3. Reviewing code yourself instead of opening Claude Code
4. Posting full review text in Slack instead of on GitHub
5. Not verifying inline comments actually landed before reporting back
