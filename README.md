<div align="center">

<h1>friday</h1>

<b>A Slack-native control plane for <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a>.</b>

<p>
<i>One Slack thread → one Claude session · worktree-isolated · agent-routed<br/>
two-brain routing · voice control · associative memory · a live dashboard<br/>
runs on your Claude subscription — no API keys, no usage billing</i>
</p>

[![License](https://img.shields.io/badge/license-MIT-22c55e?style=for-the-badge)](LICENSE)
![Tests](https://img.shields.io/badge/tests-324%20passing-22c55e?style=for-the-badge)
![Bun](https://img.shields.io/badge/Bun-1.x-000000?style=for-the-badge&logo=bun&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=for-the-badge&logo=typescript&logoColor=white)
![Slack](https://img.shields.io/badge/Slack-Socket%20Mode-4A154B?style=for-the-badge&logo=slack&logoColor=white)
![No API keys](https://img.shields.io/badge/API%20keys-none-8b5cf6?style=for-the-badge)

</div>

---

Most "AI in Slack" bots are a thin wrapper around a chat completion. **`friday` is
the opposite.** She owns the *lifecycle* of real [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
sessions: every Slack thread spawns a short-lived `claude -p` subprocess with its
own conversation state, its own git worktree, its own MCP tools, and its own
agent persona — then streams the work back into the thread as it happens.

> She authenticates through the **Claude Max subscription you already pay for** —
> the CLI runs as a child process, so there are no API keys and no usage-based
> billing. One process per message turn; `--resume` carries the context forward.

```bash
bun install
cp .env.example .env        # fill in Slack tokens + your owner user ID
bun run dev                 # start the bot (Socket Mode)
# → DM the bot, or @mention it in a thread
```

→ **[SETUP.md](SETUP.md)** — full step-by-step install guide (~30 min).

---

## ✨ What she does

| | |
|---|---|
| 🧵 **Thread = session** | Each Slack thread maps to one isolated Claude Code session. Messages mid-run are **buffered, never interrupted**, then drained as a combined prompt — no corrupted session state. |
| 🌳 **Worktree-per-thread** | Any thread touching a repo gets its own git worktree, so concurrent PR reviews / builds across projects never collide on git state. A disk-pressure LRU reaper purges clean worktrees automatically. |
| 🧠 **Two-brain routing** | A fast conversational brain handles chat; coding work is dispatched to Claude in a detached session that posts its result — and any blocking questions — straight back to the thread. |
| 🗺️ **Agent routing** | Loads agent definitions (build, review, frontend, architect, pm) and picks the right persona per task, sharing the conventions a sub-agent needs so it doesn't repeat known mistakes. |
| 📡 **Stream-to-Slack** | Parses `stream-json` events (tool_use, text, result) and posts incremental status as the session works — you watch it think, not just the final answer. |
| 🎙️ **Voice route** | Talk to Friday and she drives your Mac — local VAD, OpenAI Realtime, vision-grounded clicking, AI-decided actions. Fully separate from the Slack path. |
| 🪟 **Live dashboard** | A built-in web dashboard: active threads, running tools, process tree, worktrees, logs, and a neuron-style memory visualiser — all from localhost, zero external services. |
| 🧩 **Associative memory** | An optional [engram](https://github.com/anmolmoses/engram-memory) bridge gives her ranked, explainable recall over everything she's written — three-tier salience, emotion-scaled decay, and a "dream" consolidation cycle. Fails soft when absent. |
| 🔌 **Per-thread MCP** | Each thread is scoped to its own `--mcp-config`, so tool surfaces are isolated per conversation. |
| 🧱 **Swappable infra** | Session store, persistence, and notification layers are provider/factory patterns — in-memory for dev, Redis for production. |

---

## 🏗️ Architecture

```
Slack Event API (message.channels, app_mention)
        │
        ▼
  Bot server (Bun / TypeScript)
        │
        ├─ Session Manager  ── Map<thread_id, session>   (buffer / drain state machine)
        ├─ Claude Spawner   ── claude -p --resume --output-format stream-json
        ├─ Worktree Manager ── git worktree per thread + disk-pressure reaper
        ├─ Agent Router     ── load .claude/agents, pick persona, share conventions
        ├─ Stream → Slack   ── tool_use / text / result → incremental thread updates
        └─ HTTP Dashboard   ── live threads, processes, worktrees, memory graph
```

One short-lived process per message turn. The process exits after responding;
the session map (thread → session) is the single source of truth for whether a
thread is idle or busy, its session id, and its pending messages.

---

## 📂 Layout

| Path | What's there |
|---|---|
| `src/slack/` | Event handling, routing, formatting, vibes-channel lint |
| `src/session/` | The buffer/drain state machine + spiral/ragebait guards |
| `src/claude/` | Spawn `claude -p`, build CLI args, parse `stream-json` |
| `src/worktree/` | Create/reap per-thread worktrees |
| `src/agents/` | Load + route agent definitions |
| `src/codex/` | The conversational brain + dispatch-to-Claude bridge |
| `src/voice/` | Voice daemon, Realtime client, Mac control, HUD |
| `src/memory/` | Salience gate, decay, emotion tagging, engram bridge |
| `src/http/` | The live dashboard server + API |
| `.claude/agents/` | Friday's own agent personas (build, review, frontend, architect, pm) |

---

## 🔧 Requirements

- **[Bun](https://bun.sh)** ≥ 1.x
- **[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)** authenticated with a Claude Max account
- A **Slack app** with Socket Mode enabled

```bash
bun test          # 324 tests
bun run typecheck # strict tsc, no emit
```

## 📜 License

MIT.
