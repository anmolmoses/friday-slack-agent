#!/usr/bin/env bun
/**
 * hill-climb — Friday's Loop 4 (the "hill-climbing loop").
 *
 * Loops 1-3 (agent / verification / event-driven) run her work. This is the
 * OUTER loop: it reads the traces of finished runs and proposes improvements to
 * the HARNESS CONFIG itself — runbooks, agent definitions, dispatch-prompt
 * conventions, CLAUDE.md rules, guards/scripts. "The return arrow doesn't just
 * loop back to the top — it reaches inside and updates the agent loop directly."
 *
 * It does NOT auto-edit behavior-changing config. Every change is a reviewable
 * PROPOSAL (human-in-the-loop on Loop 4 is the point). Flow:
 *   analyze <transcript>  → a sub-agent reads one finished run, files a proposal
 *                           under memory/harness-proposals/pending/ if it found a
 *                           genuine harness gap (else nothing). Called by the
 *                           dispatch-followup hook, detached.
 *   scan                  → cross-run pass: mines recent daily notes + pending
 *                           proposals for RECURRING patterns → files a systemic
 *                           proposal. (cron — this is the recurring-blocker detector.)
 *   list                  → show pending proposals.
 *   show <id>             → print one proposal.
 *   apply <id>            → a sub-agent implements the proposal's edit, then it
 *                           moves to applied/. (Your one-tap approval.)
 *   reject <id> [reason]  → move to rejected/.
 *
 * Distinct from memory-extraction (dispatch-followup.sh): that writes a FACT to
 * recall; this proposes a STRUCTURAL change to how she operates.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const PROP = path.join(ROOT, "memory", "harness-proposals");
const PENDING = path.join(PROP, "pending");
const APPLIED = path.join(PROP, "applied");
const REJECTED = path.join(PROP, "rejected");
const MEM = path.join(ROOT, "memory");
const ANMOL_DM_USER = "U0AKP5PAWEB";
for (const d of [PENDING, APPLIED, REJECTED]) mkdirSync(d, { recursive: true });

const CLAUDE_BIN =
  process.env.CLAUDE_BIN && existsSync(process.env.CLAUDE_BIN)
    ? process.env.CLAUDE_BIN
    : "/Users/anmol/.local/bin/claude";

// Spawn a bounded claude -p, fully fenced so its own Stop hook can't re-enter
// the dispatch-followup machinery. Returns stdout text.
async function runClaude(prompt: string, addDirs: string[], maxTurns = 10): Promise<string> {
  const env = { ...process.env } as Record<string, string>;
  for (const k of [
    "FRIDAY_DISPATCHED", "FRIDAY_SPAWNED", "FRIDAY_DISPATCH_JOB_ID",
    "FRIDAY_DISPATCH_LOG", "FRIDAY_DISPATCH_THREAD_SAFE",
    "FRIDAY_DISPATCH_SESSION_ID_FILE", "FRIDAY_SPAWN_CWD",
  ]) delete env[k];
  env.FRIDAY_DISABLE_FOLLOWUP = "1";
  env.FRIDAY_DISABLE_MEMORY_EXTRACT = "1";
  delete env.ANTHROPIC_API_KEY; // stay on the Max subscription

  const args = ["-p", prompt, "--permission-mode", "bypassPermissions", "--max-turns", String(maxTurns)];
  for (const d of addDirs) args.push("--add-dir", d);
  const proc = Bun.spawn([CLAUDE_BIN, ...args], { cwd: "/tmp", env, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

function pendingFiles(): string[] {
  return readdirSync(PENDING).filter((f) => f.endsWith(".md")).sort();
}

function dmAnmol(body: string) {
  try {
    Bun.spawnSync([path.join(ROOT, "bin", "slack-dm.sh"), ANMOL_DM_USER], {
      stdin: Buffer.from(body), stdout: "ignore", stderr: "ignore",
    });
  } catch { /* DM is best-effort */ }
}

const PROPOSAL_FORMAT = `Write the proposal as a markdown file to ${PENDING}/<id>.md where <id> is
\`<YYYYMMDDTHHMMSS>-<short-kebab-slug>\` (you may use any plausible timestamp — uniqueness matters, not exactness).
Use EXACTLY this frontmatter + body:

---
id: <id>
created: <iso8601>
status: pending
risk: doc | behavior | code        # doc = additive runbook/notes; behavior = agent-def/CLAUDE.md/dispatch rule; code = a script/guard
confidence: low | medium | high
target: <relative path of the ONE harness file to change>   # e.g. memory/runbooks/repos/_workflow.md, .claude/agents/build.md, CLAUDE.md, bin/local-stack.sh
source: <transcript path or "scan">
---
# <imperative one-line title>

**Signal:** what happened in the run that exposed a harness gap (1-3 sentences).
**Evidence:** a short verbatim quote or specific citation from the trace.
**Proposed change:** the concrete edit to \`target\` — exact enough that applying it is mechanical.
**Why it compounds:** how this prevents the class of failure on future runs.`;

const STRICT_GATE = `Apply a STRICT bar — most runs yield NOTHING. A harness proposal is warranted ONLY when the run revealed a
durable, GENERALIZABLE improvement to how Friday OPERATES, such as:
- a process gap or repeated mistake that a runbook/agent-def step would prevent,
- a missing guardrail (a check that should have fired),
- a wrong/missing/outdated doc the agent had to discover the hard way,
- an Anmol correction about HOW to work (not just a one-off fact).

DO NOT propose for:
- a plain fact to remember (that's the separate memory-extraction agent's job — do not duplicate it),
- a one-off bug fix already captured by a commit,
- anything you can't tie to a concrete edit of a specific harness file,
- restating something already in CLAUDE.md / the runbooks / MEMORY.md.
Prefer the smallest, most surgical change. One proposal max.`;

async function analyze(transcript: string) {
  if (!transcript || !existsSync(transcript)) { console.error("no transcript"); return; }
  const before = new Set(pendingFiles());
  const prompt = `You are Friday's Loop-4 hill-climbing analyst. A Friday-owned Claude run just finished. Read its transcript at:
${transcript}

Decide whether this run exposed a HARNESS-LEVEL improvement — a change to how Friday operates that would help FUTURE runs.

${STRICT_GATE}

If nothing meets the bar, print exactly: NO_PROPOSAL
Otherwise, ${PROPOSAL_FORMAT}
Then print exactly: PROPOSED <id>
Be terse. Do not narrate.`;
  const out = await runClaude(prompt, [PROP, MEM, ROOT]);
  const created = pendingFiles().filter((f) => !before.has(f));
  if (created.length) {
    for (const f of created) {
      const fm = readFileSync(path.join(PENDING, f), "utf8");
      const title = (fm.match(/^#\s+(.+)$/m)?.[1] ?? f).trim();
      const risk = fm.match(/^risk:\s*(\w+)/m)?.[1] ?? "?";
      const target = fm.match(/^target:\s*(.+)$/m)?.[1]?.trim() ?? "?";
      console.log(`PROPOSED ${f}`);
      dmAnmol(
        `🧗 Hill-climb proposal (Loop 4) — \`${f.replace(/\.md$/, "")}\`\n` +
        `*${title}*\nrisk: ${risk} · target: \`${target}\`\n` +
        `Review: \`bun run hill-climb show ${f.replace(/\.md$/, "")}\` · apply: \`… apply <id>\` · reject: \`… reject <id>\``,
      );
    }
  } else {
    console.log(out.includes("NO_PROPOSAL") ? "NO_PROPOSAL" : out.slice(0, 200));
  }
}

async function scan() {
  // Cross-run pattern mining: recent daily notes + the pending queue.
  const dailyDir = path.join(MEM, "daily");
  const recentDaily = existsSync(dailyDir)
    ? readdirSync(dailyDir).filter((f) => f.endsWith(".md")).sort().slice(-10).map((f) => path.join(dailyDir, f))
    : [];
  const before = new Set(pendingFiles());
  const prompt = `You are Friday's Loop-4 hill-climbing analyst doing a CROSS-RUN scan (the recurring-blocker detector).
Read these recent daily notes:
${recentDaily.join("\n")}
And the already-pending proposals in ${PENDING}.

Find a pattern that recurs across MULTIPLE runs/days (≥2 occurrences) — the same blocker, the same correction, the same
manual workaround — that a harness change would systematically prevent. Recurrence is the bar; a single occurrence is for
the per-run analyzer, not this scan. Skip anything already covered by an existing pending proposal or by the runbooks.

If no recurring pattern clears the bar, print exactly: NO_PROPOSAL
Otherwise, ${PROPOSAL_FORMAT}
In **Signal**, name the ≥2 occurrences (dates/threads). Then print: PROPOSED <id>
Be terse.`;
  await runClaude(prompt, [PROP, MEM]);
  const created = pendingFiles().filter((f) => !before.has(f));
  if (created.length) {
    console.log(`scan filed: ${created.join(", ")}`);
    dmAnmol(`🧗 Hill-climb *scan* found a recurring pattern → proposal \`${created[0].replace(/\.md$/, "")}\`. Review with \`bun run hill-climb list\`.`);
  } else {
    console.log("scan: no recurring pattern over the bar");
  }
}

function list() {
  const files = pendingFiles();
  if (!files.length) { console.log("no pending proposals"); return; }
  console.log(`${files.length} pending proposal(s):\n`);
  for (const f of files) {
    const fm = readFileSync(path.join(PENDING, f), "utf8");
    const title = (fm.match(/^#\s+(.+)$/m)?.[1] ?? f).trim();
    const risk = fm.match(/^risk:\s*(\w+)/m)?.[1] ?? "?";
    const conf = fm.match(/^confidence:\s*(\w+)/m)?.[1] ?? "?";
    const target = fm.match(/^target:\s*(.+)$/m)?.[1]?.trim() ?? "?";
    console.log(`• ${f.replace(/\.md$/, "")}  [${risk}/${conf}] → ${target}\n  ${title}`);
  }
}

function resolveId(id: string): string | null {
  const f = id.endsWith(".md") ? id : `${id}.md`;
  return existsSync(path.join(PENDING, f)) ? f : null;
}

function show(id: string) {
  const f = resolveId(id);
  if (!f) { console.error(`no pending proposal: ${id}`); process.exit(1); }
  console.log(readFileSync(path.join(PENDING, f!), "utf8"));
}

async function apply(id: string) {
  const f = resolveId(id);
  if (!f) { console.error(`no pending proposal: ${id}`); process.exit(1); }
  const body = readFileSync(path.join(PENDING, f!), "utf8");
  const target = body.match(/^target:\s*(.+)$/m)?.[1]?.trim();
  console.log(`Applying ${f} → ${target} …`);
  const prompt = `You are implementing an APPROVED Friday harness proposal. Here it is:

${body}

Make EXACTLY the "Proposed change" to the \`target\` file (relative to ${ROOT}). Keep it surgical — match the file's
existing style and structure; don't reformat surrounding content. If the target is a runbook/agent-def/CLAUDE.md and a
MEMORY.md / index pointer convention applies, update that too. Do not touch anything the proposal didn't call for.
When done, print exactly: APPLIED`;
  const out = await runClaude(prompt, [ROOT, MEM], 14);
  if (out.includes("APPLIED")) {
    renameSync(path.join(PENDING, f!), path.join(APPLIED, f!));
    console.log(`✓ applied + moved to applied/${f}`);
  } else {
    console.error(`apply did not confirm (proposal kept pending). tail:\n${out.slice(-400)}`);
    process.exit(1);
  }
}

function reject(id: string, reason: string) {
  const f = resolveId(id);
  if (!f) { console.error(`no pending proposal: ${id}`); process.exit(1); }
  const p = path.join(PENDING, f!);
  if (reason) writeFileSync(p, readFileSync(p, "utf8") + `\n\n---\n**Rejected:** ${reason}\n`);
  renameSync(p, path.join(REJECTED, f!));
  console.log(`✗ rejected → rejected/${f}`);
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "analyze": await analyze(rest[0]); break;
  case "scan": await scan(); break;
  case "list": list(); break;
  case "show": show(rest[0]); break;
  case "apply": await apply(rest[0]); break;
  case "reject": reject(rest[0], rest.slice(1).join(" ")); break;
  default:
    console.log("usage: hill-climb {analyze <transcript> | scan | list | show <id> | apply <id> | reject <id> [reason]}");
}
