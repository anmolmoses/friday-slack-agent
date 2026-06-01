# Repo Capabilities

What `.claude/` config exists in each target repo. Use this to dispatch correctly — when Friday spawns a Claude Code process in a target repo, that repo's skills, agents, and commands are loaded automatically. Friday's job is to know which ones exist so it can tell the dispatched process to use them.

**Source of truth is the repo itself.** This doc is a snapshot — re-check `<repo>/.claude/` if something seems off.

---

## gx-client-expo (React Native / Expo)

Path: `/Users/anmol/Documents/GitHub/gx-client-expo`

### Skills (`.claude/skills/`)

| Skill | When to use |
|---|---|
| `design-match` | Compare UI implementation against a design reference (Figma URL or image). Iterates until match. |
| `new-api` | Add a new API endpoint to an existing service or create a new API service class. |
| `new-component` | Create a new UI component with structure, JSDoc, types, NativeWind styling. Args: `<name> [--ui \| --common \| --module <name>]`. |
| `new-feature` | Scaffold a complete feature module — screen, components, hooks, context, API, types, routing, docs. End-to-end. |
| `new-screen` | Scaffold a new screen with route file, module screen component, and navigation wiring. Args: `<module> <screen> [--tab \| --stack \| --modal]`. |
| `ota` | Push an Over-The-Air update via EAS with safety checks (lint, typecheck, env match). |
| `platform-check` | Analyze iOS/Android platform compatibility BEFORE implementing a feature. Run this first on any expo bug/feature. |
| `ui-review` | Review recently changed UI for design system compliance, responsive scaling, platform compat. Run after UI changes. |

### Agents (`.claude/agents/`)

| Agent | When to use |
|---|---|
| `code-architect` | Plan feature architecture (module structure, API services, types, nav, data flow) before implementing. |
| `clean-code` | Post-task sweep for naming, function size, dead code, duplication. Applies safe fixes, flags risky ones. |
| `tdd` | Write failing tests first, then implement to pass. |
| `perf-auditor` | Deep file-by-file React Native performance audit. |
| `token-auditor` | Scan for hardcoded colors, arbitrary pixel values, design token violations. |
| `ui-reviewer` | Design system audit of changed files. |

**Workflows:** [docs/workflows/gx-client-expo/](workflows/gx-client-expo/README.md) — build / bug / PR / OTA playbooks for this repo.

### Friday's dispatch hint
For any expo work, instruct the dispatched process to:
1. Run the `platform-check` skill before writing code if it's a feature/bug touching platform-sensitive APIs.
2. Use `new-feature` / `new-screen` / `new-component` / `new-api` for scaffolding instead of writing from scratch.
3. Run `ui-review` after UI changes.
4. Use `ota` for EAS deploys (never run `eas update` by hand).

---

## gx-backend (Node API / monorepo)

Path: `/Users/anmol/Documents/GitHub/gx-backend`

### Skills
None defined.

### Agents (`.claude/agents/`)

| Agent | When to use |
|---|---|
| `build` | Senior backend engineer. ANY backend feature/bug/audit that does NOT touch memberships state machine, Razorpay, or onboarding transitions. |
| `memberships-eng` | Memberships backend engineer. ANY work touching `UserOnboardingStatus`, `MemberAccountOrAccessStatus`, Razorpay payments, subscription plans, onboarding state transitions, webhooks, scheduled membership tasks, renewal logic. |
| `memberships-ops` | Admin ops dispatch. Translates "member says X" into the correct sequence of API calls. Use for stuck payments, refunds, cohort changes, access fixes. |
| `designer-fe` | Senior product designer + FE eng. Frontend work on memberships flows AND design review on any other feature's frontend. |
| `content` | Brand voice enforcer. ANY member-facing text — copy, emails, notifications, error messages, CTAs. |
| `pm` | Product manager. Planning, iteration plans, prioritization, PROBLEM sections, scope cuts. |
| `audit` | System auditor. Periodic health checks, security/perf reviews, before-milestone audits. Can scope to security/frontend/memberships/db/docs/deps. |
| `provocateur` | Contrarian stress-tester. Use BEFORE big technical/product decisions or when something feels bloated. Proposes, never ships. |
| `retention` | Membership retention/lifecycle marketer. Renewal flows, churn prevention, win-back, lifecycle emails. |
| `strategy-founder` | Strategic advisor. Plan restructuring, pricing, funnel optimization, GTM, A/B test design. |

### Commands (`.claude/commands/`)

| Command | What it does |
|---|---|
| `/raise-pr` | Create a PR and immediately review it (two-step). |
| `/review-pr <#\|url>` | Phase-by-phase PR review. |
| `/doc-sync` | Documentation synchronizer — keeps docs honest. |
| `/mission` | Autonomous experiment loop (Karpathy-style autoresearch). |

### Friday's dispatch hint
- Memberships/Razorpay/onboarding work → route to `memberships-eng`. Other backend → `build`.
- Member-facing copy → `content`. Don't let `build` write copy.
- Before raising a PR, run the repo's `/raise-pr` command instead of hand-rolling the PR description.

---

## gx-client-next (Next.js public site)

Path: `/Users/anmol/Documents/GitHub/gx-client-next`

### Skills
None defined.

### Agents
None defined.

### Commands (`.claude/commands/`)

| Command | What it does |
|---|---|
| `/raise-pr` | Create a PR. |
| `/review-pr <#\|url>` | Phase-by-phase PR review. |

### Friday's dispatch hint
No specialized agents — dispatched process should follow the repo's `CLAUDE.md` and use `/raise-pr` for PRs.

---

## gx-admin-client (Admin panel)

Path: `/Users/anmol/Documents/GitHub/gx-admin-client`

No `.claude/` skills, agents, or commands. Dispatched process follows the repo's `CLAUDE.md`.

---

## gx-talent-client (Talent / careers site)

Path: `/Users/anmol/Documents/GitHub/gx-talent-client`

No `.claude/` skills, agents, or commands. Dispatched process follows the repo's `CLAUDE.md`.

---

## GrowthX-iOS (Native iOS)

Path: `/Users/anmol/Documents/GitHub/GrowthX-iOS`

No `.claude/` skills, agents, or commands. Dispatched process follows the repo's `CLAUDE.md`.

---

## How Friday should use this

When the bug-triage skill picks a target repo, look up that repo here and:

1. **Mention available skills/agents in the dispatch prompt.** The dispatched process needs to know they exist — Claude Code loads them but won't always reach for them. Example: "For this expo bug, run the `platform-check` skill first, then use `ui-review` after your fix."
2. **Route to the right specialized agent.** Memberships work goes to `memberships-eng`, not `build`. Copy goes to `content`. Don't let the dispatched process pick the wrong one by default.
3. **Use repo commands for cross-cutting workflows.** `/raise-pr` and `/review-pr` exist in `gx-backend` and `gx-client-next` — use them instead of the bug-triage skill's hand-rolled `gh pr create` flow when working in those repos.

If a repo's capabilities have changed since this snapshot, update this file. To re-inventory:
```bash
for repo in /Users/anmol/Documents/GitHub/{gx-*,GrowthX-*}; do
  echo "=== $(basename $repo) ==="
  ls "$repo/.claude/skills" "$repo/.claude/agents" "$repo/.claude/commands" 2>/dev/null
done
```
