# openclaw/ — your persona files go here

This whole directory is **gitignored** (except this README). Each developer
brings their own MD files; nothing here is shared via git.

## What lives here

Friday loads these at startup. All are optional — she boots fine without
any of them, just with no personality / memory.

| File | Purpose |
|---|---|
| `IDENTITY.md` | One-paragraph identity card — name, role, signature emoji, voice |
| `SOUL.md` | Full persona — personality, voice, behavior rules, tone calibration |
| `AGENTS.md` | The agent squad and dispatch rules (when Friday delegates to a sub-agent) |
| `USER.md` | Who YOU are — context, preferences, goals; helps Friday be personal not generic |
| `TOOLS.md` | Local tools, scripts, conventions — stuff that's true on YOUR machine |

## How they're loaded

`src/persona.ts` reads these files in order and concatenates them into the
system prompt for every Claude turn. The loader is fault-tolerant: if a
file is missing, it's silently skipped.

## Suggested order to write them

1. `IDENTITY.md` — one paragraph. "I am FRIDAY. I work with <name>. I sound like <voice cue>."
2. `USER.md` — who you are, what you care about, how you like to be talked to.
3. `SOUL.md` — flesh out the personality. Longer, more detailed.
4. `AGENTS.md` — only when you have multiple agent definitions in `.claude/agents/` you want Friday to know about.
5. `TOOLS.md` — only when there are local scripts / quirks worth telling Friday about.

## Why "openclaw"?

Historical — Friday is the successor to an earlier OpenClaw-based agent
system, and the persona file names carried over. Feel free to rename the
directory if you maintain your own fork; just update the path constants in
`src/persona.ts`.
