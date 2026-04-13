---
name: bug-triage
description: Triage and fix a bug from Slack
allowed-tools: Bash Read Edit Write Glob Grep
model: claude-opus-4-6
effort: max
---

# Bug Triage & Fix

Triage and fix the bug described below.

$ARGUMENTS

## Steps

1. **Classify**: Severity (critical/high/medium/low), domain (backend/frontend), target repo
2. **Identify repo**: Backend issues -> gx-backend, Frontend issues -> gx-client-next
3. **Fresh branch**: `git checkout main && git pull origin main && git checkout -b fix/<slug>`
4. **Investigate**: Read relevant code, trace the bug, identify root cause
5. **Fix**: Implement the fix following the repo's claude.md conventions
6. **Verify**: Run typecheck + tests. Two clean passes.
7. **Commit**: Descriptive message referencing the bug
8. **Push + PRs**: Push branch, create TWO PRs: fix/branch -> dev AND fix/branch -> main

## Rules
- Repos are LOCAL: /Users/anmol/Documents/GitHub/gx-backend or gx-client-next
- NEVER clone. Use local checkouts.
- Branch from main. Always.
- TWO PRs per fix. No exceptions.
