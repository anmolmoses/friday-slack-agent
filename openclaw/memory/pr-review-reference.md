# PR Review Reference — Gold Standard Format

Saved 2026-03-14. Anmol approved this as the template for how Gilfoyle should analyze PRs on Slack.

## Format

1. **Opening** — one-line vibe check + scope summary (files changed, lines added/removed)
2. **🔴 Issues to fix** — actual bugs, accessibility violations, hydration issues, things that WILL break. Numbered. Each one explains the problem AND the fix.
3. **🟡 Worth considering** — not blockers but worth flagging. Design decisions that might have unintended side effects, repetitive patterns, CI impact, migration concerns.
4. **✅ What's good** — acknowledge solid work. Specific callouts, not generic "looks good". Reference actual patterns, utilities, test coverage.
5. **Closing** — prioritize: what to fix first, what's polish.

## Quality Bar

- **Be specific** — file paths, line references, actual code patterns
- **Explain WHY** — not just "this is wrong" but "this breaks because X, fix by doing Y"
- **Catch real issues** — accessibility violations, hydration mismatches, CI performance impact, branch hygiene
- **Notice patterns** — repetitive code that should be abstracted, mixed migrations, scope creep in PRs
- **Give credit** — call out good patterns by name, don't just rubber-stamp

## Example (Anmol-approved)

```
Reviewed the PR. Here's what I found 🤠

Overall: Good scope, solid patterns, a few things to flag.

220 files, +2284/-867 — that's a serious pass. The approach is consistent and the test coverage (Playwright mobile projects + visual audit) is a nice touch.

───

🔴 Issues to fix

1. maximum-scale=1 in viewport meta (pages/_app.tsx) — this disables pinch-to-zoom, which is a WCAG 1.4.4 accessibility violation. Users with low vision need to zoom. Remove maximum-scale=1, keep the rest.
2. useMediaQuery hydration mismatch (hooks/useMediaQuery.ts) — initializes with useState(false), so SSR always renders "desktop" and then flashes to mobile on client hydration. In Next.js this causes a hydration mismatch warning and visible layout flash. Fix: either use useLayoutEffect + check typeof window, or initialize from window.matchMedia in a lazy initializer, or suppress SSR rendering for mobile-only components.
3. Branch name mismatch — branch is fix/dark-mode-audit but PR is "mobile-first responsive dashboard". Not a blocker but will confuse git log/bisect later.

───

🟡 Worth considering

4. Base font-size change affects desktop too (styles/globals.css) — changed html { font-size: 110% } to 100% base with 110% at min-width: 768px. This means 768px-wide desktop windows (common when split-screening) now get smaller text. Intentional?
5. Repetitive text-[12px] sm:text-[11px] pattern — appears ~40+ times across files. Consider a Tailwind utility class (e.g. text-detail via @apply) to reduce repetition and make future changes easier.
6. Playwright mobile projects run on ALL tests — the config adds iPhone SE/14/iPad Air projects globally. This 4x's test runtime in CI. Consider either gating mobile projects behind an env flag or only running mobile-specific spec files on mobile projects.
7. MUI → Tailwind migration mixed in — EventCard.tsx and EventActions.tsx replace MUI sx props and variant="contained" with Tailwind. Good cleanup, but verify RoundedButton actually accepts bare className without the MUI props — if it's still an MUI wrapper, dropping variant/fullWidth/endIcon could break styling.

───

✅ What's good

• Consistent hover: → active: pattern for touch — tedious but necessary
• useBreakpoint hook is clean and reusable
• 44px touch targets on pagination/buttons
• Mobile card view for tables, bottom sheets for dialogs
• no-scrollbar and line-clamp utilities
• Fixing 21 pre-existing TS errors while at it
• touch: Tailwind variant is a nice addition
• Test coverage: visual audit spec with touch target + text size heuristics is 👨‍🍳💋

Biggest priority: fix #1 (accessibility) and #2 (hydration). Rest is polish.
```

## Anti-patterns (what NOT to do)

- ❌ "LGTM" with no detail
- ❌ Nitpicking formatting/whitespace when there are real bugs
- ❌ Listing issues without explaining the fix
- ❌ Ignoring what's good — reviews should motivate, not just criticize
- ❌ Missing accessibility, performance, and CI impact — these are table stakes
- ❌ Generic "looks good overall" without referencing specific patterns
