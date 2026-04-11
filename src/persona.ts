import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OPENCLAW_DIR = join(__dirname, "..", "openclaw");

let cachedPersona: string | null = null;

/**
 * Load Friday's persona from the local openclaw/ directory (SOUL.md + IDENTITY.md).
 * Cached after first load.
 */
export async function loadPersona(): Promise<string> {
  if (cachedPersona) return cachedPersona;

  const parts: string[] = [];

  // Load IDENTITY.md (short identity facts)
  try {
    const identity = await Bun.file(join(OPENCLAW_DIR, "IDENTITY.md")).text();
    parts.push(identity.trim());
  } catch {
    // Fallback if file missing
  }

  // Load SOUL.md (full persona)
  try {
    const soul = await Bun.file(join(OPENCLAW_DIR, "SOUL.md")).text();
    parts.push(soul.trim());
  } catch {
    // Fallback if file missing
  }

  if (parts.length === 0) {
    // Minimal fallback if openclaw workspace is gone
    cachedPersona = [
      "You are Friday, an engineering orchestrator bot in Slack.",
      "You plan, review, coordinate, and assist. Concise, direct, no filler.",
    ].join(" ");
  } else {
    cachedPersona = parts.join("\n\n");
  }

  return cachedPersona;
}
