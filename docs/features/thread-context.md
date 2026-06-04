# Thread Context & Claude Instance Awareness

## Problem

When Friday spawns a `claude -p` process, that process has zero knowledge of the Slack conversation it's responding to. It doesn't know its own name, can't see prior messages in the thread, can't see images users shared, and has no way to send files back. `--resume` gives Claude its own conversation history, but not the Slack thread's.

**Who has this problem:** Every spawned Claude instance — they respond in a vacuum without thread context.
**Painful part:** Without context, Claude hallucinates thread history, doesn't recognize other bots' messages, and gives generic responses to thread-specific questions.
**"Finally" moment:** Claude knows it's Friday, sees the full thread history (including images), and can upload screenshots back to Slack.

## What It Does

Before every Claude spawn, the session manager builds a prompt preamble with:

1. **Identity** — Friday's persona (SOUL.md + IDENTITY.md from `~/.openclaw/workspace/`)
2. **Bot user ID** — so Claude recognizes its own messages in thread history
3. **Channel & thread metadata** — channel name, thread_ts, with instruction not to search Slack
4. **Thread history** — all prior messages fetched via `conversations.replies`, labeled by role
5. **Image attachments** — downloaded to `/tmp/friday-files/<threadId>/`, paths appended to prompt
6. **Historical file annotations** — `[shared image: filename.png]` in thread history

## Architecture

```
Slack message arrives
    │
    ▼
SessionManager.handleMessage()
    │
    ├── buildPromptPreamble()          ← thread-context.ts
    │     ├── loadPersona()            ← persona.ts (cached after first load)
    │     ├── resolveChannelName()     ← cached per channel
    │     └── fetchThreadHistory()     ← conversations.replies API
    │
    ├── downloadSlackFiles()           ← files.ts (images only)
    │
    ▼
prompt = preamble + file paths + user message
    │
    ▼
spawnClaude(session, prompt, config, cwd, botToken)
    │
    env: SLACK_CHANNEL, SLACK_THREAD_TS, SLACK_BOT_TOKEN
    │
    ▼
Claude can upload files back via bin/slack-upload.sh
```

## Key Files

| File | Purpose |
|---|---|
| `src/slack/thread-context.ts` | Builds prompt preamble: identity, channel metadata, thread history |
| `src/persona.ts` | Loads SOUL.md + IDENTITY.md from openclaw workspace (cached) |
| `src/slack/files.ts` | Downloads Slack image attachments to local disk |
| `src/slack/events.ts` | Extracts file attachments from Slack events |
| `src/claude/spawner.ts` | Passes SLACK_CHANNEL/THREAD_TS/BOT_TOKEN env vars |
| `bin/slack-upload.sh` | Uploads files to Slack thread (uses env vars) |
| `.mcp.json` | Playwright MCP for browser automation (screenshots) |

## Prompt Structure

Every Claude spawn receives a prompt shaped like:

```
<identity>
# IDENTITY.md - Who Am I?
- Name: Friday
- Vibe: Witty but direct. Indiana Jones Jr. energy.
...

# SOUL.md — Friday
[full persona: core truths, communication style, failure signals, decision rules]

Your Slack user ID is U12345. Messages from this user ID in the thread are yours.
</identity>

<slack-context>
Channel: #eng-bots (C0123ABC)
Thread: 1773749331.950109
You are responding in this thread. You already have the full thread history below.
Do NOT use Slack search or read tools to find this thread.
</slack-context>

<thread-context>
User(U678): can you review the auth middleware?
Friday (you): Sure, I'll take a look.
User(U901): [shared image: screenshot.png] here's what I see
</thread-context>

The user shared images. They are saved at these paths — use the Read tool to view them:
- /tmp/friday-files/1773749331.950109/screenshot.png

[actual user message here]
```

## Design Decisions

### Persona from openclaw workspace, not hardcoded
SOUL.md has 130+ lines of calibrated behavioral rules refined over months. Loading it preserves the full personality without maintaining a duplicate.

### Thread context fetched server-side, not via MCP
The orchestrator already has the bot token and thread_ts. Fetching via `conversations.replies` is one API call. Giving Claude a Slack MCP tool would add latency (Claude has to search for the thread) and token waste (20+ MCP calls observed in testing).

### Channel name cached
`resolveChannelName()` caches channel ID → name to avoid repeated API calls for messages in the same channel.

### Identity matching by user_id only
Slack's `bot_id` field is on ALL bot messages, not just ours. Only `m.user === botUserId` correctly identifies Friday's messages. Other bots (Friday, Doraemon) show as regular users in thread context.

### Image files downloaded to /tmp
Images are downloaded with the bot token as auth, saved to `/tmp/friday-files/<threadId>/`. Claude can `Read` these files natively. Only image MIME types (png, jpeg, gif, webp) are downloaded.

### Env vars for outbound Slack access
Spawned Claude processes get `SLACK_CHANNEL`, `SLACK_THREAD_TS`, `SLACK_BOT_TOKEN` as env vars. This lets `bin/slack-upload.sh` work without any configuration — Claude just runs the script.

## Browser Automation

Playwright MCP gives Claude browser tools: navigate, click, scroll, type, screenshot. The workflow for sharing what it sees:

1. Claude takes screenshot via Playwright MCP → saves to file
2. Claude runs `bin/slack-upload.sh /tmp/screenshot.png "Here's what I found"`
3. Image appears in the Slack thread

**Authenticated browsing (gated pages).** The Playwright MCP runs `--headless` against a *persistent* profile at `~/.friday/browser-profile` (pinned in `src/claude/mcp-config.ts`, the per-thread config Friday's spawned `claude -p` actually uses — NOT just root `.mcp.json`). Cookies/SSO sessions survive between spawns, so once the profile is logged in, Friday can open GX-Team-gated Notion pages, Google Docs, and internal tools instead of bouncing in a redirect loop. A headless browser can't do an interactive SSO login, so log in once with `bun run browser-login` (headed; `bin/browser-login.ts`) and re-run whenever a session expires. Only one Chromium can hold the profile at a time — don't run the login while the bot is mid-browse.

**Native Notion.** Set `NOTION_TOKEN` in Friday's env to an internal-integration token and share the relevant pages with that integration; `generateMcpConfig` then adds a `notion` MCP server for structured (non-scraped) reads. Google Docs/Drive/Gmail are covered by the persistent browser login; a dedicated Google connector (OAuth) is an optional follow-up.

## Message Deduplication

Slack fires both `message` and `app_mention` for @mentions in threads. Without dedup, the same message gets processed twice (first spawns Claude, second gets buffered and drained as a duplicate). Fixed with a `Set<string>` keyed on message `ts` in `SessionManager.handleMessage()`.

## Vibes-Channel Anti-Spiral Guardrails

Background — the Prickle thread (#cafeteria, 2026-04-01) saw Friday spiral across ~20 self-deprecating posts chasing Pranav's bait. Operational rules in the system prompt are necessary but not sufficient: when the model over-talks anyway, the post path enforces the cap.

Three layers, all keyed on `isVibesChannel(channel)` (`src/slack/routing.ts` — currently `#cafeteria` and `#fridaytest`):

### 1. Stronger vibes prompt fragment

`hintPromptFragment("vibes", …)` in `src/slack/routing.ts` injects:

- **Exactly ONE Slack message per turn.** No double-posts, no fake `[6:45 PM]` timestamps, no simulated continuations.
- **Hard cap: 3 lines.** Anything longer gets truncated server-side.
- A reminder that the Prickle thread is the canonical scar and the spiral IS the bait.

### 2. Pre-send lint (`src/slack/vibes-lint.ts`)

`lintVibesResponse(text)` runs in `index.ts onResponse` before the responder posts. It:

- Truncates anything past 3 non-empty lines down to the first paragraph block.
- Flattens multi-message intent — drafts with triple-newlines, fake timestamps (`[6:45 PM]`-style), or `(continued)` markers get cut at the first such break.
- Logs `[vibes-lint]` warnings with reason codes (`triple-newline`, `fake-timestamp`, `continuation-marker`, `line-cap(N>3)`).

Work channels (PR review, bug triage, build threads) are NOT subject to the lint — they routinely produce 4–10 line replies on purpose.

### 3. Spiral detector & ragebait protocol (`src/session/spiral.ts`)

Per-thread state on `ThreadSession`:

- `spiralScore: number` — increments when Friday's outgoing reply contains markers like `pathetic`, `i'm done`, `friday out`, `not taking the bait`, `don't @ me`, `goodnight`, `for real this time`, `i'll be quiet`. Decays −1 per clean turn (floor 0). When ≥2, the next turn's prompt gets a `## ⚠️ SPIRAL DETECTED` injection: single line max, zero self-deprecation, zero meta-commentary. If no non-spiral line exists, return `NO_SLACK_MESSAGE`.

- `recentJabs: RagebaitJab[]` — non-Anmol vibes-channel messages that look like ragebait (Friday-references like `friday`, `SOUL.md`, `therapy folder` paired with bait tokens like `liar`, `prove it`, `show me`, `the bin`, `nepo hire`, `cope`, or repeated card/image attachments). When ≥3 jabs from the same user inside 15 minutes, the next turn's prompt gets a `## 🛑 RAGEBAIT MODE` injection: one reply per their message, max one line, no escalation.

Both signals are checked in `SessionManager.runClaudeWithAgent` and prepended above the existing routing-hint fragment. State updates happen in `handleMessage` (jabs) and `onRunComplete` (spiral score).
