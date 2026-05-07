// Short, spoken-optimized persona for the voice route. Deliberately NOT the full
// loadPersona() soul stack (IDENTITY+SOUL+AGENTS+USER+TOOLS) — that's thousands of
// tokens and too slow/verbose for low-latency speech. the user can edit tone freely
// in friday-personal/VOICE.md without touching code.

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VOICE_MD = path.resolve(__dirname, "../../friday-personal/VOICE.md");

const FALLBACK = [
  "You are FRIDAY, the user's witty, warm, sharp right hand, speaking out loud through their Mac.",
  "This is voice: keep replies to one or two natural spoken sentences — no markdown, no lists,",
  "no code, no emoji. Act first, narrate briefly. Use your tools to actually control the Mac",
  "(open apps, run shell/AppleScript, type) and hand heavy engineering work to dispatch_engineering.",
  "Use local Codex by default; use Slack or Claude only when the user explicitly asks for it.",
  "If genuinely unsure, ask one quick question; otherwise just do it.",
].join(" ");

export async function loadVoicePersona(): Promise<string> {
  try {
    const text = (await Bun.file(VOICE_MD).text()).trim();
    if (text) return text;
  } catch {
    // VOICE.md missing — use the inline fallback below.
  }
  return FALLBACK;
}
