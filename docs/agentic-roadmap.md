# Friday — Agentic Roadmap

> *"She should be able to build things herself if something is not there. She should be smart and intelligent enough to be self-sustaining."*
> — Anmol, 2026-05-08

This document is the long-form plan for evolving Friday from a **reactive Slack bot orchestrating Claude Code subprocesses** into a **self-sustaining agent that recognizes itself, builds her own runbooks when she hits novel tasks, retrieves the right tool from a growing skill library, and recovers from failure modes without human intervention.**

It is grounded in:
- A catalog of concrete incidents from 2026-05-07 / 2026-05-08 (where the gaps actually hurt)
- Five reference architectures: Voyager (lifelong skill-library agent), Hermes (Nous Research, self-improving multi-platform agent), Junior (Pranav's Slack/Claude orchestrator — Friday's sibling), OpenClaw (multi-channel personal AI gateway), NemoClaw (NVIDIA sandboxing layer for OpenClaw)
- The current Friday codebase at `main` HEAD as of 2026-05-08

---

## 0. Framing — what this document is and is NOT

### What we are building

A Slack-resident agent that, over time, becomes:

1. **Self-introspecting.** Knows what features she ships, what tools she has, what runbooks exist. Can answer "can you trigger X?" with a *lookup* against her own inventory, not a guess.
2. **Self-verifying.** When dispatched on a task, observes output of her own actions, catches errors before claiming success, retries with refined plans.
3. **Self-authoring.** When she completes a novel task successfully, distills the procedure into a runbook entry that future-her can retrieve and follow.
4. **Self-recovering.** Heartbeats, watermarks, and respawn paths catch the failure modes that aren't worth a human's morning.
5. **Recognizably herself.** SOUL.md, IDENTITY.md, and the rest of `friday-personal/*` stay load-bearing. None of the upgrades below should change Friday's voice. They make her *capable*, not *generic*.

### What this document is NOT

- **Not "Friday's path to AGI."** No current LLM is AGI. The cap on Friday's capability isn't her code — it's the model behind `claude -p`. Engineering can extend her *reach*, not her *intelligence ceiling*. Pretending otherwise is cargo-cult.
- **Not a one-shot rewrite plan.** Each item in §5 is independently shippable. The order matters; the bundling does not.
- **Not a wishlist.** Every entry has a problem statement, a source, a scope, and a "skip it" criterion.

---

## 1. Today's incident catalog (the evidence base)

These are the concrete failures from this week's sessions. Each one is a data point; together they describe the gap between "reactive Slack bot" and "self-sustaining agent."

| # | Date | Incident | Root cause | Layer |
|---|---|---|---|---|
| 1 | 05-07 | UD's recurring-event bug: dispatched Claude bailed with "Cannot reproduce — premise contradicts the codebase" essay | Wrong repo on first dispatch (backend instead of frontend); no MongoDB MCP in the dispatched env; no playwright reproduction; "grep-and-bail" investigative pattern; screenshot at `/tmp/friday-files/<thread>/...` never forwarded into dispatch prompt | **Tooling reach** + **investigation discipline** |
| 2 | 05-07 | "Cafeteria" thread: Friday's dispatched Claude posted the literal string `NO_SLACK_MESSAGE` to Slack | `dispatch-followup.sh` didn't share the sentinel-skip logic in `responder.ts:shouldSkipFinalPost` | **Single-source-of-truth violation** |
| 3 | 05-07 | Friday silenced every cafeteria message with `len=16` (NO_SLACK_MESSAGE) for ~80 minutes | `routing.ts:hint=null` for `ALWAYS_REPLY_CHANNELS` — Friday had no signal that vibes channels expect engagement | **Routing semantics gap** |
| 4 | 05-07 | Friday post-back race posted an interim "Now let me locate…" instead of the final 1648-char screenshot-ask | `dispatch-followup.sh` watermark exited on first count-bump without waiting for transcript stability | **Race condition** |
| 5 | 05-07 | Memory-extraction sub-Claude inherited `FRIDAY_DISPATCHED=1` and re-entered the followup hook, posting a bogus "no result text" + clobbering `FRIDAY_DISPATCH_SESSION_ID_FILE` | Recursion fence missing on the spawn block | **Recursion / env hygiene** |
| 6 | 05-07 | Dispatched Claude said: *"Couldn't fetch event 69fc17922b922a1f1f872774 — no MongoDB MCP available in this env"* | `dispatch-claude.sh` ran plain `claude` with no `--mcp-config` | **Tooling reach** |
| 7 | 05-08 | "Annu's agent" identity dissociation — Friday told Anmol *"that's Annu's agent, not me, ping her agent directly"* about her own standup post | IDENTITY.md / USER.md never tied her Slack display name "Friday (Annu's Agent)" back to herself; thread-context preamble only worked when messages had user-id attribution | **Identity grounding** |
| 8 | 05-08 | Heartbeat reboot loop: 10 launchd respawns between 01:46–06:04 IST killed today's standup kickoff timer | `socket-health.ts` only refreshed `lastActivityAt` on `slack_event` and state-transitions; idle overnight = no events = looks like dead socket = `process.exit(1)` every 3 min | **Failure-detector calibration** |
| 9 | 05-08 | Standup focus-bot post invented a phantom "awaiting-input" pending standup → next day's kickoff would skip with "already in flight" | `handleFocusBotMessage` set `status: "awaiting-input"` when no real pending existed | **State-machine invariant violation** |
| 10 | 05-08 | Standup vibes-lint truncated Anmol's draft from 391 → 106 chars (3-line cap) | C0AUYJHK6UW is BOTH the standup channel AND a vibes channel; `index.ts` ran the lint unconditionally | **Cross-feature interaction** |
| 11 | 05-08 | "Send this to the standup bot as me" never triggered the user-token post path | `APPROVAL_PHRASES` regex set didn't include "send" / "post as me" / "go ahead" / bare yes/ok | **Brittle natural-language matching** |
| 12 | 05-07 | Friday in #bugs-backlog said *"Looping Anmol — will pick up the investigation once he confirms"* for a UD bug | Bug-triage skill stalled on "ask Anmol" gate even though UD asking IS the trigger | **Permission model didn't match real authority graph** |
| 13 | 05-06 (per `memory/daily/2026-05-06.md`) | Friday's `thread-context.ts:112` strips `<@UXXX>` mentions entirely → loses routing context whenever a third party is tagged | Junior caches `users.info` and rewrites mentions as `@Name (<@UXXX>)`; Friday strips them | **Context fidelity** |

### Pattern across incidents

Eight of the thirteen are **layer violations** — a feature that should have been mediated by another feature wasn't. Vibes-lint shouldn't fire on standup; the dispatched Claude shouldn't run without MCPs Friday has; the dispatch hook shouldn't post sentinels Friday's responder filters; the heartbeat shouldn't read idle-socket as broken-socket.

Three (#11, #12, #13) are **brittle pattern matching** — but the lesson isn't "remove the patterns." It's "add a smart fallback when the patterns miss, and *catalog* what the patterns own so future work doesn't break them."

Two (#7, #8) are **calibration failures** — defaults that were sensible in isolation but wrong against Friday's actual operating profile.

This is the gap the roadmap closes.

---

## 2. Reference architectures — what each one teaches us

### 2.1 Voyager (Wang et al. 2023, TMLR 2025) — *the academic gold standard for self-authored skill libraries*

**Source:** [arxiv.org/abs/2305.16291](https://arxiv.org/abs/2305.16291) · [voyager.minedojo.org](https://voyager.minedojo.org/) · [github.com/MineDojo/Voyager](https://github.com/MineDojo/Voyager)

**Core thesis:** A persistent, executable skill library + an iterative prompting loop with self-verification = lifelong learning *without fine-tuning*.

**Three mechanisms:**

| Mechanism | Voyager's implementation | Friday's analog (current) | Friday's gap |
|---|---|---|---|
| **Automatic curriculum** | LLM-generated next task based on world state, agent inventory, prior progress. Maximizes *exploration*. | None — Anmol drives the queue. | Friday doesn't propose tasks for herself. Probably *fine* in a Slack-bot context — Anmol IS the curriculum. Skip. |
| **Skill library** | Executable JavaScript functions, indexed by name + description embedding. Retrieval at task time via embedding similarity. | `memory/runbooks/*.md` (procedural docs), `.claude/skills/*/SKILL.md` (Anthropic skills), `bin/*.sh|.ts` (executable tools). Retrieval: ad-hoc grep + Friday remembering paths. | **No embedding-based retrieval. No auto-authoring. Friday doesn't promote a successful novel run into a new runbook.** |
| **Iterative prompting + self-verification** | Try → observe environment + execution errors → refine plan → retry. Self-verifier checks "did this achieve the goal?" before committing skill to library. | One-shot dispatch (`dispatch-claude.sh` + paste-prompt + Stop hook). No retry loop. No goal verifier. | **The "Cannot reproduce" essay (incident #1) is the textbook case.** Voyager would have detected the missing MongoDB tool, logged it, and either retried with the tool added or escalated honestly. |

**What we adopt from Voyager:**
- Skill library promotion (P1, §5.3)
- Iterative dispatch loop with self-verification (P2, §5.5)

**What we don't adopt:** automatic curriculum (Anmol IS the curriculum), 3D-environment-specific patterns, fine-tuning-free claims that don't apply to a CLI subprocess.

### 2.2 Hermes Agent (Nous Research) — *progressive-disclosure skill retrieval, multi-platform messaging gateway*

**Source:** [github.com/nousresearch/hermes-agent](https://github.com/nousresearch/hermes-agent) · [hermes-agent.nousresearch.com/docs](https://hermes-agent.nousresearch.com/docs)

**Core architecture:**

- **Skills System:** Markdown + YAML frontmatter (`SKILL.md`) in `~/.hermes/skills/`. Each skill has `name, description, version, platforms, category, tags, config settings`. Body has `When to Use / Procedure / Pitfalls / Verification`.
- **Progressive disclosure:** Level 0 = `skills_list()` returns `[{name, description, category}, ...]` (~3k tokens). Level 1 = `skill_view(name)` returns full content. Loaded lazily.
- **Skill creation triggers:** "After completing a complex task (5+ tool calls) successfully" / "When it hit errors or dead ends and found the working path" / "When the user corrected its approach" / "When it discovered a non-trivial workflow."
- **Memory:** FTS5 SQLite session search + LLM-summarization for cross-session recall + Honcho dialectic user modeling.

**What we adopt from Hermes:**
- Progressive-disclosure skill loading (P1, §5.3) — Friday's current persona snapshot already injects MEMORY.md + 2 latest dailies; we extend this to a `skills_list` injected at boot, then `skill_view` on-demand.
- Hermes's skill *triggers* are exactly the right list for Friday's auto-runbook authoring.

**What we don't adopt:**
- Multi-platform messaging gateway (Telegram, WhatsApp, Discord, Signal, iMessage). Anmol uses Slack. Out of scope.
- Honcho dialectic user modeling. Friday's `friday-personal/USER.md` already covers what Honcho would synthesize at our scale.

### 2.3 Junior (PranavBakre) — *Friday's closest sibling, same role, different choices*

**Source:** [github.com/PranavBakre/Junior](https://github.com/PranavBakre/Junior)

Junior and Friday are *cousins* — both descend from the same OpenClaw-agents lineage and orchestrate `claude -p` per Slack thread. The 2026-05-06 daily note already audited the gap; this section is the consolidated picture.

| Capability | Junior | Friday | Action |
|---|---|---|---|
| Per-thread `claude -p` spawn with `--resume` | ✅ | ✅ | At parity. |
| Session storage | SQLite (`src/session/store/sqlite.ts`) | File JSON (`src/session/store/file.ts`) | **P2 — port SQLite store** for concurrent-write durability. |
| **MCP HTTP server** for Slack | ✅ Single shared HTTP server at boot (port 3456), 7 tools (`slack_send_message`, `slack_read_channel`, `slack_read_thread`, `slack_search`, `slack_search_users`, `slack_upload_file`, `register_worktree`). All spawned Claudes connect to the same server. | Per-thread stdio MCP (`mcp/slack-server.ts`) generated via `generateMcpConfig()`. Heavier, more isolated, but no shared state. | **P1 — evaluate moving to shared HTTP server.** Lets dispatched Claudes post mid-turn without owning their own MCP process. Mitigates incident #1's "no MCP in dispatch" once and for all. |
| Multi-agent threads | ✅ `lead`, `reproducer`, `thinker`, `review`, `echo` — multiple Claude sessions in one thread, distinct usernames/emojis | One Claude per thread | **P2 — port multi-agent dispatcher** for non-trivial bugs (one Claude reproduces, one writes the fix, one reviews). |
| Thread-context user resolution | ✅ `resolveUserName` cache + `resolveSlackMentions` rewrite to `@Name (<@UXXX>)` | Strips mentions entirely (incident #13) | **P0 — port immediately.** Fixes both context-loss AND identity-confusion (incident #7) classes. |
| Dev-server queue | ✅ `src/lifecycle/dev-server.ts` — proper-lockfile-based slot sharing with 10-min slot timeouts, 20-min idle TTLs | None | **P2** — only matters if Friday starts running dev servers herself. |
| Localhost dashboard | ✅ HTTP + SSE chat | None | **Backlog** — nice-to-have for introspection but Anmol prefers Slack. |
| Dashboard SSE chat | ✅ | None | **Skip** — out of scope. |
| `ContentBlockThinking` | Defined but unused | ✅ Surfaced as live status (`extractThinkingStatus`) | Friday wins. |
| Layered persona injection (IDENTITY/SOUL/AGENTS/USER/TOOLS/MEMORY/HEARTBEAT) | 2 layers | 7 layers (post-2026-05-07) | Friday wins. |
| Memory + dreaming (light/REM/deep, MEMORY.md promotion) | None | ✅ | Friday wins. |
| Standup, dump digest, anti-spiral, vibes-lint | None | ✅ | Friday wins. |
| Self-edit guard | None | ✅ `hooks/friday-self-edit-guard.sh` | Friday wins. |
| Pattern routing (PR review, bug-triage, catchup, vibes) | Less developed | ✅ | Friday wins. |
| Socket-health heartbeat | None visible | ✅ (post-incident #8) | Friday wins. |

**Net:** Friday is materially ahead on *persona, memory, and behavioral guardrails*. Junior is materially ahead on *thread context, multi-agent dispatch, MCP architecture, and durability*. The roadmap below ports Junior's *infrastructure* wins while keeping Friday's *behavioral* wins.

### 2.4 OpenClaw — *multi-channel gateway, Live Canvas, sandboxing*

**Source:** [github.com/openclaw/openclaw](https://github.com/openclaw/openclaw)

A local-first Gateway with multi-channel routing (WhatsApp/Telegram/Slack/Discord/Signal/iMessage), wake-word voice, Live Canvas for visual workspaces, Docker/SSH sandboxing.

**What we adopt:** essentially nothing in the near term. Anmol uses Slack. Multi-channel is yagni. Sandboxing only matters when we let Friday self-modify (see §5.7).

**What's worth a footnote:** OpenClaw's architecture treats the *gateway* as the single control plane and channels as plugins. If Friday ever expands beyond Slack, this is the right shape — but we're not there.

### 2.5 NemoClaw (NVIDIA) — *sandboxing layer for autonomous agents*

**Source:** [github.com/NVIDIA/NemoClaw](https://github.com/NVIDIA/NemoClaw)

Hardened OpenShell runtime with guided onboarding, hardened blueprints, state management, layered protections.

**What we adopt:** the *idea* — when Friday gets self-modification (§5.7), the writes need to go through a sandboxed/staged path (PR-only, never direct push, no `--no-verify`, etc.). NemoClaw's blueprint structure is a reference; we don't need NVIDIA's runtime.

---

## 3. Synthesized gap analysis

Pulling §1 and §2 together, Friday's gaps cluster into six themes:

1. **Identity grounding (incidents #7, #13).** She doesn't reliably know who she is when context is ambiguous. *Fix: persona hardening + thread-context user resolution.*
2. **Tooling reach in dispatched contexts (incidents #1, #6).** Sub-Claudes don't inherit the tools Friday has. *Fix: MCP propagation (already shipped 2026-05-07) + shared HTTP MCP server (Junior pattern).*
3. **State-machine + invariant hygiene (incidents #2, #3, #5, #8, #9, #10).** Features stomp on each other when they share a substrate. *Fix: explicit interaction tests + a "feature owners" registry that the runtime consults before mutating shared state.*
4. **Investigation discipline (incident #1).** Grep-and-bail is the default failure. *Fix: investigation escalation ladder enforced by sub-prompts (already partially shipped) + iterative dispatch loop with self-verification (Voyager).*
5. **Self-knowledge (incidents #7, #11).** Friday can't introspect her own features, tools, or natural-language vocab. *Fix: programmatic inventory injected at boot.*
6. **Self-authoring (no incident yet, but the shape of all incidents).** She doesn't grow from successful runs — every novel task starts from zero. *Fix: Voyager-style skill promotion; Hermes-style triggers.*

---

## 4. Architecture target

```
                            ┌──────────────────────────────────┐
Slack Events  ──────────────│    Bolt Socket Mode receiver     │
                            │  + active health check + reboot  │
                            └────────────────┬─────────────────┘
                                             │
                                             ▼
                            ┌──────────────────────────────────┐
                            │      SessionManager              │  ◄── Mute toggle, command parser
                            │   (per-thread state machine)     │  ◄── Pattern routing (fast path)
                            │                                   │  ◄── LLM intent classifier (fallback)
                            └──────┬───────────────────┬───────┘
                                   │                   │
            (per-message turn)     │                   │     (long-running task)
                                   ▼                   ▼
              ┌──────────────────────────┐   ┌────────────────────────────────────┐
              │  claude -p (FRIDAY_      │   │  dispatch-claude.sh tmux REPL      │
              │  SPAWNED) — short, with  │   │  (FRIDAY_DISPATCHED) — persistent  │
              │  full persona + memory   │   │  with --mcp-config + iterative     │
              │  snapshot + skill list   │   │  loop + self-verification          │
              └──────────┬───────────────┘   └────────────────┬───────────────────┘
                         │                                    │
                         └─────────────┬──────────────────────┘
                                       │
                                       ▼
                ┌──────────────────────────────────────────────┐
                │  Shared MCP HTTP Server (single port)        │  ◄── Junior pattern
                │  - friday-slack: send/read/search/upload    │
                │  - friday-status: live thread state          │
                │  - mongodb: production reads (read-only)    │
                │  - friday-introspect: list tools/skills/    │
                │    runbooks (Hermes-style progressive)       │
                └──────────────────────────────────────────────┘
                                       │
                                       ▼
                ┌──────────────────────────────────────────────┐
                │  Memory layer                                │
                │  - memory/MEMORY.md (long-term, curated)    │
                │  - memory/daily/YYYY-MM-DD.md               │
                │  - memory/feedback_*.md                     │
                │  - memory/runbooks/*.md ◄── auto-authored   │
                │  - memory/skills/*.md ◄── new (Voyager)     │
                │  - memory/threads/*.md ◄── per-thread state │
                │  - memory/.dreams/* (recall + signals)      │
                └──────────────────────────────────────────────┘
                                       ▲
                                       │
              Stop hook (every turn) ──┴──── Memory + Skill extractor
                                              (Hermes triggers, Voyager promotion)
```

Three things this diagram captures that Friday doesn't have today:
1. **Shared MCP HTTP server** instead of per-thread stdio MCPs.
2. **LLM intent classifier as fallback** when the fast pattern path misses.
3. **`memory/skills/`** as a first-class auto-authored skill directory.

---

## 5. Roadmap

Each item: problem → source → scope → effort → risk → dependencies.

### 5.1 P0 — User-name resolution & mention preservation

**Problem.** `src/slack/thread-context.ts:112` strips `<@UXXX>` tokens from history. When third parties are tagged, Friday loses routing context. When her own display name `Friday (Annu's Agent)` shows up in quoted text, she dissociates (incident #7).

**Source.** Junior's `src/slack/thread-context.ts:48-86`. `users.info` cache + Promise.all batch + rewrite to `@Name (<@UXXX>)`.

**Scope.**
1. New `userNameCache` (TTL: 1 day, prune like `slackApiCache`).
2. `resolveUserName(app, userId)` — `display_name → real_name → name → userId` fallback.
3. `resolveSlackMentions(text)` — regex-replace `<@UXXX>` with `@Name (<@UXXX>)`.
4. Integrate into `fetchThreadHistory` — render every message as `User(Pranav Bakre <@U03PNSJ33S5>): …`.
5. Update `IDENTITY.md` to anchor: "If you see your own display name `Friday (Annu's Agent)` in quoted text, that is YOU."
6. Test: `routing.test.ts` style fixture covering bot-self, third-party-tag, fallback.

**Effort.** ~150 LOC + tests. Half a day.

**Risk.** Low. Junior is a working proof; we're transcribing.

**Dependencies.** None. Can ship standalone.

### 5.2 P0 — Self-introspection inventory

**Problem.** Incident #7 root cause: Friday has no list of features she owns. When asked *"can you trigger the standup?"* she said *"not me, ping her agent."* The fix today was a static IDENTITY.md table; the durable fix is a runtime-generated inventory.

**Source.** Hermes's `skills_list()` progressive-disclosure pattern; original idea.

**Scope.**
1. New `bin/inventory.ts` — script that walks the repo and emits structured JSON:
   ```json
   {
     "scripts": [{"path": "bin/standup-test-kickoff.ts", "description": "fire the standup kickoff out-of-band"}, ...],
     "runbooks": [{"name": "bug-triage", "path": "memory/runbooks/bug-triage.md", "summary": "..."}, ...],
     "skills": [{"name": "bug-triage", "path": ".claude/skills/bug-triage/SKILL.md", ...}],
     "schedulers": [{"name": "standup", "path": "src/standup/scheduler.ts", "fires": "11:25 IST weekdays"}, ...],
     "thread_commands": ["!build", "!mute", "!digest", ...],
     "mcp_servers": ["friday-slack", "friday-status", "mongodb"]
   }
   ```
2. `src/claude/args.ts` — at boot, generate the inventory, embed compact summary into the system-prompt file.
3. New runbook section in `memory/instructions.md`: "How to introspect your own features."

**Effort.** ~200 LOC. Half a day.

**Risk.** Low. Pure read-side.

**Dependencies.** None.

### 5.3 P1 — Voyager-style skill self-authoring loop

**Problem.** Friday completes novel tasks and forgets the procedure. The next time the same task shape comes up, she starts from zero.

**Source.** Voyager (skill library + iterative prompting); Hermes (skill creation triggers).

**Scope.**
1. **New directory `memory/skills/`** — auto-authored procedural skills, one `<kebab-name>.md` per skill, frontmatter `{name, description, when_to_use, version}`.
2. **Extend `hooks/dispatch-followup.sh`'s memory-extractor** — currently extracts facts/feedback. Add a third extraction type: `procedure`. The sub-Claude reviews the transcript and answers: *"Did this run discover a non-trivial procedure that future-Friday should reuse? If yes, write a skill file. If no, NO_SKILL."*
3. **Hermes triggers:** fire the procedure-extraction step only when the run meets at least one of:
    - 5+ tool calls in transcript
    - Anmol corrected the agent's approach mid-run
    - The agent hit an error and recovered to success
    - The transcript contains a "we figured out X" pattern
4. **Skill retrieval at task time:**
    - At boot, persona-snapshot includes `<skills-index>` with `[{name, description}, ...]` — Hermes Level 0.
    - Friday calls `skill_view(name)` (new MCP tool or just `Read`) for full content — Hermes Level 1.
    - Selection: LLM-driven against the index, NOT regex.
5. **Self-verification gate:** before promoting a transcript into a skill, the extractor must confirm the run actually succeeded — checks final assistant text for "shipped"/"PRs raised"/explicit success markers, OR matches the originating ask against the outcome.

**Effort.** ~400 LOC across the extractor, the skills_list helper, the boot snapshot extension, plus the prompt engineering for the extractor sub-Claude. Two-three days end-to-end.

**Risk.** Medium. Needs careful prompt engineering on the extractor — false positives (saving a half-baked skill) are worse than false negatives (skipping a real one).

**Dependencies.** §5.1 and §5.2 should land first so the extractor has the right context surface.

### 5.4 P1 — LLM intent classifier as fallback router

**Problem.** Brittle natural-language matching (incidents #11, partly #12). `APPROVAL_PHRASES` regex set, `looksStructured` bug detection, `CATCHUP_PATTERNS` — all keyword-based, all fail on phrases the user happened to use.

**Source.** Original; informed by ReAct-style "tool-decision-as-LLM-call" patterns.

**Scope.**
1. New `src/slack/intent.ts` — `classifyIntent(text, context): Promise<Intent>` where `Intent ∈ {approval, dispatch_request, question, smalltalk, command, blocking_ask, …}`.
2. Implementation: spawn a tiny `claude -p --max-turns 1 --effort low` with a constrained system prompt and JSON-schema output. ~200ms p50, cached per-message.
3. **Fast path stays.** `parseCommand`, `evaluateRouting`, `isApproval` all run first. Only if they all return `null` / `false` / `no-match` AND the message is non-trivial do we call the classifier.
4. Wire into `handleFridayTestMessage` (standup approval), `evaluateRouting` (catchup detection), and `looksStructured` bug detection.

**Effort.** ~250 LOC + tests. One to two days.

**Risk.** Medium. Cost: an extra Claude call on the slow path. Latency: 200ms. Worth it for the failure modes it catches; need to be disciplined about WHERE we add the call.

**Dependencies.** None. Can ship standalone.

### 5.5 P1 — Iterative dispatch loop with self-verification

**Problem.** Incident #1: dispatched Claude grep'd for "recurring", didn't find it, wrote a 1000-word "Cannot reproduce — premise contradicts the codebase" essay. Voyager would have detected the missing tool, retried with the tool added, or escalated honestly. Friday today is one-shot.

**Source.** Voyager's iterative prompting + self-verification.

**Scope.**
1. After the dispatched Claude finishes its first turn, a verifier sub-Claude reads the transcript and the original ask, then answers: *did this run actually achieve the goal, OR did it bail?*
2. If "bailed" AND the bail reason is recoverable (missing tool detected; retry with tool added) → re-dispatch automatically with the missing piece added to the prompt.
3. If "bailed" AND not recoverable (genuine ambiguity, real product question) → emit `<ask-anmol>` (already shipped 2026-05-07).
4. Hard cap on retry depth: 2.
5. Verification is gated by the bug-triage / build / review skill — not all dispatches need it.

**Effort.** ~500 LOC, mostly in `hooks/dispatch-followup.sh` and a new verifier sub-prompt. Three days end-to-end.

**Risk.** Higher. The verifier can loop. The retry can run up Claude bills. Needs hard caps + observability.

**Dependencies.** §5.4 (intent classifier overlaps with verifier logic) — could share infra.

### 5.6 P2 — Junior MCP HTTP server pattern

**Problem.** Per-thread stdio MCPs (current Friday) work but are heavier than necessary. Each spawn starts its own MCP processes; auth and state can't be shared.

**Source.** Junior `src/mcp/slack-server.ts` — single shared HTTP server at boot on port 3456.

**Scope.**
1. Extend existing `mcp/slack-server.ts` to bind on a port (e.g. 3457).
2. `generateMcpConfig` writes `{ "type": "http", "url": "http://localhost:3457" }` instead of a stdio command.
3. Same for `friday-status` server.
4. Add a `friday-introspect` MCP (§5.2 inventory exposed as tools).
5. Auth: bot token loaded once at boot.
6. Migration: keep the stdio path behind a flag for one release; cut over once stable.

**Effort.** ~400 LOC. Two days.

**Risk.** Medium. Process-lifecycle changes always cost a debugging session.

**Dependencies.** None — but combines well with §5.2.

### 5.7 P2 — Self-modification path (Anmol-only, sandboxed via PR)

**Problem.** "She should be able to build things herself if something is not there." Today Friday can edit `memory/`, but cannot modify her own source under `src/` (blocked by `friday-self-edit-guard.sh` for non-Anmol users). For Anmol users she *can* edit, but there's no testing / staging discipline.

**Source.** NemoClaw (sandboxed agent execution); standard SDLC practice.

**Scope.**
1. Friday gains an explicit `propose-change` skill that, given a problem statement, branches off main, makes the change, runs `bun run typecheck && bun test`, and opens a PR against main with an explainer.
2. Direct push to main is blocked even for Anmol-spawned Friday (the self-edit guard already restricts non-Anmol; we add a softer "always go through PR" rule for code changes, even Anmol's).
3. PR self-review: Friday's `review-pr` skill runs against her own PR before pinging Anmol.

**Effort.** ~600 LOC + careful prompt design. Three to four days.

**Risk.** **High.** Auto-modification of a running agent is the highest-blast-radius change in this doc. Needs:
- Branch protection on main (GitHub side).
- Self-edit guard hardening.
- Hard cap on PRs/day.
- Clear opt-in flag.
- Audit log of all self-changes.

**Dependencies.** §5.2, §5.3. **Do not ship without an explicit Anmol go-ahead session.**

### 5.8 P2 — SQLite session store

**Problem.** `FileSessionStore` writes `memory/sessions.json` on every state change. Concurrent writes (multiple threads, multiple events) can race. Junior uses SQLite for the same reason.

**Source.** Junior `src/session/store/sqlite.ts`.

**Scope.** Implement `SqliteSessionStore` to the existing `SessionStore` interface; cut over via config flag.

**Effort.** ~250 LOC. One day.

**Risk.** Low. Behind interface.

**Dependencies.** None.

### 5.9 Backlog — multi-agent persistent identities (Junior pattern)

**Problem.** Hard tasks benefit from role specialization (one Claude reproduces, another writes the fix, another reviews). Friday's `agentType` is a label on the same single Claude.

**Source.** Junior `src/support/router.ts` + `src/support/agents.ts`.

**Scope.** Out of scope for this doc — would warrant its own design doc.

**Risk.** Architectural blast radius.

### 5.10 Backlog — localhost dashboard

**Source.** Junior `src/http/`.

**Scope.** Optional. Only if Anmol wants visual introspection beyond Slack.

---

## 6. Explicitly out of scope

- **Multi-channel (Telegram/WhatsApp/Discord/Signal/iMessage)** — OpenClaw turf. Anmol uses Slack.
- **Voice / wake-word** — OpenClaw / Hermes territory. Not asked for.
- **Honcho dialectic user modeling** — overkill for our scale; `friday-personal/USER.md` is the right primitive.
- **Fine-tuning a bespoke Friday model** — not why Anmol bought a Max subscription. CLI subprocess stays the architecture.
- **Replacing all keyword matching with LLM calls** — Junior doesn't, Voyager doesn't, Hermes doesn't. We add fallback layers; we don't rip out the fast path.
- **"AGI Friday"** — not deliverable. The hard ceiling on agentic capability is the model behind `claude -p`. Engineering extends *reach*, not *intelligence*.

---

## 7. Decision log — what needs Anmol's call

| # | Decision | Default | Why it matters |
|---|---|---|---|
| D1 | Ship §5.1 + §5.2 tonight, or batch? | Default: ship tonight, low risk, fixes today's bugs. | Need Anmol's go-ahead to commit code without his eyes-on-PR. |
| D2 | §5.3 self-authored skills directory: `memory/skills/` (gitignored) or `memory/runbooks/auto/` (separate from human-authored)? | Recommend `memory/skills/` separate dir, gitignored, so machine-generated docs don't pollute the human-curated runbooks. | Affects long-term browsing UX. |
| D3 | §5.6 MCP HTTP server: bind on `localhost:3457` only, or make remotely accessible? | Localhost-only. Same as Junior. | Security. |
| D4 | §5.7 self-modification: opt-in flag default OFF, or gated by env var only? | Default OFF, opt-in via `FRIDAY_SELF_MODIFY=1`. | Risk control. |
| D5 | §5.4 intent classifier: which model? `claude-haiku-4-5` for cost or stay on Opus for quality? | Haiku. ~10x cheaper, plenty smart for intent classification. | Cost / latency tradeoff. |
| D6 | Naming for `memory/skills/`: `<kebab-name>.md` or `skill_<kebab-name>.md` (mirror `feedback_*` convention)? | `skill_<kebab-name>.md` for grep-ability. | Consistency. |

---

## 8. Implementation order

```
Today (P0):
  1. §5.1  user-name resolution + mention preservation
  2. §5.2  inventory script + boot injection
                                                            
Next session (P1):
  3. §5.4  intent classifier (independent, ship first to de-risk)
  4. §5.3  skill self-authoring (depends on 5.1, 5.2)

Following session (P2):
  5. §5.6  MCP HTTP server
  6. §5.5  iterative dispatch loop with verification
  7. §5.8  SQLite session store

Plan-first (do not start without a design session):
  8. §5.7  self-modification path
  9. §5.9  multi-agent dispatcher (Junior port)
  10. §5.10 localhost dashboard
```

Hard rule: each P0/P1 item ships independently with its own commit, typecheck, restart. No bundled merges.

---

## 9. Success criteria

We'll know Friday has crossed the "self-sustaining" threshold (NOT "AGI") when:

- Anmol can ask *"can you trigger X?"* about anything in `bin/`, `memory/runbooks/`, or `.claude/skills/` and Friday answers with a real lookup, not a guess. (§5.2)
- A full week passes without a "wrong Friday in your DMs" / "ping her agent directly" incident. (§5.1, §5.2)
- A novel bug-triage flow that Friday handles successfully turns into a `memory/skills/skill_*.md` entry within 24 hours, and the *next* similar bug triggers retrieval of that skill. (§5.3)
- A natural-language approval Friday hasn't seen before triggers the right action without Anmol's manual intervention. (§5.4)
- A dispatched Claude that hits a missing tool retries with the tool added, instead of writing a "Cannot reproduce" essay. (§5.5)
- Zero recurrence of incidents #1, #6, #7, #11.

That's the bar. None of it is AGI. All of it is achievable.

---

## 10. References

- [Voyager: An Open-Ended Embodied Agent with Large Language Models — Wang et al. 2023, TMLR 2025](https://arxiv.org/abs/2305.16291)
- [Voyager project page](https://voyager.minedojo.org/)
- [MineDojo/Voyager (reference implementation)](https://github.com/minedojo/voyager)
- [Hermes Agent — Nous Research](https://github.com/nousresearch/hermes-agent)
- [Hermes Agent docs (Skills System)](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)
- [Junior — PranavBakre](https://github.com/PranavBakre/Junior)
- [OpenClaw](https://github.com/openclaw/openclaw)
- [NemoClaw — NVIDIA](https://github.com/NVIDIA/NemoClaw)
- Internal: `memory/daily/2026-05-06.md` (Friday-vs-Junior gap audit)
- Internal: `memory/daily/2026-05-07.md` (incident catalog source)
- Internal: `CLAUDE.md` §"Critical Rules" (architectural constraints)

---

*This document is a living plan. Update the incident catalog (§1) when new failure modes appear. Update the roadmap (§5) when items ship — move them to a "shipped" section with the commit hash. Re-rank quarterly. Don't let it rot.*
