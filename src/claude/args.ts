import path from "node:path";
import { writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import type { Config } from "../config.ts";
import type { ThreadSession } from "../session/types.ts";
import type { AgentDefinition } from "../agents/loader.ts";

const FRIDAY_ROOT = path.resolve(import.meta.dir, "../..");
const PROMPT_TMP_DIR = "/tmp/friday-prompts";

const PERSONA_FILES = [
  "IDENTITY.md",
  "SOUL.md",
  "AGENTS.md",
  "USER.md",
  "TOOLS.md",
  "MEMORY.md",
  "HEARTBEAT.md",
] as const;

const PERSONA_DIRS = [
  path.join(FRIDAY_ROOT, "friday-personal"),
  path.join(FRIDAY_ROOT, "openclaw"),
];

// Pre-build persona content once (cached across calls). The cache is
// invalidated by clearPersonaCache() — used by /api/persona/reload so edits
// to friday-personal/*.md take effect on the next spawn without a restart.
let cachedPersonaContent: string | null = null;
let personaLoadedAt: number | null = null;

export function clearPersonaCache(): void {
  cachedPersonaContent = null;
  personaLoadedAt = null;
}

/** Returns persona file mtimes vs the last cache load time. */
export function getPersonaState(): {
  loadedAt: number | null;
  files: { name: string; path: string | null; mtimeMs: number | null; stale: boolean }[];
  anyStale: boolean;
} {
  const files = PERSONA_FILES.map((name) => {
    let foundPath: string | null = null;
    let mtimeMs: number | null = null;
    for (const dir of PERSONA_DIRS) {
      const p = path.join(dir, name);
      if (existsSync(p)) {
        foundPath = p;
        try { mtimeMs = statSync(p).mtimeMs; }
        catch { /* ignore */ }
        break;
      }
    }
    const stale = personaLoadedAt !== null && mtimeMs !== null && mtimeMs > personaLoadedAt;
    return { name, path: foundPath, mtimeMs, stale };
  });
  return {
    loadedAt: personaLoadedAt,
    files,
    anyStale: files.some((f) => f.stale),
  };
}

function loadPersonaContent(): string {
  if (cachedPersonaContent !== null) return cachedPersonaContent;

  // Persona files moved out of openclaw/ to friday-personal/ in commit f16882d
  // (May 2026) so each developer's identity stays gitignored. Try the new
  // location first, fall back to the legacy one for un-migrated checkouts.
  const parts: string[] = [];
  const missing: string[] = [];

  for (const file of PERSONA_FILES) {
    let loaded = false;
    for (const dir of PERSONA_DIRS) {
      const filePath = path.join(dir, file);
      if (existsSync(filePath)) {
        try {
          parts.push(readFileSync(filePath, "utf-8").trim());
          loaded = true;
          break;
        } catch { /* try next dir */ }
      }
    }
    if (!loaded) missing.push(file);
  }

  if (missing.length > 0) {
    console.warn(
      `[persona] missing persona files: ${missing.join(", ")} — searched ${PERSONA_DIRS.join(", ")}. Friday will run without these sections.`,
    );
  }

  cachedPersonaContent = parts.join("\n\n");
  personaLoadedAt = Date.now();
  return cachedPersonaContent;
}

/**
 * Compose Friday's full system context — persona + agent instructions + memory
 * system instructions + recent-memory snapshot + associative recall — as one
 * string. Shared by both brains: the Claude spawner writes it to an
 * --append-system-prompt-file; the Codex spawner prepends it to the first-turn
 * prompt. Returns "" when nothing is available.
 */
export function buildSystemContext(
  session: ThreadSession,
  memoryContext?: string,
): string {
  const memoryDir = path.join(FRIDAY_ROOT, "memory");
  const parts: string[] = [];

  // Persona — the core of who FRIDAY is
  const persona = loadPersonaContent();
  if (persona) {
    parts.push(persona);
  }

  // Agent-specific system prompt (e.g., build agent instructions)
  if (session.systemPrompt) {
    parts.push(session.systemPrompt);
  }

  // Memory system instructions
  try {
    const instructions = readFileSync(path.join(memoryDir, "instructions.md"), "utf-8");
    parts.push(instructions);
  } catch { /* missing file is ok */ }

  // Inject the two most recent daily notes and MEMORY.md so Friday walks in
  // with her short-term + long-term memory already in context (no grep needed).
  const memorySnapshot = buildMemorySnapshot(memoryDir);
  if (memorySnapshot) parts.push(memorySnapshot);

  // Associative recall for this message (engram), if enabled. Empty when off.
  if (memoryContext) parts.push(memoryContext);

  return parts.join("\n\n");
}

export function buildClaudeArgs(
  session: ThreadSession,
  prompt: string,
  config: Config["claude"],
  agentDef?: AgentDefinition | null,
  memoryContext?: string,
): string[] {
  const args: string[] = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-turns",
    String(config.maxTurns),
  ];

  if (session.sessionId) {
    args.push("--resume", session.sessionId);
  }

  // Build a combined system prompt file (persona + agent + memory), written to
  // --append-system-prompt-file so Claude treats it as system-level directives.
  const memoryDir = path.join(FRIDAY_ROOT, "memory");
  const systemContext = buildSystemContext(session, memoryContext);

  if (systemContext) {
    mkdirSync(PROMPT_TMP_DIR, { recursive: true });
    const promptFile = path.join(PROMPT_TMP_DIR, `${session.threadId}.md`);
    writeFileSync(promptFile, systemContext);
    args.push("--append-system-prompt-file", promptFile);
  }

  args.push("--add-dir", memoryDir);

  // Prompt cache optimization
  args.push("--exclude-dynamic-system-prompt-sections");

  // Default to medium effort so extended thinking fires on every Slack turn —
  // this is what Claude Code CLI users are used to seeing locally. Agents can
  // override below.
  let effort: string | null = "medium";

  // Agent-specific: model, effort, tool restrictions
  if (agentDef) {
    if (agentDef.model) {
      args.push("--model", resolveModel(agentDef.model));
    }
    if (agentDef.effort) {
      effort = agentDef.effort;
    }
    if (agentDef.allowedTools) {
      for (const tool of agentDef.allowedTools) {
        args.push("--allowedTools", tool);
      }
    }
    if (agentDef.disallowedTools) {
      for (const tool of agentDef.disallowedTools) {
        args.push("--disallowedTools", tool);
      }
    }
  }

  // Per-thread MCP config (if generated)
  if (session.mcpConfigPath) {
    args.push("--mcp-config", session.mcpConfigPath);
  }

  if (effort) {
    args.push("--effort", effort);
  }

  args.push("--permission-mode", config.permissionMode);

  return args;
}

/**
 * Build a point-in-time snapshot of recent memory to inject into the system
 * prompt. Includes MEMORY.md (long-term) + up to 2 most recent daily notes.
 * Caps each file at ~4KB to keep the prompt lean.
 */
function buildMemorySnapshot(memoryDir: string): string | null {
  const cap = (s: string, n: number): string =>
    s.length <= n ? s : s.slice(0, n) + "\n…[truncated]";

  const sections: string[] = [];

  const memoryMdPath = path.join(memoryDir, "MEMORY.md");
  if (existsSync(memoryMdPath)) {
    try {
      const content = readFileSync(memoryMdPath, "utf-8").trim();
      if (content) {
        sections.push(`<memory-long-term path="memory/MEMORY.md">\n${cap(content, 6000)}\n</memory-long-term>`);
      }
    } catch { /* skip */ }
  }

  const dailyDir = path.join(memoryDir, "daily");
  if (existsSync(dailyDir)) {
    try {
      const files = readdirSync(dailyDir)
        .filter((f) => /^\d{4}-\d{2}-\d{2}.*\.md$/.test(f))
        .sort()
        .reverse()
        .slice(0, 2);
      for (const file of files) {
        try {
          const content = readFileSync(path.join(dailyDir, file), "utf-8").trim();
          if (content) {
            sections.push(`<memory-daily path="memory/daily/${file}">\n${cap(content, 4000)}\n</memory-daily>`);
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  if (sections.length === 0) return null;

  return [
    "## Recent Memory Snapshot",
    "These are live memory files. You may `Edit` them to append new entries (or `Write` a new daily file). Prefer appending — don't overwrite.",
    ...sections,
  ].join("\n\n");
}

function resolveModel(model: string): string {
  switch (model) {
    case "opus":
      return "claude-opus-4-6";
    case "sonnet":
      return "claude-sonnet-4-6";
    default:
      return model;
  }
}
