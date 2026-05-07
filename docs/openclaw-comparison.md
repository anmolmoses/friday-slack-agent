# OpenClaw vs Friday: Gap Analysis & Port Strategy

> **Purpose:** Compare OpenClaw's capabilities with Friday's current state. Identify what's missing, what can be ported, and what needs building fresh — focused on **tool calling**, **memory**, and **caching**.
>
> **Context:** OpenClaw requires API keys (provider-based billing). Friday uses Claude Code CLI with Max subscription auth (no API keys, no per-token cost). This means we can't use OpenClaw directly, but we can port its patterns and adapt them to the CLI subprocess model.

---

## Table of Contents

1. [Architecture Comparison](#1-architecture-comparison)
2. [Tool Calling: Gap Analysis](#2-tool-calling-gap-analysis)
3. [Memory: Gap Analysis](#3-memory-gap-analysis)
4. [Caching: Gap Analysis](#4-caching-gap-analysis)
5. [Claude Code Native Capabilities](#5-claude-code-native-capabilities)
6. [What to Port from OpenClaw](#6-what-to-port-from-openclaw)
7. [What to Build Fresh](#7-what-to-build-fresh)
8. [What to Skip](#8-what-to-skip)
9. [Revised Implementation Roadmap](#9-revised-implementation-roadmap)

---

## 1. Architecture Comparison

| Dimension | OpenClaw | Friday |
|---|---|---|
| **Runtime model** | Always-on gateway (WebSocket control plane, port 18789) with embedded Pi Agent runtime | Node.js/Bun Slack bot, spawns short-lived `claude -p` subprocesses |
| **Auth** | API keys (Anthropic, OpenAI, etc.) — usage-based billing | Claude Code CLI with Max subscription — no API keys, no per-token cost |
| **AI execution** | Agent runtime embedded in gateway, calls provider APIs directly | CLI subprocess (`claude -p`), Claude handles all model calls internally |
| **Tool calling** | Built-in typed tool system — tools defined in code, invoked by model via function calling | Delegated to Claude Code — Claude has its own tools (Read, Edit, Bash, etc.), Friday has no tool layer |
| **Memory** | Markdown files on disk (MEMORY.md, daily notes, dreaming system), vector search via embeddings | Thread context from Slack history + persona injection (SOUL.md/IDENTITY.md). No persistent memory across threads |
| **Caching** | Prompt caching (Anthropic API), tool result caching, browser snapshot caching | None. Each `claude -p` call builds context from scratch. `--resume` provides conversation continuity but no caching |
| **Channels** | 20+ (Slack, Discord, Telegram, WhatsApp, Teams, Matrix, Signal, iMessage, etc.) | Slack only (by design — focused scope) |
| **Multi-agent** | Multiple named agents with isolated workspaces, inter-agent messaging | Agent definitions (.claude/agents/) with persona selection, but single Claude process per turn |
| **Session persistence** | SQLite/in-memory session store with full conversation history | In-memory Map (thread_id -> session). No conversation history persistence beyond `--resume` |
| **Configuration** | Unified JSON config (openclaw.json) with agents, channels, tools, providers, bindings | Env vars + TypeScript config. Agent definitions in markdown. |

### Key Architectural Constraint

Friday spawns `claude -p` as a subprocess. This means:
- **We don't control the model call.** Claude Code handles its own tool invocation, prompt construction, and model communication.
- **We can't inject tools into Claude's tool list at the API level.** We can only: (a) pass MCP servers via `--mcp-config`, (b) append system prompt instructions via `--append-system-prompt`, (c) provide context in the prompt itself.
- **We can't intercept tool calls mid-execution.** We can only observe them via `stream-json` events after they happen.

This constraint shapes everything below. Where OpenClaw has direct API-level control over tool calling and caching, Friday must work through the CLI's available flags and MCP protocol.

---

## 2. Tool Calling: Gap Analysis

### What OpenClaw Has

OpenClaw has a comprehensive three-layer tool system:

**Layer 1: Tools (Foundation)**
Typed function definitions sent to the model API. The model generates a tool call, OpenClaw validates and routes it.

| Tool | What It Does |
|---|---|
| `exec` | Shell commands (foreground/background, PTY mode, sandbox/gateway/node routing) |
| `browser` | Chrome automation via Playwright/CDP (snapshot, click, type, drag, state management) |
| `web_search` | Search via Brave/Perplexity |
| `web_fetch` | HTTP requests with timeout/proxy |
| `message` | Send messages across channels (Slack, Discord, etc.) with threading and media |
| `session_status` | Query current time, session info, runtime status |
| `memory_search` | Hybrid vector + keyword search over memory files |
| `image_generate` | Image generation via providers |
| `video_generate` | Video generation (ComfyUI workflows) |
| `music_generate` | Music generation |

**Layer 2: Skills (Instruction Layer)**
Markdown files injected into system prompt that teach the model *when and how* to use tools. Not executable code — behavioral guidance.

**Layer 3: Plugins (Containers)**
Packages that bundle tools, skills, channels, providers together. Plugin SDK with 200+ subpaths.

**Tool Execution Pipeline:**
1. Model generates tool call with parameters
2. Gateway validates tool availability against allow/deny lists
3. Routes to execution context (sandbox, gateway, node, browser)
4. Approval workflow can intercept high-impact operations
5. Result returned to model; streaming supported
6. Tool profiles (`full`, `minimal`, custom) control capability levels per agent

### What Friday Has

Friday currently has **no tool layer of its own**. It relies entirely on Claude Code's built-in tools:

| Claude Code Built-in | Equivalent OpenClaw Tool |
|---|---|
| Bash | `exec` |
| Read, Edit, Write | (file operations within `exec`) |
| Grep, Glob | (search within `exec`) |
| Agent (subagents) | (no direct equivalent — OpenClaw uses inter-agent messaging) |
| MCP tools (Playwright) | `browser` |

**What's missing:**
1. **Custom tool definitions** — No way to register Friday-specific tools (Slack messaging, Notion API, GitHub operations) that Claude can call
2. **Tool routing/validation** — No allow/deny lists, no approval workflows, no execution context routing
3. **Cross-channel messaging** — Claude can't send Slack messages from within a session (it would need an MCP server or tool for this)
4. **Memory search** — No tool for Claude to search Friday's memory during a session
5. **External API tools** — No Notion, no web search, no image generation accessible to Claude

### Gap Summary: Tool Calling

| Capability | OpenClaw | Friday | Gap |
|---|---|---|---|
| Shell execution | `exec` with sandboxing | Claude's `Bash` tool | Partial — no sandboxing, but adequate |
| Browser automation | `browser` (Playwright/CDP) | MCP Playwright server | **Covered** via `--mcp-config` |
| File operations | Via `exec` | Claude's Read/Edit/Write/Grep/Glob | **Covered** — Claude's tools are better scoped |
| Slack messaging from session | `message` tool (native) | **Missing** — Claude can't post to Slack mid-session |
| Memory search | `memory_search` (vector + keyword) | **Missing** — no memory system to search |
| Web search | `web_search` (Brave/Perplexity) | **Missing** — not available in CLI by default |
| Web fetch | `web_fetch` | **Missing** — no HTTP tool |
| Notion/external APIs | Via plugins | **Missing** |
| Tool allow/deny lists | Per-agent config | **Missing** — all Claude tools available |
| Approval workflows | Gateway-level interception | **Missing** — no approval step |
| Tool profiles | `full`, `minimal`, custom | **Missing** |

---

## 3. Memory: Gap Analysis

### What OpenClaw Has

OpenClaw's memory is file-based and transparent:

**Memory Files:**
| File | Purpose | Loaded When |
|---|---|---|
| `MEMORY.md` | Long-term durable facts, preferences, learned patterns | Every session start |
| `memory/YYYY-MM-DD.md` | Daily notes — session logs, observations, context | Today's + yesterday's auto-loaded |
| `DREAMS.md` (experimental) | Consolidation summaries from dreaming system | Session start |

**Memory Mechanisms:**

1. **Auto-flush before compaction** — When conversation context approaches the limit, a silent turn reminds the agent to save important context to memory files before compaction happens. This prevents context loss.

2. **Hybrid search** — With embedding provider configured, `memory_search` tool uses vector similarity + keyword matching to retrieve relevant memories. The agent can actively search its own memory during a session.

3. **Dreaming system** (experimental) — Periodic consolidation pass that:
   - Scores short-term signals (daily notes)
   - Promotes qualified items to long-term memory (MEMORY.md) via weighted scoring gates
   - Creates DREAMS.md consolidation summaries
   - Operators can tune recall decay and inspect promotion decisions

4. **Standing orders** — Persistent instructions injected into every session. These are different from memory — they're behavioral directives, not facts.

5. **Session memory hook** — `session-memory` internal hook that handles memory loading/saving at session boundaries.

**What makes it work:**
- Memory is plain markdown. The agent reads and writes it directly.
- No database. No vector store requirement (optional for search).
- Context preserved across sessions — the agent picks up where it left off.
- Memory files are human-readable and editable.

### What Friday Has

Friday has **minimal memory capabilities**:

| Capability | Status | Details |
|---|---|---|
| Thread context | **Implemented** | Fetches Slack thread history, formats as "User: <text>" messages. `src/slack/thread-context.ts` |
| Persona injection | **Implemented** | Loads SOUL.md and IDENTITY.md from `openclaw/` directory. `src/persona.ts` |
| Cross-thread memory | **Missing** | No way to persist learnings from one thread to another |
| Long-term memory | **Missing** | No MEMORY.md equivalent. Each thread starts from zero |
| Daily notes | **Missing** | No daily log accumulation |
| Memory search | **Missing** | No search over past interactions |
| Dreaming/consolidation | **Missing** | No memory promotion system |
| Session history persistence | **Missing** | `--resume` provides Claude-side continuity, but Friday doesn't persist/access conversation history |
| Standing orders | **Partial** | Agent definitions serve this role, but no per-thread persistent instructions |

### What OpenClaw's Memory Files Tell Us

The `openclaw/` directory in Friday's repo contains the actual memory files from the OpenClaw deployment. These are valuable reference material:

| File | Content | Portable? |
|---|---|---|
| `MEMORY.md` | Long-term facts: people, systems, rules, lessons, pipelines, channel maps | **Yes** — port as Friday's seed memory |
| `SOUL.md` | FRIDAY's full persona, cognitive engine, routing engine, response DNA | **Yes** — already used via persona.ts |
| `IDENTITY.md` | Identity card | **Yes** — already used |
| `AGENTS.md` | Agent definitions (Gilfoyle, Dinesh, TARS) | **Partial** — already ported to .claude/agents/ |
| `TOOLS.md` | Environment-specific tool notes | **No** — OpenClaw-specific tool config |
| `HEARTBEAT.md` | Periodic monitoring instructions | **No** — different execution model |
| `memory/*.md` | Daily notes, task records, pipeline docs | **Selective** — port the runbooks and reference docs, skip the session logs |
| `memory/*.json` | Slack user map, Notion config, PR state | **Selective** — port user map, skip ephemeral state |

### Gap Summary: Memory

| Capability | OpenClaw | Friday | Priority |
|---|---|---|---|
| Long-term facts (MEMORY.md) | Auto-loaded every session | **Missing** | **HIGH** — this is the #1 memory gap |
| Daily notes | Auto-created, today+yesterday loaded | **Missing** | **MEDIUM** — useful for continuity |
| Memory search (vector + keyword) | `memory_search` tool | **Missing** | **LOW** for MVP — can use Grep as fallback |
| Pre-compaction flush | Silent turn before compaction | **Missing** | **MEDIUM** — prevents context loss |
| Dreaming/consolidation | Experimental scoring + promotion | **Missing** | **LOW** — nice-to-have, not critical |
| Standing orders per thread | Injected every session | **Partial** — agent defs serve this role | **LOW** |
| Cross-thread knowledge | Shared MEMORY.md across sessions | **Missing** | **HIGH** — threads are currently isolated |

---

## 4. Caching: Gap Analysis

### What OpenClaw Has

**Prompt Caching (Anthropic API):**
- Leverages Anthropic's prompt caching for stable system prompts and memory content
- User timezone stored as designation only (not current time) to preserve cache stability
- Cache-aware dreaming consolidation

**Tool Result Caching:**
- Browser snapshots cached until page state changes
- Web search results cached within session
- Embeddings cached per provider
- Exec output cached for identical command invocations

**Session Caching:**
- Full conversation history maintained in session store
- Memory context auto-injected (cached content)
- Context compaction with memory flush when approaching limits

**Hot Reload:**
- Gateway watches config file
- Safe updates apply immediately
- Breaking changes trigger restart
- No session loss on config change

### What Friday Has

Friday has **no caching**:

| Capability | Status | Details |
|---|---|---|
| Prompt caching | **N/A** | Claude Code CLI may use Anthropic's prompt caching internally, but we don't control it |
| Tool result caching | **N/A** | Claude Code manages its own tool execution, no caching layer |
| Session history caching | **Missing** | No conversation history stored server-side |
| Thread context caching | **Missing** | Thread history re-fetched from Slack API every message |
| Agent definition caching | **Missing** | Agent markdown re-parsed every spawn |
| Persona caching | **Implemented** | `persona.ts` caches SOUL.md/IDENTITY.md after first load |
| Channel name caching | **Implemented** | `thread-context.ts` caches channel name lookups |
| Config caching | **Implemented** | Config loaded once at startup |

### What We Can Control

Since `claude -p` is a black box for prompt/response caching, our caching opportunities are at the **Friday server level**:

1. **Thread context caching** — Cache Slack thread history instead of re-fetching every message
2. **Agent definition caching** — Parse agent markdown once, cache the result
3. **Memory file caching** — Load MEMORY.md once, watch for changes
4. **Prompt template caching** — Pre-build common prompt templates
5. **Slack API response caching** — Cache user info, channel info, file metadata

### Gap Summary: Caching

| Capability | OpenClaw | Friday | Priority |
|---|---|---|---|
| Prompt caching (API level) | Direct control via Anthropic API | **N/A** — CLI handles internally | Not actionable |
| Thread context caching | N/A (different model) | **Missing** — re-fetches from Slack every time | **HIGH** — reduces Slack API calls |
| Agent definition caching | Part of config hot-reload | **Missing** — re-parses markdown every spawn | **MEDIUM** — small perf win |
| Memory file caching | Auto-loaded, file-watched | **Missing** — no memory system yet | **HIGH** (tied to memory implementation) |
| Tool result caching | Browser snapshots, search, exec | **N/A** — Claude manages tools | Not actionable |
| Session context caching | SQLite session store | **Missing** — in-memory only, no history | **MEDIUM** — helps with --resume context |

---

## 5. Claude Code Native Capabilities

> **Key insight:** Claude Code has far more built-in capability than initially assumed. Many features we planned to build from scratch — memory, web tools, tool profiles, hooks — are native CLI features. This section documents what Claude Code gives us for free and how it changes the implementation strategy.

### 5.1 CLI Flags We Should Leverage

These flags are available for `claude -p` (our subprocess model) and directly replace planned custom work:

#### Prompt & Context Injection

| Flag | What It Does | Replaces |
|---|---|---|
| `--append-system-prompt TEXT` | Append to default system prompt (preserves Claude's built-in capabilities) | Custom prompt assembly in spawner |
| `--append-system-prompt-file PATH` | Load system prompt additions from file | Reading + injecting memory content manually |
| `--system-prompt TEXT` | Replace entire system prompt | Use sparingly — loses Claude's built-in instructions |
| `--system-prompt-file PATH` | Load full system prompt from file | For fully custom agent personas |
| `--add-dir PATH1 PATH2` | Add additional working directories to context | Manual file copying into worktrees |

**Impact:** We don't need to read memory files and concatenate them into the prompt string. Write memory to a file, pass `--append-system-prompt-file memory/context.md`. Claude loads it as part of the system prompt with better cache characteristics.

#### Tool Control

| Flag | What It Does | Replaces |
|---|---|---|
| `--tools TOOL1,TOOL2` | Restrict available tools to a list | Our planned tool profiles feature |
| `--allowedTools PATTERNS` | Pre-approve tools (no permission prompts) | Custom approval logic |
| `--disallowedTools PATTERNS` | Remove tools from context entirely | Tool deny lists |
| `--permission-mode MODE` | Set permission mode: `default`, `acceptEdits`, `plan`, `bypassPermissions` | Per-agent permission config |

**Patterns supported:**
- `"Bash(git *)"` — Allow Bash only for git commands
- `"Bash(rm *)"` — Deny dangerous rm commands  
- `"Edit|Write"` — Match multiple tools with regex
- `"mcp__slack__*"` — All tools from a specific MCP server

**Impact:** Tool profiles are a config concern, not a code concern. Define per-agent tool lists in agent definitions or config, pass as CLI flags. No custom tool validation layer needed.

#### Session & Context Management

| Flag | What It Does | Replaces |
|---|---|---|
| `--resume SESSION_ID` | Continue existing conversation (picks up full history) | Custom conversation persistence |
| `--fork-session` | Create new session ID while preserving history | N/A — new capability for branching |
| `--name NAME` | Set session display name | Custom session naming |
| `--max-turns N` | Limit agentic turns | Custom turn counting |
| `--effort low\|medium\|high\|max` | Control reasoning depth | Custom model selection logic |
| `--model MODEL` | Select model (`claude-opus-4-6`, `claude-sonnet-4-6`) | Hardcoded model in spawner |

**Impact:** `--resume` is already used. New additions: `--effort` per agent type (review=high, build=max), `--name` for Slack thread tracking, `--fork-session` for branching approaches.

#### MCP Isolation

| Flag | What It Does | Replaces |
|---|---|---|
| `--mcp-config FILE_OR_JSON` | Load MCP servers from JSON file or inline string | Global MCP config |
| `--strict-mcp-config` | **Only** use `--mcp-config`, ignore global MCP servers | Custom MCP isolation logic |

**Impact:** `--strict-mcp-config` is critical. Each thread gets ONLY the MCP servers we specify — no leaking of global config. Generate a per-thread MCP JSON, pass both flags.

#### Performance & Caching

| Flag | What It Does | Replaces |
|---|---|---|
| `--exclude-dynamic-system-prompt-sections` | Move per-machine info to first user message instead of system prompt | N/A — improves Anthropic's prompt caching |
| `--bare` | Skip hooks, skills, plugins, MCP, auto-memory (faster startup) | N/A — useful for simple tasks |
| `--settings PATH_OR_JSON` | Load additional settings per session | Global settings override |

**Impact:** `--exclude-dynamic-system-prompt-sections` improves prompt cache hit rate across sessions. The system prompt becomes more stable, and Anthropic's API-level caching kicks in. Free performance win.

### 5.2 Built-in Tools We Missed

Claude Code already has these tools available — no MCP server needed:

| Tool | What It Does | We Planned To |
|---|---|---|
| **WebSearch** | Search the web (built-in) | Build `mcp-web-search` — **NOT NEEDED** |
| **WebFetch** | Fetch URLs, APIs (built-in) | Build `mcp-web-fetch` — **NOT NEEDED** |
| **Agent** (subagents) | Spawn specialized subagents with isolated context | N/A — free delegation capability |
| **Skill** | Invoke skills (reusable prompts) | Build custom runbook invocation |
| **TaskCreate/Update/List** | Track multi-step work | Custom task tracking |
| **CronCreate/List/Delete** | Schedule recurring tasks | Custom scheduling |
| **NotebookEdit** | Jupyter notebook support | N/A |

**Impact:** WebSearch and WebFetch being built-in eliminates two of the five planned MCP servers. We only need to build MCP servers for: (1) Slack interaction, (2) Friday status. Memory can be handled via Claude's built-in file tools + system prompt injection.

### 5.3 Memory: Native Capabilities + Our Custom Layer

#### Claude Code's Built-in Auto-Memory

Claude Code has its own memory system:
- Automatically maintains a `MEMORY.md` file in the project root
- First 200 lines / 25KB are loaded at every session start
- Claude reads and writes to it using its own Read/Write tools
- Content persists between sessions
- Can be disabled with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`

**Limitation:** Auto-memory is per-project-directory and is a single flat file. It's useful but insufficient for Friday's needs — we need organized, multi-file, day-wise memory that Claude can write to at any time during a session.

#### Our Memory Design: Always-Writable, Folder-Organized

We build **on top of** Claude Code's native file tools (Read/Write/Edit) rather than replacing them. The key insight: Claude can already read and write files. We don't need an MCP memory server. We just need to:

1. **Give Claude access** to the memory directory via `--add-dir`
2. **Tell Claude about the memory system** via `--append-system-prompt-file` with memory instructions
3. **Let Claude write whenever it wants** — no gating, no hooks required for writes

**Architecture:**

```
memory/                                 # Shared across ALL threads
├── MEMORY.md                           # Long-term facts, rules, people, learnings
├── daily/                              # Day-wise session logs
│   ├── 2026-04-13.md                   # Today's notes (auto-created)
│   ├── 2026-04-12.md                   # Yesterday's notes
│   └── ...
├── threads/                            # Per-thread context (survives session restarts)
│   ├── <thread-id>.md                  # Thread-specific learnings, decisions
│   └��─ ...
├── runbooks/                           # Operational procedures
│   ├── pr-review.md
│   ├── bug-triage.md
│   └── ...
├── people/                             # People directory
│   └── slack-users.json
└── instructions.md                     # Memory system instructions (injected as system prompt)
```

**How Claude interacts with memory:**

| Action | How | When |
|---|---|---|
| **Read long-term memory** | Auto-loaded via `--append-system-prompt-file` | Every session start |
| **Read daily notes** | `Read memory/daily/2026-04-13.md` | When Claude wants context on today's work |
| **Read thread memory** | `Read memory/threads/<threadId>.md` | When resuming a thread |
| **Write to long-term memory** | `Edit memory/MEMORY.md` | Whenever Claude learns something durable (new person, rule, lesson) |
| **Write daily note** | `Edit memory/daily/2026-04-13.md` (append) | After completing a task, making a decision, or learning something |
| **Write thread memory** | `Write memory/threads/<threadId>.md` | When context is thread-specific (decisions, approach, blockers) |
| **Search memory** | `Grep pattern memory/` | When looking for past context |

**The critical design choice:** Claude writes to memory **proactively during the session**, not just at the end via a hook. The system prompt instructions tell Claude:

> You have access to a persistent memory system at `memory/`. Use it actively:
> - When you learn something new about a person, project, or rule → update `memory/MEMORY.md`
> - When you complete a task or make a decision → append to `memory/daily/YYYY-MM-DD.md`  
> - When you have thread-specific context worth preserving → write to `memory/threads/<threadId>.md`
> - When you need context from past sessions → search with `Grep` or read specific files
> - MEMORY.md is loaded into your context at session start. Daily notes and thread files you read on demand.

**Memory injection at spawn time:**

```bash
claude -p "$PROMPT" \
  --resume "$SESSION_ID" \
  --add-dir /path/to/friday/memory \
  --append-system-prompt-file /path/to/friday/memory/instructions.md \
  --output-format stream-json
```

The `--add-dir` flag gives Claude read/write access to the memory directory from any working directory (including target repo worktrees). The `--append-system-prompt-file` injects the memory instructions and current MEMORY.md content.

**Daily note auto-creation:**

Friday's server creates today's daily note file on first use if it doesn't exist:

```typescript
// In session manager, before spawning Claude
const today = new Date().toISOString().split('T')[0]; // 2026-04-13
const dailyPath = `memory/daily/${today}.md`;
if (!existsSync(dailyPath)) {
  writeFileSync(dailyPath, `# ${today}\n\n`);
}
```

The `Stop` hook is a backup — it appends a session summary if Claude didn't already log the session. But the primary memory writes happen during the session, driven by Claude itself.

**Cross-thread memory flow:**

```
Thread A (build task):
  → Claude reads MEMORY.md (auto-loaded)
  → Discovers a deployment pattern
  → Writes to memory/MEMORY.md: "your-backend uses X pattern for deployments"
  → Writes to memory/daily/2026-04-13.md: "14:30 — Thread A: discovered deployment pattern in your-backend"

Thread B (review task, 30 min later):
  → Claude reads MEMORY.md (auto-loaded, now includes the deployment note)
  → Uses the deployment knowledge in its review
  → Writes to memory/daily/2026-04-13.md: "15:00 — Thread B: applied deployment pattern knowledge to PR review"
```

No MCP server. No hook-gated writes. Claude just reads and writes files — the thing it's already best at.

### 5.4 Hooks System

Claude Code has lifecycle hooks configurable in `settings.json`. These fire at specific points during execution:

**Available Hook Events:**

| Event | When It Fires | Use Case for Friday |
|---|---|---|
| `PreToolUse` | Before every tool call | Block dangerous commands, audit logging |
| `PostToolUse` | After every tool call | Log tool usage, track file changes |
| `Notification` | When Claude needs user attention | Forward to Slack thread |
| `Stop` | Session is about to end | Save session summary to daily notes |

**Hook Configuration Format (settings.json):**

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash(rm -rf *)",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/block-dangerous.sh",
            "timeout": 10
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/log-changes.sh"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/save-daily-note.sh"
          }
        ]
      }
    ]
  }
}
```

**Hook types:**
- `"command"` — Execute shell script (receives JSON on stdin, returns exit code + JSON)
- `"http"` — POST JSON to endpoint
- `"prompt"` — Send to Claude for single-turn evaluation
- `"agent"` — Spawn subagent to verify condition

**Hook I/O:**
- Exit code 0 = success (continue)
- Exit code 2 = blocking error (block the action, show stderr)
- Other = non-blocking (show warning, continue)
- Can return `updatedInput` to modify tool calls in-flight

**Impact:** Hooks replace several planned features:
- Memory persistence → `Stop` hook saves session summary
- Audit logging → `PostToolUse` hook logs all tool usage
- Safety rails → `PreToolUse` hook blocks dangerous operations
- Notifications → `Notification` hook forwards to Slack

### 5.5 Skills System

Skills are reusable prompt-based capabilities, invoked with `/skill-name` or by the model.

**Skill File Format (`.claude/skills/NAME/SKILL.md`):**

```markdown
---
name: review-pr
description: Review a pull request using the 8-phase protocol
disable-model-invocation: false
allowed-tools: Bash(git *) Bash(gh *) Read Glob Grep
model: claude-opus-4-6
effort: high
---

## PR Review Protocol

Review this PR following the 8-phase protocol:

Current diff:
!`gh pr diff`

Changed files:
!`gh pr diff --name-only`

$ARGUMENTS
```

**Key features:**
- **Dynamic content** with `` !`command` `` syntax — executes shell commands before Claude sees the skill
- **Tool pre-approval** via `allowed-tools` frontmatter — specific tools auto-approved while skill is active
- **Model override** — skills can force a specific model
- **Context fork** — `context: fork` runs skill in isolated subagent

**Impact:** Skills replace our planned "operational runbooks" feature. Instead of porting runbooks to memory files and hoping Claude reads them, we can make them invocable skills:
- `/review-pr` — PR review protocol
- `/bug-triage` — Bug pipeline
- `/deploy` — Deployment checklist

### 5.6 Agent Definitions (Enhanced)

The `.claude/agents/` system is more powerful than we're currently using:

**Full Frontmatter Fields:**

```markdown
---
name: code-reviewer
description: Expert code reviewer for security and quality
tools: Read Glob Grep Bash(git *) Bash(gh *)
model: claude-opus-4-6
effort: high
isolation: worktree
system-prompt: |
  You are a security expert reviewing code.
  Focus on OWASP Top 10 and business logic flaws.
enable-persistent-memory: true
preload-skills: review-pr
---

Review instructions in the body...
```

| Field | What It Does | Currently Used? |
|---|---|---|
| `name` | Agent identifier | Yes |
| `description` | When to use this agent | Yes |
| `tools` | Restrict available tools | **No** — should add |
| `model` | Force specific model | **No** — should add |
| `effort` | Reasoning depth | **No** — should add |
| `isolation: worktree` | Auto-create worktree | **No** — we do this manually |
| `system-prompt` | Custom instructions | **No** — using body instead |
| `enable-persistent-memory` | Agent gets its own auto-memory | **No** — should add |
| `preload-skills` | Auto-load skills | **No** — should add |
| `disable-model-invocation` | Only callable via `/agent-name` | **No** |

**Impact:** Agent definitions can handle tool profiles, model selection, effort levels, and worktree isolation — all via frontmatter. No code changes needed. Also, `--agent NAME` flag lets us spawn agents directly from the CLI:

```bash
claude --agent code-reviewer -p "Review auth.ts" --output-format stream-json
```

### 5.7 Settings Override Per Session

```bash
claude -p "task" --settings '{"permissions":{"allow":["Bash(git *)","Read"]}}'
# OR
claude -p "task" --settings /tmp/friday-settings-threadId.json
```

Can override: permissions, model, effort, hooks, env vars, and more — per session. This means thread-specific behavior without global config changes.

### 5.8 Revised Capability Map

With Claude Code's native features factored in, here's what we actually need to build vs what's free:

| Capability | OpenClaw | Claude Code Native | Still Need to Build |
|---|---|---|---|
| Shell execution | `exec` | `Bash` tool | Nothing |
| Browser automation | `browser` | Playwright MCP | Nothing |
| File operations | Via `exec` | Read/Edit/Write/Grep/Glob | Nothing |
| Web search | `web_search` | **WebSearch tool (built-in)** | Nothing |
| Web fetch | `web_fetch` | **WebFetch tool (built-in)** | Nothing |
| Long-term memory | MEMORY.md auto-loaded | **Read/Write/Edit (built-in)** | Seed file + folder structure + system prompt instructions |
| Daily notes | `memory/YYYY-MM-DD.md` | **Write (built-in)** | Folder structure + instructions. Claude writes proactively during sessions |
| Thread memory | N/A | **Write (built-in)** | `memory/threads/<threadId>.md` — Claude writes when context is thread-specific |
| Memory search | `memory_search` (vector) | **Grep (built-in)** | Nothing — Claude greps the memory directory |
| Tool profiles | Per-agent config | **`--allowedTools`/`--disallowedTools`** | Agent definition updates only |
| Approval workflows | Gateway interception | **`PreToolUse` hooks** | Hook scripts only |
| Audit logging | N/A | **`PostToolUse` hooks** | Hook scripts only |
| Slack messaging from session | `message` tool | N/A | **MCP Slack server** (only custom MCP needed) |
| Session status | `session_status` | N/A | **MCP Friday status server** (only other custom MCP) |
| Operational runbooks | Standing orders | **Skills system** | Port runbooks as skills |
| Agent model/effort control | Per-agent config | **Agent frontmatter** | Update .claude/agents/ files |
| Worktree isolation | N/A | **`--worktree` flag / `isolation: worktree`** | Already implemented |
| Context caching | API-level prompt cache | **`--exclude-dynamic-system-prompt-sections`** | Server-side TTL caches |
| Notifications | N/A | **`Notification` hook** | Hook script to post to Slack |

**Bottom line:** Of the 5 planned MCP servers, we only need 2 (Slack + Friday status). Memory doesn't need an MCP server at all — Claude reads/writes files directly with instructions on folder structure. Tool profiles, hooks, and skills are config/markdown — no code.

---

## 6. What to Port from OpenClaw

### 6.1 Memory System (HIGH PRIORITY)

**Port the pattern, not the code.** OpenClaw's memory is markdown files read/written by the agent. We replicate this with Claude Code's native file tools and an organized folder structure (see Section 5.3 for full architecture).

**What to port:**

| Source | Target | How |
|---|---|---|
| `openclaw/MEMORY.md` content | `memory/MEMORY.md` | Strip OpenClaw-specific config. Keep: people, rules, lessons, branching strategy, PR pipeline |
| Daily notes pattern | `memory/daily/YYYY-MM-DD.md` | Create folder structure. Friday server auto-creates today's file |
| Runbooks (`openclaw/memory/pr-review-runbook.md`, etc.) | `memory/runbooks/` | Port as-is — they're already markdown |
| Slack user map (`openclaw/memory/slack-users.json`) | `memory/people/slack-users.json` | Port as-is |
| Proactive protocols (`openclaw/memory/proactive-protocols.md`) | `memory/MEMORY.md` (merge relevant parts) | Extract the still-relevant behavioral patterns |

**What to create fresh:**

| File | Purpose |
|---|---|
| `memory/instructions.md` | System prompt instructions explaining the memory system to Claude — when to read, when to write, folder structure, conventions |
| `memory/threads/` directory | Per-thread context files — Claude writes here to preserve thread-specific decisions |
| `memory/daily/` directory | Day-wise session logs — Claude writes here after tasks, decisions, learnings |

**What NOT to port:**
- Dreaming system — premature, requires embedding provider
- Vector search — Claude can Grep the memory directory
- OpenClaw-specific session logs (`memory/2026-03-31-session-boot.md` etc.) — ephemeral
- Notion config — different integration
- PR state JSON — ephemeral

**Key design principle:** Claude writes to memory **proactively during sessions** whenever it wants to, using its native Read/Write/Edit tools. No hooks or MCP servers gate memory writes. The `Stop` hook is only a backup summary — the real memory accumulation happens live.

### 5.2 Tool Calling via MCP (HIGH PRIORITY)

**The bridge between OpenClaw's tool system and Friday's CLI model is MCP.**

Claude Code supports `--mcp-config` for custom MCP servers. We can build lightweight MCP servers that give Claude access to the tools it needs:

**Port as MCP servers:**

| OpenClaw Tool | MCP Server | Purpose |
|---|---|---|
| `message` (Slack) | `mcp-slack` | Let Claude post messages, reactions, file uploads to Slack from within a session |
| `memory_search` | `mcp-memory` | Let Claude search Friday's memory files (keyword-based) |
| `web_search` | `mcp-web-search` | Web search via Brave API (if you have a key) |
| `web_fetch` | `mcp-web-fetch` | HTTP requests for external APIs |
| `session_status` | `mcp-friday-status` | Let Claude query: current thread, user, active sessions, pending messages |

**Already covered (no MCP needed):**
- `exec` -> Claude's Bash tool
- `browser` -> Playwright MCP (already configured in `.mcp.json`)
- File operations -> Claude's Read/Edit/Write

**What NOT to port:**
- Image/video/music generation — out of scope
- Node routing (macOS/iOS/Android peripherals) — out of scope
- Voice/TTS — out of scope
- Approval workflows — overkill for single-user setup

### 5.3 Caching Layer (MEDIUM PRIORITY)

**Port the patterns:**

| Pattern | Implementation |
|---|---|
| Thread context cache | In-memory Map<threadId, {messages, fetchedAt}> with 60s TTL |
| Agent definition cache | Parse once on startup, Map<agentName, ParsedAgent> |
| Memory file cache | Read once, watch for changes via fs.watch. Invalidate on write |
| Prompt template cache | Pre-build common prompt parts (persona + memory + instructions), cache as string |
| Slack API cache | Cache user info (Map<userId, {name, ...}>) and channel info with 5min TTL |

### 5.4 Persona & Agent Definitions (ALREADY PORTED)

The SOUL.md, IDENTITY.md, and agent definitions are already ported:
- `openclaw/SOUL.md` -> loaded by `src/persona.ts`
- `openclaw/IDENTITY.md` -> loaded by `src/persona.ts`
- `openclaw/AGENTS.md` -> split into `.claude/agents/*.md`

### 5.5 Configuration Patterns (SELECTIVE PORT)

| OpenClaw Pattern | Worth Porting? | Why |
|---|---|---|
| `openclaw.json` unified config | **No** — different architecture | Friday uses env vars + TypeScript config, which is simpler for CLI subprocess model |
| Per-agent tool profiles | **Yes** | Map to `--allowedTools` / `--disallowedTools` CLI flags per agent type |
| Channel bindings (agent routing) | **Already done** | Friday's agent routing + !build commands serve this role |
| Standing orders | **Yes** | Add to agent definitions or as shared system prompt prefix |
| Hook system | **Partial** | Claude Code has its own hooks system. Some OpenClaw hooks (session-memory, boot-md) could be reimplemented as Claude Code hooks |

---

## 7. What to Build Fresh

These capabilities don't exist in OpenClaw in a form that's portable to the CLI model:

### 7.1 MCP Server: Slack Tools

Build a lightweight MCP server that gives Claude access to Slack within a session:

```typescript
// Tools to expose:
slack_post_message(channel, text, thread_ts?)    // Post to Slack
slack_add_reaction(channel, timestamp, emoji)    // Add reaction
slack_upload_file(channel, file_path, comment?)  // Upload file
slack_get_thread(channel, thread_ts)             // Read thread
slack_get_user_info(user_id)                     // Look up user
```

**Why:** Currently, Claude can't interact with Slack during a session. It can only output text that Friday posts after the process exits. An MCP Slack server would let Claude post intermediate updates, upload files, add reactions — all within the session.

### 7.2 MCP Server: Friday Status

Build an MCP server for session awareness:

```typescript
// Tools to expose:
friday_status()                     // Current sessions, pending messages, uptime
friday_thread_info(thread_id?)      // Info about current or specific thread
friday_recent_activity(hours?)      // What happened recently across threads
```

### 7.3 Memory System Implementation

Build the folder structure, instructions file, and spawner integration:

**a. Create folder structure:**
```
memory/
├── MEMORY.md                  # Seed from openclaw/MEMORY.md
├── instructions.md            # System prompt: how Claude should use memory
├── daily/                     # Auto-created per day
├── threads/                   # Per-thread context
├── runbooks/                  # Ported from openclaw/memory/
└── people/
    └── slack-users.json       # Ported from openclaw/memory/
```

**b. Write `memory/instructions.md`** — injected via `--append-system-prompt-file`:
```markdown
## Memory System

You have access to a persistent memory system at the `memory/` directory.
Use it actively throughout your session — don't wait until the end.

### When to write:
- Learn something new about a person, project, or rule → `Edit memory/MEMORY.md`
- Complete a task, make a decision, or learn something → append to `memory/daily/YYYY-MM-DD.md`
- Have thread-specific context worth preserving → `Write memory/threads/<threadId>.md`

### When to read:
- Need context from past sessions → `Grep pattern memory/` or read specific files
- Resuming a thread → `Read memory/threads/<threadId>.md`
- Need today's activity → `Read memory/daily/YYYY-MM-DD.md`

### Conventions:
- MEMORY.md: long-term facts only. Keep it under 200 lines.
- Daily notes: timestamp each entry. Format: `HH:MM — [Thread <id>] <what happened>`
- Thread files: decisions, approach, blockers, learnings specific to this thread
- Don't duplicate — if it's in MEMORY.md, don't repeat in daily notes
```

**c. Modify spawner** — `src/claude/args.ts`:
```typescript
// Add to buildClaudeArgs():
args.push('--add-dir', path.resolve('memory'));
args.push('--append-system-prompt-file', path.resolve('memory/instructions.md'));
```

**d. Daily note auto-creation** — in session manager before spawn:
```typescript
const today = new Date().toISOString().split('T')[0];
const dailyDir = path.resolve('memory/daily');
mkdirSync(dailyDir, { recursive: true });
const dailyPath = path.join(dailyDir, `${today}.md`);
if (!existsSync(dailyPath)) {
  writeFileSync(dailyPath, `# ${today}\n\n`);
}
```

### 7.4 Thread Context Cache

```typescript
// In-memory cache with TTL
class ThreadContextCache {
  private cache: Map<string, { messages: SlackMessage[], fetchedAt: number }>;
  private ttlMs: number = 60_000; // 60 seconds

  async getThreadContext(threadId: string): Promise<SlackMessage[]> {
    const cached = this.cache.get(threadId);
    if (cached && Date.now() - cached.fetchedAt < this.ttlMs) {
      return cached.messages;
    }
    const messages = await fetchFromSlack(threadId);
    this.cache.set(threadId, { messages, fetchedAt: Date.now() });
    return messages;
  }

  invalidate(threadId: string) {
    this.cache.delete(threadId);
  }
}
```

---

## 8. What to Skip

These OpenClaw features are out of scope for Friday:

| Feature | Reason to Skip |
|---|---|
| Multi-channel support (Discord, Telegram, etc.) | Friday is Slack-only by design |
| Plugin SDK / Plugin ecosystem | Overkill — MCP serves the extension role |
| Gateway WebSocket control plane | Different architecture — Friday is request/response |
| Node system (companion devices) | Not needed for Slack bot |
| Media generation (image, video, music) | Out of scope |
| Voice/TTS/transcription | Out of scope |
| Approval workflows | Single-user setup, not needed |
| OpenAI-compatible API endpoints | Not needed |
| Control UI (Vite + Lit dashboard) | Friday has Slack Home Tab |
| Hot-reload config watching | Restart is fine for config changes |
| Dreaming system | Cool but premature — simple memory flush is enough |
| Vector embeddings for memory search | Keyword search is good enough for MVP |
| Sandboxed execution environments | Trust Claude Code's built-in sandboxing |
| SSRF protection / env sanitization | Handled by Claude Code CLI |
| Cross-provider model fallbacks | Single model (Claude via Max subscription) |
| Pairing mode for unknown users | Single-user setup |

---

## 9. Revised Implementation Roadmap

> **Major revision:** After discovering Claude Code's native capabilities (Section 5), the scope of custom code is significantly smaller. Many planned features are now config/markdown changes instead of TypeScript implementations.

### What Changed from Original Plan

| Original Plan | Now | Reason |
|---|---|---|
| Build MCP web-search server | **Skip** | WebSearch is a built-in Claude Code tool |
| Build MCP web-fetch server | **Skip** | WebFetch is a built-in Claude Code tool |
| Build MCP memory server | **Skip** | Claude reads/writes memory files directly with native tools. No MCP needed — just folder structure + instructions |
| Build memory injection pipeline | **Simplify** | `--add-dir memory/` + `--append-system-prompt-file memory/instructions.md`. Claude writes proactively during sessions |
| Build tool profiles in code | **Config only** | Use `--allowedTools`/`--disallowedTools` CLI flags + agent frontmatter |
| Build custom audit logging | **Hook script** | `PostToolUse` hook handles this |
| Port runbooks to memory files | **Port as skills** | Skills are invocable and have dynamic content |
| Build notification forwarding | **Hook script** | `Notification` hook forwards to Slack |

### Phase 1: Memory System

**Goal:** Cross-thread persistent memory with organized folder structure. Claude writes to memory proactively during sessions using native file tools.

#### 1a. Create memory folder structure
```
memory/
├── MEMORY.md              # Seed from openclaw/MEMORY.md (ported)
├── instructions.md        # System prompt telling Claude how to use memory
├── daily/                 # Day-wise session logs (auto-created)
├── threads/               # Per-thread context files
├── runbooks/              # Ported operational procedures
└── people/
    └── slack-users.json   # Ported user directory
```

#### 1b. Seed memory content
- Port relevant sections from `openclaw/MEMORY.md` into `memory/MEMORY.md`
- Strip: OpenClaw config, Discord channels, heartbeat, gateway
- Keep: people directory, rules, lessons learned, branching strategy, PR pipeline
- Port runbooks from `openclaw/memory/` into `memory/runbooks/`
- Port `openclaw/memory/slack-users.json` into `memory/people/`

#### 1c. Write memory instructions
- Create `memory/instructions.md` — tells Claude about the folder structure, when to read, when to write, formatting conventions
- This file is injected via `--append-system-prompt-file` at every session start

#### 1d. Integrate into spawner
- Modify `src/claude/args.ts`: add `--add-dir memory/` and `--append-system-prompt-file memory/instructions.md`
- Modify session manager: auto-create today's daily note file before spawning Claude
- Pass thread ID as env var or in prompt so Claude knows which thread file to use

#### 1e. Stop hook (backup summary)
- Create `hooks/save-daily-note.sh` — appends session summary to daily note if Claude didn't already
- Register as `Stop` hook in `.claude/settings.json`
- This is a safety net, not the primary write path — Claude writes during the session

### Phase 2: MCP Servers (Only 2 Needed)

**Goal:** Give Claude access to Slack and Friday's runtime state during sessions.

#### 2a. MCP Slack server (`mcp/slack-server.ts`)
Tools to expose:
- `slack_post_message(channel, text, thread_ts?)` — Post to Slack
- `slack_add_reaction(channel, timestamp, emoji)` — Add reaction
- `slack_upload_file(channel, file_path, comment?)` — Upload file/screenshot
- `slack_get_thread(channel, thread_ts)` — Read thread history
- `slack_get_user_info(user_id)` — Look up user details

#### 2b. MCP Friday status server (`mcp/friday-status-server.ts`)
Tools to expose:
- `friday_status()` — Active sessions, pending messages, uptime
- `friday_thread_info(thread_id?)` — Current thread details
- `friday_recent_activity(hours?)` — Cross-thread activity summary

#### 2c. Per-thread MCP config generation
- Modify `src/claude/args.ts` to generate per-thread MCP JSON
- Include: Slack server (always) + Playwright (when browser needed) + Friday status
- Pass via `--strict-mcp-config --mcp-config /tmp/friday-mcp-<threadId>.json`

### Phase 3: Agent Definitions & Tool Profiles

**Goal:** Each agent type gets appropriate tools, model, and effort level — all via config.

#### 3a. Update agent frontmatter
Add to each `.claude/agents/*.md`:
```yaml
tools: <appropriate tool list>
model: claude-opus-4-6
effort: high  # or max for build agents
```

Per-agent tool profiles:
| Agent | Tools | Effort |
|---|---|---|
| `build.md` | All tools | max |
| `frontend.md` | All tools | max |
| `review.md` | Read, Glob, Grep, Bash(git *), Bash(gh *) | high |
| `architect.md` | Read, Glob, Grep, Agent | high |
| `pm.md` | Read, Glob, Grep | medium |

#### 3b. Update spawner to pass agent flags
- Read agent frontmatter in `src/agents/loader.ts`
- Pass `--allowedTools` / `--disallowedTools` based on agent definition
- Pass `--effort` from agent frontmatter
- Pass `--model` from agent frontmatter

### Phase 4: Skills (Operational Runbooks)

**Goal:** Port operational runbooks as invocable skills with dynamic content.

#### 4a. Create skill files
| Skill | Source | File |
|---|---|---|
| `/review-pr` | `openclaw/memory/pr-review-runbook.md` + repo-specific review docs | `.claude/skills/review-pr/SKILL.md` |
| `/bug-triage` | `openclaw/memory/bug-pipeline.md` | `.claude/skills/bug-triage/SKILL.md` |

Each skill uses `` !`command` `` for dynamic context:
```markdown
---
name: review-pr
allowed-tools: Bash(git *) Bash(gh *) Read Glob Grep
model: claude-opus-4-6
effort: high
---

## PR Diff
!`gh pr diff`

## Changed Files  
!`gh pr diff --name-only`

## Review Protocol
[8-phase review instructions...]

$ARGUMENTS
```

### Phase 5: Hooks & Lifecycle

**Goal:** Automated logging, safety rails, and notifications.

#### 5a. Safety hook — block dangerous commands
- `hooks/safety-check.sh` — PreToolUse hook
- Block: `rm -rf`, force push to main, `DROP TABLE`
- Matcher: `Bash`

#### 5b. Audit hook — log tool usage  
- `hooks/audit-log.sh` — PostToolUse hook
- Append to `logs/tool-usage-YYYY-MM-DD.log`: timestamp, tool, args, thread
- Matcher: `*` (all tools)

#### 5c. Notification hook — forward to Slack
- `hooks/notify-slack.sh` — Notification hook
- POST to Friday's Slack responder: "Claude needs attention in thread X"

#### 5d. Register hooks in settings
```json
// .claude/settings.json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "hooks/safety-check.sh" }] }],
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "hooks/audit-log.sh" }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "hooks/notify-slack.sh" }] }]
  }
}
```

### Phase 6: Caching Layer

**Goal:** Reduce redundant API calls at the Friday server level.

#### 6a. Thread context cache (`src/cache/thread-context.ts`)
- In-memory Map with 60s TTL
- Cache Slack thread history fetches
- Invalidate when new message arrives in thread

#### 6b. Slack API cache (`src/cache/slack-api.ts`)
- Cache user info lookups (5min TTL)
- Cache channel info lookups (5min TTL)
- Shared across all threads

#### 6c. Agent definition cache (`src/cache/agent-cache.ts`)
- Parse agent markdown once at startup
- Cache Map<agentName, ParsedAgent>
- Reload on SIGHUP or file change

#### 6d. Prompt cache optimization
- Pass `--exclude-dynamic-system-prompt-sections` in spawner
- Stabilize system prompt content for better Anthropic-side cache hits

### Build Order & Dependencies

```
Phase 1a (seed memory) ──────────────────┐
Phase 1b (memory injection) ─────────────┤
Phase 1c (daily note hook) ──────────────┤──→ Memory system complete
Phase 1d (thread memory) ────────────────┘
                                         │
Phase 2a (MCP Slack server) ─────────────┤
Phase 2b (MCP Friday status) ────────────┤──→ MCP servers complete  
Phase 2c (per-thread MCP config) ────────┘
                                         │
Phase 3a (agent frontmatter) ────────────┤──→ Tool profiles complete
Phase 3b (spawner flag passing) ─────────┘
                                         │
Phase 4a (skills from runbooks) ─────────────→ Skills complete
                                         │
Phase 5a-d (hooks) ──────────────────────────→ Hooks complete
                                         │
Phase 6a-d (caching) ───────────────────────→ Caching complete
```

Phases 1-2 are foundational. Phases 3-6 are independent and can be built in any order.

---

## Appendix A: OpenClaw Config Reference

The `openclaw/openclaw.json` file in this repo contains the full OpenClaw configuration from the previous deployment. Key structural elements:

| Section | What It Controls |
|---|---|
| `agents.defaults` | Default model, workspace, context tokens, concurrency |
| `agents.list[]` | Named agents (friday, gilfoyle, dinesh, tars) with identity, workspace, model overrides |
| `tools` | Web search config, session visibility, cross-context messaging, agent-to-agent communication |
| `bindings[]` | Routes channels/users to agents (e.g., all Slack -> friday, #gilfoyle-ops -> gilfoyle) |
| `channels.slack` | Slack config: tokens, channel policies, require-mention rules, per-channel system prompts |
| `channels.discord` | Discord config: per-account tokens, guild/channel routing, user allowlists |
| `hooks.internal` | Boot hooks, session memory, command logger |
| `plugins.entries` | OpenAI provider, memory-core with dreaming enabled |
| `gateway` | Port, auth mode, node restrictions |

This config is useful as a reference for understanding the intended behavior, but Friday's architecture doesn't need this level of configuration complexity.

## Appendix B: Portable Runbooks & Reference Files

These files from `openclaw/memory/` contain operational knowledge worth porting:

| File | Content | Action |
|---|---|---|
| `pr-review-runbook.md` | Step-by-step PR review protocol | Port to `memory/runbooks/` |
| `<repo>-review.md` | 8-phase code review guide | Port to `memory/runbooks/` |
| `pr-review-reference.md` | Slack review formatting | Port to `memory/runbooks/` |
| `pr-review-pipeline.md` | Full pipeline: trigger -> review -> post | Port to `memory/runbooks/` |
| `bug-pipeline.md` | Bug triage and routing | Port to `memory/runbooks/` |
| `slack-users.json` | Example Slack user directory | Port to `memory/` |
| `proactive-protocols.md` | Proactive behavior patterns | Port to `memory/` |
| `routing-engine.md` | Agent routing decisions | Already covered by `src/agents/router.ts` |
| `cognitive-engine.md` | Thinking framework | Already in SOUL.md |

## Appendix C: Revised Feature Parity Scorecard

| Feature | OpenClaw | Friday (Current) | Friday (After Roadmap) | How |
|---|---|---|---|---|
| Slack integration | Full (Socket Mode) | Full (Socket Mode) | Full | Already at parity |
| Tool calling (shell, files) | `exec`, file ops | Claude built-in tools | Same | **Native** — Claude's Read/Edit/Write/Bash |
| Tool calling (browser) | `browser` (Playwright) | Playwright MCP | Same | **Native** via `--mcp-config` |
| Tool calling (web) | `web_search`, `web_fetch` | None | Built-in WebSearch/WebFetch | **Native** — discovered as built-in tools |
| Tool calling (Slack from session) | `message` tool | None | MCP Slack server | **Build** — only custom MCP needed |
| Tool profiles | Per-agent config | None | `--allowedTools` + agent frontmatter | **Config** — no code, just agent .md updates |
| Memory (long-term) | MEMORY.md auto-loaded | None | Auto-memory + shared MEMORY.md | **Native** + seed file |
| Memory (daily notes) | Auto-created, auto-loaded | None | Stop hook → daily note | **Hook script** — no code |
| Memory (cross-thread) | Shared MEMORY.md | None | Shared memory dir + `--add-dir` | **Config** — `--add-dir` flag |
| Memory (search) | Vector + keyword hybrid | None | Claude's Grep/Read on memory dir | **Native** — Claude can search files |
| Memory (dreaming) | Experimental consolidation | None | Skip | Intentionally skipped |
| Caching (prompt) | API-level control | N/A | `--exclude-dynamic-system-prompt-sections` | **Flag** — free prompt cache optimization |
| Caching (server-side) | Tool results, sessions | Persona only | Thread context, Slack API, agent defs | **Build** — in-memory TTL caches |
| Agent routing | Config-based bindings | Command-based (!build, etc.) | Same + enhanced agent frontmatter | Already at parity |
| Operational runbooks | Standing orders | None | Skills (`.claude/skills/`) | **Markdown** — port runbooks as skills |
| Safety rails | N/A | None | PreToolUse hooks | **Hook script** |
| Audit logging | N/A | None | PostToolUse hooks | **Hook script** |
| Notifications | N/A | None | Notification hooks | **Hook script** |
| Session persistence | SQLite | In-memory (Redis planned) | Redis | **Build** when needed |

### Effort Breakdown

| Category | Items | Effort |
|---|---|---|
| **Config/markdown only** (no code) | Tool profiles, agent frontmatter, prompt cache flag | ~1 hour |
| **Shell scripts** (hooks) | Safety check, audit log, notification forward, daily note backup | ~2 hours |
| **Markdown** (skills + memory) | PR review skill, bug triage skill, memory instructions file | ~2 hours |
| **TypeScript** (actual code) | MCP Slack server, MCP Friday status server, per-thread MCP config, caching layer, spawner integration (`--add-dir`, `--append-system-prompt-file`), daily note auto-creation | ~2-3 days |
| **Content** (memory seed) | Port MEMORY.md, port runbooks, port slack-users.json, create memory folder structure | ~2 hours |

**Total custom code: ~2-3 days.** Down from the original ~5-7 day estimate. Claude Code's native features eliminated ~60% of the planned work.
