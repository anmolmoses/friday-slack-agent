import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OPENCLAW_DIR = join(__dirname, "..", "openclaw");

let cachedPersona: string | null = null;

/**
 * Persona files loaded in order. Each adds a layer of FRIDAY's full personality:
 * - IDENTITY.md: short identity card (name, role, emoji, signature)
 * - SOUL.md: full persona (personality, cognitive engine, routing, response DNA, work mode)
 * - AGENTS.md: operational brain (OODA reasoning, decision authority, escalation, proactive intelligence, PR review pipeline)
 * - USER.md: who the user is (context, preferences, goals — helps FRIDAY be personal, not generic)
 */
const PERSONA_FILES = [
  "IDENTITY.md",
  "SOUL.md",
  "AGENTS.md",
  "USER.md",
  "TOOLS.md",
];

/**
 * Load Friday's full persona from the local openclaw/ directory.
 * Cached after first load.
 */
export async function loadPersona(): Promise<string> {
  if (cachedPersona) return cachedPersona;

  const parts: string[] = [];

  for (const file of PERSONA_FILES) {
    try {
      const content = await Bun.file(join(OPENCLAW_DIR, file)).text();
      if (content.trim()) {
        parts.push(content.trim());
      }
    } catch {
      // File missing — skip silently
    }
  }

  if (parts.length === 0) {
    cachedPersona = [
      "You are Friday, an engineering orchestrator bot in Slack.",
      "You plan, review, coordinate, and assist. Concise, direct, no filler.",
    ].join(" ");
  } else {
    cachedPersona = parts.join("\n\n");
  }

  return cachedPersona;
}
