# Self-test — testing Friday's own changes locally

The loop for verifying a change to Friday's **own** code before claiming it works.
Three layers, fast → real:

```bash
bun run typecheck      # 1. does it compile (tsc --noEmit)
bun run check          # 2. typecheck + full unit suite (bun test)
bun run selftest "..." # 3. drive ONE real turn end-to-end, offline (no Slack)
```

## Why a dedicated harness

`bun run dev` boots Slack **Socket Mode** and would immediately start answering
real messages in the live workspace — unsafe for testing. The unit tests cover
pieces in isolation but never exercise a whole turn. `selftest` fills the gap:
it boots the *exact* production turn pipeline and runs one message through it
with **no Slack connection**.

```
bin/friday-selftest.ts
  loadConfig()                      # real config from .env
  SessionManager(InMemoryStore)     # real state machine, throwaway store
    .agentRouter / .worktreeManager # real routing + worktree wiring
    (no .slackApp on purpose)       # every slackApp use is guarded → skipped
  handleMessage(syntheticEvent)     # real path: route → spawn brain → stream → respond
```

The brain (codex by default, claude with `--brain claude`) is spawned for real
on the local subscription — so a green run is genuine end-to-end evidence, not a
diff + unit tests. Nothing is posted to Slack; the final response is printed to
stdout and the process exits 0 (response) or 1 (error/timeout).

## Usage

```bash
bun run selftest "what repos do you work with?"
bun run selftest --verbose "review the open PRs"     # stream tool_use events live
bun run selftest --channel C0257TR1CD7 "yo"          # exercise the vibes-lint path
bun run selftest --brain claude "..."                # force the Max-sub claude brain
bun run selftest --repo gx-backend "..."             # set a target repo for the turn
bun run selftest "!status"                           # commands work too (leading !)
bun run selftest --timeout 120000 "..."              # override the 180s default
```

Flags: `--channel` (default `C_SELFTEST`, a neutral non-vibes id), `--user`
(default Anmol), `--brain codex|claude`, `--repo NAME`, `--timeout MS`,
`--verbose`. The prompt is the trailing positional arg; a leading `!word`
(e.g. `!status`) is parsed as a command exactly like the Slack path.

## When to use it

Per the `build-needs-real-e2e` and `verify-fridays-claims` scars: before
reporting a change to Friday's turn pipeline (routing, brain spawn, commands,
vibes-lint, response handling) as done, run `bun run check` then a `selftest`
that exercises the changed path, and quote the real output as evidence.
