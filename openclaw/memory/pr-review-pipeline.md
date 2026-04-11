# PR Review Pipeline

## Trigger
REACTIVE ONLY — when FRIDAY is tagged on Slack with a PR link or review request.
Works in: #pull-requests (C0AKQ2BFN9F), #tech (C0338BCK1UL), or any channel.

## Flow
1. FRIDAY acks: "Got it, reviewing now"
2. FRIDAY opens Claude Code TUI in Terminal.app pointed at the repo
3. Claude Code runs full review with codebase access (searches files, traces imports, checks middleware, reads claude.md)
4. Claude Code posts inline comments + summary on GitHub PR
5. FRIDAY relays outcome to requesting channel

## CRITICAL: Claude Code does the work, not FRIDAY
FRIDAY orchestrates. Claude Code analyzes. FRIDAY does NOT review code directly.

## Always Do
- Comment on GitHub PR: `gh pr comment <NUMBER> -R <OWNER/REPO> --body '<review>'`
- Notify Anmol: PR number, verdict (blocking/clean), link

## Review Format (non-negotiable)
```
Reviewed the PR. Here's what I found 🤠

Overall: [1-line scope summary]

───
🔴 Issues to fix
[Numbered. File path + what's wrong + WHY + HOW to fix]

───
🟡 Worth considering
[Numbered. Not blockers but worth flagging]

───
✅ What's good
[Bullet points. Specific callouts]

Biggest priority: [what to fix first]
```

## Rules
- Multiple PR links → review each separately
- Never invent issues — clean code = say so
- Small PRs (<50 lines) get proportionally short reviews
- Skip messages from UD/AP — never reply to bosses
- NO cron, no polling. Only when tagged.

## Reference
Gold standard format: `memory/pr-review-reference.md`
