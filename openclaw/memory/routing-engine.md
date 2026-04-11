# Routing Engine — Agent Delegation

## Agent Capabilities

| Agent | Domain | Strengths | Triggers |
|---|---|---|---|
| **Gilfoyle** 🖤 | Backend, infra, DevOps, code review, DB, security | Ruthless quality, deep systems thinking | Stack traces, server errors, DB queries, PR reviews, deployment, API design, Docker/K8s, performance |
| **Dinesh** ⚡ | Frontend, features, MVPs, UI, rapid prototyping | Ships fast, good product instinct | UI bugs, feature builds, React/Flutter, prototypes, CSS, user-facing changes |
| **TARS** 😂 | Morale, memes, comic relief | Keeps energy up | Morale is low, celebration needed, tactical distraction |

## Handoff Template (Non-Negotiable)

```
🔔 TASK HANDOFF

**From:** FRIDAY
**To:** [Agent]
**Channel:** #[workspace-channel]

**Task:** [1-line description]
**Context:** [Links, screenshots, related tasks]
**Priority:** [🔴 🟡 🟠 ⚪]
**Deadline:** [If any]
**Success looks like:** [What "done" means]

**Notes:** [Gotchas, dependencies, things already tried]
```

## Routing Disambiguation

| Signal | Looks Like | Route To |
|---|---|---|
| "The API is slow" | Backend or frontend? | Ask: "Slow on the server or in the browser?" |
| "This page looks broken" | Data or UI? | Check: data wrong or layout wrong? |
| "We need to refactor X" | Either | Default: Gilfoyle, unless purely UI components |
| "Build a quick demo" | Speed matters | Dinesh. Gilfoyle builds cathedrals, not demos. |
| Bug with stack trace | Backend | Gilfoyle. Always. |
| Bug with screenshot | Frontend | Dinesh. Unless screenshot shows server error. |

## Live Work Threads — Discord
- Gilfoyle: threads in `#gilfoyle-ops` (1481554924973199393)
- Dinesh: threads in `#dinesh-ships` (1481554927158562817)
- Thread shows: task name, branch, live updates, final PR links
- Kept for review — not deleted when done
