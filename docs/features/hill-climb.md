# Hill-climbing — Friday's Loop 4

The outer loop in the [loop-engineering](https://www.langchain.com/blog/the-art-of-loop-engineering)
stack. Loops 1–3 run Friday's work (agent / verification / event-driven); **Loop 4
reads the traces of finished runs and proposes improvements to the harness config
itself** — the "return arrow that reaches inside and updates the agent loop directly."

For Friday that harness is: `memory/runbooks/`, `.claude/agents/*.md`, the dispatch
conventions in `memory/runbooks/repos/_workflow.md`, `CLAUDE.md` rules, and the
guards/scripts in `bin/`. Every fix made by hand this far (turbo stripping env, the
`/api/v1` prefix, the dead-end-menu correction) was *manual* hill-climbing — a human
noticed a recurring failure and edited a doc. This automates that.

## How it works

```
finished run ──► hooks/dispatch-followup.sh ──► (detached)
                   ├─ memory-extraction  → saves a FACT to recall
                   └─ hill-climb analyze  → proposes a CHANGE to the harness
                                             → memory/harness-proposals/pending/<id>.md
                                             → DMs Anmol
```

- **Per-run** (`bin/hill-climb.ts analyze <transcript>`): a bounded, fully-fenced
  sub-agent reads one finished transcript. Under a **strict gate** (most runs yield
  nothing) it files a proposal only when the run exposed a *generalizable* harness gap
  — a process gap, a repeated mistake, a missing guardrail, a wrong/missing doc, or an
  Anmol correction about *how* to operate. It explicitly does **not** duplicate plain
  memory facts (that's memory-extraction's job) and won't restate what's already in the docs.
- **Cross-run** (`bun run hill-climb scan`, cron): mines the last ~10 daily notes +
  the pending queue for patterns that recur ≥2× — the recurring-blocker detector that
  `proactive-protocols.md` always wanted. Files a "systemic" proposal.

## Human-in-the-loop (by design)

Nothing auto-edits behavior-changing config. Every proposal waits for your call:

```bash
bun run hill-climb list           # pending proposals
bun run hill-climb show <id>      # read one (signal · evidence · proposed change · why it compounds)
bun run hill-climb apply <id>     # a sub-agent implements the exact edit → moves to applied/
bun run hill-climb reject <id> "reason"
```

A proposal names ONE `target` harness file, a `risk` tier (`doc` / `behavior` / `code`),
a `confidence`, the triggering evidence, and a surgical proposed edit. `apply` spawns a
sub-agent that makes exactly that edit (and updates the MEMORY.md/index pointer when the
convention applies).

## Safety / fences

- The analyze/scan/apply sub-agents run with `FRIDAY_DISABLE_FOLLOWUP=1` +
  `FRIDAY_DISABLE_MEMORY_EXTRACT=1` and a scrubbed env, so they can't re-enter the
  dispatch-followup machinery (the same fence memory-extraction uses).
- `ANTHROPIC_API_KEY` is stripped → stays on the Max subscription.
- Opt out of the per-run pass with `FRIDAY_DISABLE_HILL_CLIMB=1`.

## Status

Built + verified 2026-06-19: the per-run analyze correctly returns `NO_PROPOSAL` when a
run's lesson is already captured (no spam), and files a well-formed, surgical proposal
when fed a novel harness gap; `show` / `apply` / `reject` lifecycle works. Wired into
`hooks/dispatch-followup.sh`. `scan` cron cadence: weekly suggested (not yet installed).
