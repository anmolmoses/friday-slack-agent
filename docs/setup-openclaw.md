# Setting Up Friday for OpenClaw

This guide covers how to set up and run Friday (the Claude Code Slack bot) alongside or as a replacement for your existing OpenClaw agent system.

---

## What This Is

Friday is a Slack bot that acts as the control plane for Claude Code sessions. It's the successor to the OpenClaw-based agent system — same role (FRIDAY the orchestrator), rebuilt on **Claude Code CLI as a subprocess** instead of OpenClaw.

When a Slack message arrives in a thread, the bot either spawns a new `claude -p` CLI process or routes the message to an existing session. Each thread gets its own isolated session with its own worktree, skills, and MCP config.

**Key architectural choice:** CLI subprocess (`claude -p`), not SDK. The CLI authenticates via Max subscription — no API keys, no usage-based billing.

---

## Prerequisites

- **Bun** runtime installed (`curl -fsSL https://bun.sh/install | bash`)
- **Claude Code CLI** on your PATH and authenticated via Max subscription
- A **Slack App** with Socket Mode enabled (you already have one if you're running OpenClaw with Slack)
- Your existing **OpenClaw config** at `~/.openclaw/openclaw.json`

---

## Step 1: Clone & Install

```bash
git clone <your-friday-repo-url> ~/your/path/Friday
cd ~/your/path/Friday
bun install
```

---

## Step 2: Create `.env`

```bash
cp .env.example .env
```

Fill in values — most come from your existing `~/.openclaw/openclaw.json`:

| Env Var | Source | Example |
|---|---|---|
| `SLACK_BOT_TOKEN` | `openclaw.json` → `channels.slack.botToken` | `xoxb-...` |
| `SLACK_APP_TOKEN` | `openclaw.json` → `channels.slack.appToken` | `xapp-...` |
| `SLACK_SIGNING_SECRET` | Slack App settings (api.slack.com → your app → Basic Information) | `abc123...` |
| `CLAUDE_MAX_TURNS` | Max Claude turns per message (default: 25) | `25` |
| `CLAUDE_TIMEOUT_MS` | Process timeout in ms (default: 300000 = 5 min) | `300000` |
| `REPOS` | JSON array of repos Friday manages (see below) | `[{...}]` |
| `SESSION_STALE_TIMEOUT_MS` | Stale session timeout (default: 86400000 = 24h) | `86400000` |
| `SESSION_CLEANUP_INTERVAL_MS` | Cleanup interval (default: 900000 = 15 min) | `900000` |
| `REDIS_URL` | Optional — in-memory store if not set | `redis://localhost:6379` |

### REPOS format

Point to whatever repos your agents build in:

```json
REPOS=[{"name":"your-backend","path":"~/Projects/your-backend","defaultBase":"origin/main"},{"name":"your-frontend","path":"~/Projects/your-frontend","defaultBase":"origin/main"}]
```

---

## Step 3: Verify Claude CLI

The bot spawns `claude -p` as a child process. Ensure it's available:

```bash
which claude        # should return a path
claude --version    # should print version
```

If not installed, see: https://docs.anthropic.com/en/docs/claude-code

---

## Step 4: Run

```bash
# Development (hot reload)
bun run dev

# Production
bun run start

# Type check
bun run typecheck
```

---

## How It Maps to OpenClaw

| OpenClaw (current) | Friday (this repo) |
|---|---|
| `~/.openclaw/openclaw.json` | `.env` + `src/config.ts` |
| SOUL.md / IDENTITY.md define personality | `.claude/agents/*.md` agent definitions |
| OpenClaw handles Slack, Discord, Telegram | **Slack only** (Bolt Socket Mode) |
| OpenClaw's LLM runtime (gpt-5.x models) | Spawns `claude -p` CLI (Max subscription auth) |
| `~/.openclaw/workspace-friday/` | Bot runs from this repo; worktrees in **target repos** |
| Agent-to-agent via `openclaw.json` `agentToAgent` | Claude Code `--resume` + worktrees |
| Heartbeat polling | Claude Code hooks and cron |
| `agents/friday/agent/` config | `.claude/agents/` markdown definitions |

### What carries over

- **Agent squad concept** — FRIDAY orchestrates, sub-agents (Gilfoyle, Dinesh) code
- **Personality system** — port SOUL.md / IDENTITY.md content into `.claude/agents/` definitions
- **Build → Review loop** — build via agent → push → review → fix → ship

### What changes

- No SOUL.md / AGENTS.md / TOOLS.md — replaced by CLAUDE.md + `.claude/agents/`
- No heartbeat polling — replaced by Claude Code hooks
- Agent dispatch uses `--resume` and git worktrees
- **Discord and Telegram are not supported** — Slack only
- Agent definitions live in target repos' `.claude/agents/`, not in this repo

---

## Running Alongside OpenClaw

If you run both simultaneously on the same Slack channels, **both will respond to messages**. Options:

1. **Disable FRIDAY's Slack in OpenClaw** — set `channels.slack.enabled: false` in `openclaw.json`, use this bot instead
2. **Different channels** — run this bot on test channels while OpenClaw handles production
3. **Gradual migration** — route specific channels to this bot via Slack event subscriptions

---

## Thread Commands

Once running, use these in Slack threads:

| Command | Description |
|---|---|
| `!status` | Show current session state |
| `!reset` | Reset the thread session |
| `!repo <name>` | Switch target repo for this thread |
| `!build` | Spawn build agent in target repo |
| `!review` | Spawn review agent |
| `!quiet` / `!verbose` | Toggle status update verbosity |

---

## Persona

Friday loads persona from `~/.openclaw/workspace-friday/SOUL.md` and `IDENTITY.md` if they exist. If not found, it falls back to a default persona. To customize, edit those files in your OpenClaw workspace or create new agent definitions in `.claude/agents/`.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Missing required env var: SLACK_BOT_TOKEN` | Check `.env` exists and has the token |
| `claude: command not found` | Install Claude Code CLI, ensure it's on PATH |
| Bot doesn't respond in Slack | Verify Socket Mode is enabled in Slack App settings |
| Bot responds but Claude errors out | Check `claude --version` works, Max subscription is active |
| Duplicate responses (OpenClaw + Friday) | Disable one system's Slack integration |
