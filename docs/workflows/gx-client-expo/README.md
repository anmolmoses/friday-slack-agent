# gx-client-expo — Friday's Workflows

Per-repo playbook for **gx-client-expo** (the GrowthX React Native / Expo mobile app). These are Friday's workflows — how she *orchestrates* work here: which agent to dispatch, which skills to tell the dispatched process to run, in what order, and what gates must pass before a PR or a ship.

- **Repo path (Friday's clone):** `/Users/anmol/Documents/GitHub/friday-workspace/gx-client-expo` — Friday works her own clone, never Anmol's checkout. See [friday-workspace.md](../../features/friday-workspace.md).
- **Stack:** Expo SDK 54 · file-based routing (`app/`) · NativeWind/Tailwind (auto-scaled) · TypeScript (strict `I`/`T`/`E` prefixes) · modular `modules/` + centralized `lib/api/`
- **Capabilities snapshot** (skills/agents the dispatched process can use): [../../repo-capabilities.md#gx-client-expo-react-native--expo](../../repo-capabilities.md)

## Workflows

| Workflow | When |
|---|---|
| [build-feature.md](build-feature.md) | New feature, screen, component, or API integration |
| [fix-bug.md](fix-bug.md) | Fixing a bug in the app (incl. bug-triage dispatches) |
| [pr-review.md](pr-review.md) | Reviewing a PR (no `/review-pr` command exists here — hand-rolled) |
| [release-ota.md](release-ota.md) | Shipping JS-only changes via EAS Over-The-Air |

## Non-negotiable gates (every workflow inherits these)

1. **`platform-check` skill runs first** on any feature/bug touching platform-sensitive APIs (camera, push, calendar, secure-store, sockets, file system). It catches iOS/Android divergence before code is written.
2. **`ui-review` skill runs after any UI change** — design-system compliance, responsive scaling, platform compat.
3. **Ship JS-only changes only via the `ota` skill.** Never run `eas update` by hand. `ota` is `disable-model-invocation: true`, so it must be invoked *explicitly* — it will not auto-trigger.
4. **Green before PR:** `pnpm lint` and `npx tsc --noEmit` both pass.
5. **No `/raise-pr` here.** Unlike gx-backend, this repo has no PR commands — Friday/the agent hand-rolls `gh pr create`.

## Dispatch quick-reference

| Need | Skill / agent (in gx-client-expo) | Args |
|---|---|---|
| Plan a feature's architecture | agent `code-architect` | — |
| Whole feature module | skill `new-feature` | `<feature-name> [description]` |
| New screen + route wiring | skill `new-screen` | `<module> <screen> [--tab \| --stack \| --modal]` |
| New component | skill `new-component` | `<name> [--ui \| --common \| --module <name>]` |
| New API endpoint/service | skill `new-api` | `<service> <method> [endpoint-path]` |
| Match UI to a design | skill `design-match` | `[figma-url or description]` |
| Review changed UI | skill `ui-review` / agent `ui-reviewer` | — |
| Token violations | agent `token-auditor` | — |
| Perf audit | agent `perf-auditor` | — |
| Post-task cleanup | agent `clean-code` | — |
| Test-first | agent `tdd` | — |
| OTA deploy | skill `ota` | `[message] [--branch preview\|production] [--platform ios\|android\|all]` |

> Source of truth is the repo's own `.claude/` and `CLAUDE.md`. If a skill/agent here drifts, re-inventory and update [repo-capabilities.md](../../repo-capabilities.md).
