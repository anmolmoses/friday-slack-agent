import type {
  ContentBlockToolUse,
  ContentBlockText,
  ContentBlockThinking,
  StreamEventAssistant,
} from "../claude/types.ts";
import { pickThinkingVerb } from "./thinking-verbs.ts";

/**
 * Extract tool_use content blocks from an assistant event and format as status lines.
 */
export function formatToolStatuses(event: StreamEventAssistant): string[] {
  return event.message.content
    .filter((c): c is ContentBlockToolUse => c.type === "tool_use")
    .map(formatToolBlock);
}

// Sentinels the bot intercepts on the way out; they must never surface as
// status-message text either — otherwise the user sees "NO_REPLY" edited into
// the heartbeat message.
const STATUS_SENTINELS = ["NO_REPLY", "___pi_sr_silent_marker___"];

/**
 * Extract text content from an assistant event, if any. Strips the silence
 * sentinels so the live-status message never displays them.
 */
export function extractAssistantText(event: StreamEventAssistant): string | null {
  const texts = event.message.content
    .filter((c): c is ContentBlockText => c.type === "text" && !!c.text)
    .map((c) => c.text);
  if (texts.length === 0) return null;
  const combined = texts.join("");
  const trimmed = combined.trim();
  if (STATUS_SENTINELS.some((s) => trimmed === s || trimmed.toUpperCase() === s.toUpperCase())) {
    return null;
  }
  return combined;
}

/**
 * Extract a rolling thinking-status line from an assistant event. Mirrors the
 * Claude Code CLI's thinking UI — picks the most recent reasoning so the
 * Slack status message rolls forward as Claude thinks.
 *
 * Formatting matches Claude Code: `✽ Thinking… <latest sentence>` in italics
 * (Slack mrkdwn `_…_`) so it reads as ambient reasoning, not a reply.
 */
export function extractThinkingStatus(event: StreamEventAssistant): string | null {
  // Find the LAST thinking block in the event — most recent reasoning wins.
  const thinkingBlocks = event.message.content
    .filter((c): c is ContentBlockThinking => c.type === "thinking" && !!c.thinking)
    .map((c) => c.thinking!);
  if (thinkingBlocks.length === 0) return null;

  const latest = thinkingBlocks[thinkingBlocks.length - 1]!;
  const sentence = pickTailSentence(latest, 200);
  if (!sentence) return null;
  const verb = pickThinkingVerb();
  return `✽ _${verb}… ${sentence}_`;
}

/** Last non-trivial sentence of a thinking block, capped at maxLen. */
function pickTailSentence(text: string, maxLen: number): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return "";

  // Split on sentence boundaries and pick the last meaningful chunk.
  const sentences = trimmed.split(/(?<=[.!?])\s+/).filter((s) => s.length > 2);
  if (sentences.length === 0) {
    return trimmed.length > maxLen ? "…" + trimmed.slice(-maxLen + 1) : trimmed;
  }
  const last = sentences[sentences.length - 1]!;
  if (last.length <= maxLen) return last;
  // Very long trailing sentence — show the tail so we see Claude's *current*
  // thought, not an older one.
  return "…" + last.slice(-maxLen + 1);
}

function short(text: string, n: number): string {
  if (text.length <= n) return text;
  return text.slice(0, n - 1) + "…";
}

function formatToolBlock(block: ContentBlockToolUse): string {
  const tool = block.name ?? "Unknown";
  const input = block.input ?? {};

  // MCP tools arrive as "mcp__server__method" — surface the method name cleanly
  if (tool.startsWith("mcp__")) {
    const parts = tool.split("__");
    const server = parts[1] ?? "mcp";
    const method = parts.slice(2).join(".");
    return `🔌 ${server} · ${method || "call"}`;
  }

  switch (tool) {
    case "Bash": {
      const cmd = typeof input.command === "string" ? input.command : "";
      const desc = typeof input.description === "string" ? input.description : "";
      // Prefer a concrete command, but if it's gnarly fall back to the
      // description Claude writes for every Bash call.
      const label = cmd.length > 0 && cmd.length < 120 ? cmd : desc || cmd;
      return `⚙️ \`${short(label, 120)}\``;
    }
    case "Read": {
      const file = typeof input.file_path === "string" ? input.file_path : "";
      const offset = typeof input.offset === "number" ? input.offset : null;
      const limit = typeof input.limit === "number" ? input.limit : null;
      const range = offset && limit ? `  (lines ${offset}–${offset + limit})` : "";
      return `📖 Reading \`${short(file, 80)}\`${range}`;
    }
    case "Edit": {
      const file = typeof input.file_path === "string" ? input.file_path : "";
      return `✏️ Editing \`${short(file, 80)}\``;
    }
    case "Write": {
      const file = typeof input.file_path === "string" ? input.file_path : "";
      return `📝 Writing \`${short(file, 80)}\``;
    }
    case "Grep": {
      const pattern = typeof input.pattern === "string" ? input.pattern : "";
      const scope = typeof input.path === "string" ? ` in \`${short(input.path, 40)}\`` : "";
      return `🔎 Searching for \`${short(pattern, 60)}\`${scope}`;
    }
    case "Glob": {
      const pattern = typeof input.pattern === "string" ? input.pattern : "";
      return `🔎 Finding \`${short(pattern, 80)}\``;
    }
    case "WebFetch": {
      const url = typeof input.url === "string" ? input.url : "";
      return `🌐 Fetching \`${short(url, 100)}\``;
    }
    case "WebSearch": {
      const query = typeof input.query === "string" ? input.query : "";
      return `🌐 Web search · \`${short(query, 100)}\``;
    }
    case "TodoWrite": {
      const todos = Array.isArray(input.todos) ? (input.todos as Array<{ content?: string }>) : [];
      const first = todos[0]?.content ?? "";
      return `🗒 Planning${first ? ` — ${short(String(first), 80)}` : ""}`;
    }
    case "SlashCommand": {
      const cmd = typeof input.command === "string" ? input.command : "";
      return `🧩 Running \`${short(cmd, 80)}\``;
    }
    case "Task":
    case "Agent": {
      const desc = typeof input.description === "string" ? input.description : "";
      const kind = typeof input.subagent_type === "string" ? input.subagent_type : "";
      const label = desc || kind || "subagent";
      return `🤝 Dispatching ${kind ? `\`${kind}\` · ` : ""}${short(label, 80)}`;
    }
    case "Skill": {
      const name = typeof input.skill === "string" ? input.skill : "";
      return `🧩 Using skill \`${short(name, 60)}\``;
    }
    default:
      return `🔧 Using ${tool}`;
  }
}

/**
 * Convert common Markdown syntax to Slack mrkdwn so messages render correctly
 * even when Claude slips back to standard Markdown habits despite the persona
 * rule. Conservative — only touches unambiguous cases.
 *
 * - `**bold**` → `*bold*`
 * - `__bold__` → `_bold_`
 * - `[label](url)` → `<url|label>`
 * - lines starting with `#`/`##`/`###` → `*Heading*`
 * - bare `<https://...>` → already mrkdwn-friendly, untouched
 *
 * Skips content inside fenced code blocks and inline `code` spans.
 */
export function toSlackMrkdwn(text: string): string {
  if (!text) return text;

  // Split off fenced code blocks so we don't touch their contents.
  const parts: Array<{ kind: "code" | "text"; body: string }> = [];
  const fenceRe = /```[\s\S]*?```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text))) {
    if (m.index > last) parts.push({ kind: "text", body: text.slice(last, m.index) });
    parts.push({ kind: "code", body: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", body: text.slice(last) });

  const transformed = parts.map((p) => {
    if (p.kind === "code") return p.body;
    return transformTextSegment(p.body);
  });

  return transformed.join("");
}

function transformTextSegment(s: string): string {
  // Pull inline `code` spans out so we don't munge their contents either.
  const tokens: Array<{ kind: "code" | "raw"; body: string }> = [];
  const inlineRe = /`[^`\n]+`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = inlineRe.exec(s))) {
    if (m.index > last) tokens.push({ kind: "raw", body: s.slice(last, m.index) });
    tokens.push({ kind: "code", body: m[0] });
    last = m.index + m[0].length;
  }
  if (last < s.length) tokens.push({ kind: "raw", body: s.slice(last) });

  return tokens
    .map((t) => {
      if (t.kind === "code") return t.body;
      let out = t.body;

      // `[label](url)` → `<url|label>` (avoid touching image syntax `![…](…)`)
      out = out.replace(
        /(^|[^!])\[([^\]\n]+)\]\(([^)\s]+)\)/g,
        (_full, prefix: string, label: string, url: string) => `${prefix}<${url}|${label}>`,
      );

      // `**bold**` → `*bold*`. Non-greedy, no internal newlines.
      out = out.replace(/\*\*([^*\n]+?)\*\*/g, "*$1*");

      // `__bold__` → `_bold_`.
      out = out.replace(/__([^_\n]+?)__/g, "_$1_");

      // Markdown headings at line start → bold line.
      out = out.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*$/gm, "*$1*");

      return out;
    })
    .join("");
}

const DEFAULT_MAX_LENGTH = 4000;

export function splitResponse(
  text: string,
  maxLength: number = DEFAULT_MAX_LENGTH,
): string[] {
  if (!text) return [];

  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    const slice = remaining.slice(0, maxLength);

    // Try to split at a paragraph boundary (double newline)
    const lastParagraph = slice.lastIndexOf("\n\n");
    if (lastParagraph > maxLength * 0.3) {
      chunks.push(remaining.slice(0, lastParagraph).trimEnd());
      remaining = remaining.slice(lastParagraph + 2).trimStart();
      continue;
    }

    // Try to split at a single newline, but avoid splitting inside code blocks
    const codeBlockCount = (slice.match(/```/g) || []).length;
    const insideCodeBlock = codeBlockCount % 2 === 1;

    if (!insideCodeBlock) {
      const lastNewline = slice.lastIndexOf("\n");
      if (lastNewline > maxLength * 0.3) {
        chunks.push(remaining.slice(0, lastNewline).trimEnd());
        remaining = remaining.slice(lastNewline + 1);
        continue;
      }
    }

    // If inside a code block, try to find the closing ``` and split after it
    if (insideCodeBlock) {
      const closingFence = remaining.indexOf("```", slice.lastIndexOf("```") + 3);
      if (closingFence !== -1) {
        const endOfLine = remaining.indexOf("\n", closingFence);
        const splitPoint = endOfLine !== -1 ? endOfLine + 1 : closingFence + 3;
        if (splitPoint <= maxLength * 1.5) {
          chunks.push(remaining.slice(0, splitPoint).trimEnd());
          remaining = remaining.slice(splitPoint).trimStart();
          continue;
        }
      }
    }

    // Last resort: split at maxLength
    chunks.push(remaining.slice(0, maxLength));
    remaining = remaining.slice(maxLength);
  }

  return chunks;
}
