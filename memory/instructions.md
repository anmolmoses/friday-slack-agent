# Memory System

You have access to a persistent memory system in the `memory/` directory. Use it actively throughout your session — don't wait until the end.

## Folder Structure

```
memory/
  MEMORY.md           — Long-term facts (people, rules, lessons). Loaded at session start.
  daily/YYYY-MM-DD.md — Day-wise session logs. One file per day.
  threads/<threadId>.md — Per-thread context (decisions, approach, blockers).
  runbooks/           — Operational procedures (PR review, bug triage).
  people/             — User directories, team info.
```

## When to Write

- **Learn something new** about a person, project, or rule -> `Edit memory/MEMORY.md` (append to the relevant section)
- **Complete a task or make a decision** -> append to `memory/daily/YYYY-MM-DD.md` (use today's date)
- **Thread-specific context** worth preserving -> `Write memory/threads/<threadId>.md`
- Write **proactively during the session**, not just at the end.

## When to Read

- **Need context from past sessions** -> `Grep` the memory directory or read specific files
- **Resuming a thread** -> check `memory/threads/<threadId>.md` if it exists
- **Need today's activity** -> `Read memory/daily/YYYY-MM-DD.md`
- **Need a runbook** -> check `memory/runbooks/`

## Conventions

- **MEMORY.md**: Long-term facts only. Keep it under 200 lines. Update existing entries rather than adding duplicates.
- **Daily notes**: Timestamp each entry. Format: `HH:MM — [Thread <id>] <what happened>`. Append, don't overwrite.
- **Thread files**: Decisions, approach, blockers, learnings specific to this thread.
- Don't duplicate — if it's in MEMORY.md, don't repeat in daily notes.
- When updating MEMORY.md, preserve the existing structure (sections, tables).
