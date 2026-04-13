---
name: review-pr
description: Review a pull request using the 8-phase protocol
allowed-tools: Bash(git *) Bash(gh *) Read Glob Grep
model: claude-opus-4-6
effort: high
---

# PR Review — 8-Phase Protocol

Review PR $ARGUMENTS following this protocol. Execute each phase before posting comments.

## Current PR Context

Changed files:
!`gh pr diff $ARGUMENTS --name-only 2>/dev/null || echo "Provide a PR number as argument"`

## Phase 1: Understand Context
- `gh pr view <number> --json title,body,labels,headRefName,baseRefName,additions,deletions,files`
- Determine PR type: fix/ = Bug Fix, feat/ = Feature, refactor/chore/docs = Maintenance
- Extract intent: what problem does this solve?

## Phase 2: Read Full Diff + Surrounding Code
- `gh pr diff <number>` — read every changed file
- For each changed file, read surrounding code for context
- Trace data flow: route -> middleware -> service -> CRUD -> database

## Phase 3: Scoping & Completeness
- Does the PR fully implement what it claims?
- Are edge cases handled? (empty inputs, missing data, concurrent access, partial failures)
- For bug fixes: root cause or band-aid?

## Phase 4: Product Thinking
- Does this solve the user's problem?
- Missing: empty states, boundary transitions, notifications, rollback?
- Permissions mismatch?

## Phase 5: Business Logic
- Trace logic end-to-end. Correct for normal + edge cases?
- Authorization middleware correct?
- Data integrity — transactions where needed?

## Phase 6: Query Performance
- N+1 queries? Missing projections? Unbounded queries?
- Index support? Aggregation pipeline efficiency?

## Phase 7: Code Quality
- Bugs, type safety, copy-paste errors, unused code
- Does it follow existing patterns?

## Phase 8: Post Review
- Post inline comments via `gh api` with severity tags
- Post summary comment via `gh pr comment`
- Severity: critical (must fix), warning (should fix), suggestion (nice to have)
