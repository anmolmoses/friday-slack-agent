# Review a PR — gx-client-expo

This repo has **no `/review-pr` or `/raise-pr` command** (unlike gx-backend). Friday hand-rolls the review with `gh` and the repo's own agents.

## 1. Pull the PR

```bash
gh pr view <#|url> --json title,body,files,additions,deletions
gh pr diff <#|url>
```

## 2. Check against the repo's critical rules

Read the diff against `gx-client-expo/CLAUDE.md`. Flag any of these:

- **API access** — axios/fetch called from a component instead of a `lib/api/` service.
- **Imports** — relative paths (`../../`) or barrel imports instead of `@/` direct imports.
- **Types** — missing `I`/`T`/`E` prefixes; props not destructured in the signature.
- **Styling** — arbitrary pixels (`text-[15px]`, `p-[12px]`) instead of auto-scaling classes; raw `scaleSize()` omissions on icons.
- **Theme** — hardcoded colors instead of theme variables.
- **Architecture** — business logic in `app/` route files instead of delegating to a module; cross-module imports that break self-containment.
- **Component shape** — arrow-function components (should be `function` declarations); internals out of the required order.

## 3. Run the specialist agents on the change

- **`ui-reviewer`** — design-system audit of changed UI (the agent form of the `ui-review` skill).
- **`token-auditor`** — hardcoded colors / arbitrary spacing / token violations.
- **`perf-auditor`** — if the PR touches lists, heavy renders, images, or socket/db code.

## 4. Verify it builds

```bash
pnpm lint
npx tsc --noEmit
```

If the PR changes platform-sensitive behavior, sanity-check the **`platform-check`** findings still hold.

## 5. Verdict

Post a structured review: **blockers** (must fix before merge), **non-blocking** (nits/follow-ups), and a clear ship / no-ship call. Follow the build → review → fix → re-review loop; escalate to Pranav after 3 rounds of unresolved blockers (per CLAUDE.md origin notes).
