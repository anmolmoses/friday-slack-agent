/**
 * Pre-send lint for vibes / sandbox channels (a vibes channel, a sandbox channel).
 *
 * Background — a real incident saw Friday spiral
 * across ~20 self-deprecating messages chasing a teammate's bait. Operational
 * rules in the system prompt are necessary but not sufficient: when the model
 * over-talks anyway, the post path enforces the cap.
 *
 * Two checks run on the rendered text:
 *   1. line-count cap — anything past 3 non-empty lines is truncated to the
 *      first paragraph block (or first 3 lines if no blank-line break).
 *   2. multi-message intent — drafts containing fake `[6:45 PM]`-style
 *      timestamps, triple-newlines, or "(continued)" markers are flattened
 *      to the first message.
 *
 * Work channels (PR review, bug triage, build threads) are NOT subject to
 * this lint — they routinely produce 4–10 line replies on purpose.
 */

const MAX_VIBES_LINES = 3;

// Fake timestamps: `[6:45 PM]`, `[18:45]`, `[6:45 pm friday]`, etc. Friday
// occasionally simulates these to imply a follow-up post, which violates the
// one-message-per-turn rule. Match a leading bracketed time at line start.
const FAKE_TIMESTAMP_RE = /^\s*\[\s*\d{1,2}[:.]\d{2}\s*(?:[ap]\.?m\.?)?[^\]\n]{0,30}\]/im;

const CONTINUATION_MARKERS = [
  "(continued)",
  "(cont.)",
  "(cont'd)",
  "[continued]",
];

export interface VibesLintResult {
  text: string;
  truncated: boolean;
  reasons: string[];
}

/**
 * Structured data — fenced code blocks or markdown tables — is a work answer,
 * not banter, so the line cap must NOT clip it: a sliced table or an unclosed
 * code fence renders broken in Slack. Only the line cap is exempted; the
 * multi-message-intent flattening still runs (spiraling is spiraling whatever
 * the formatting). Scar: a structured-data reply truncation incident — a
 * 302-attendee table and a code-fenced event list were both truncated to 3
 * lines, leaving "Members: 185" and an unclosed ``` as the whole reply.
 */
function looksStructured(text: string): boolean {
  // Fenced code block — a ``` fence on its own / at line start.
  if (/^\s*```/m.test(text)) return true;
  // Markdown table separator row: |---|---| or a bare --- column rule.
  if (/^\s*\|?[ :|-]*-{2,}[ :|-]*\|?\s*$/m.test(text)) return true;
  // Two or more pipe-delimited rows ("a | b" shaped) — a markdown table.
  const pipeRows = text.split("\n").filter((l) => /\S\s*\|\s*\S/.test(l)).length;
  return pipeRows >= 2;
}

/**
 * Lint and clamp a vibes-channel response. Pure function — no I/O. Returns
 * the (possibly truncated) text plus reasons describing what fired so the
 * caller can log it.
 */
export function lintVibesResponse(input: string): VibesLintResult {
  const reasons: string[] = [];
  if (!input) return { text: input, truncated: false, reasons };

  let text = input.replace(/\s+$/g, "");
  let truncated = false;

  // 1. Multi-message intent — flatten before counting lines so the line
  //    cap doesn't measure imagined follow-ups.
  const tripleNewline = /\n{3,}/.test(text);
  const fakeTs = FAKE_TIMESTAMP_RE.test(text);
  const cont = CONTINUATION_MARKERS.some((m) =>
    text.toLowerCase().includes(m),
  );

  if (tripleNewline || fakeTs || cont) {
    truncated = true;
    if (tripleNewline) reasons.push("triple-newline");
    if (fakeTs) reasons.push("fake-timestamp");
    if (cont) reasons.push("continuation-marker");

    // Keep only the first paragraph block — everything before the first
    // blank-line gap or the first fake timestamp / continuation marker.
    const tsIdx = text.search(FAKE_TIMESTAMP_RE);
    const blankIdx = text.search(/\n\s*\n/);
    let cut = -1;
    for (const idx of [tsIdx, blankIdx]) {
      if (idx >= 0 && (cut === -1 || idx < cut)) cut = idx;
    }
    if (cut >= 0) text = text.slice(0, cut).replace(/\s+$/g, "");

    for (const m of CONTINUATION_MARKERS) {
      const i = text.toLowerCase().indexOf(m);
      if (i >= 0) text = text.slice(0, i).replace(/\s+$/g, "");
    }
  }

  // 2. Line cap — count non-empty lines after collapsing leading/trailing
  //    blanks. If >3, keep the first MAX_VIBES_LINES non-empty lines.
  //    Exemption: structured data (tables, code blocks) is a work answer, not
  //    banter — slicing it renders broken, so it skips the cap entirely.
  if (!looksStructured(text)) {
    const rawLines = text.split("\n");
    let nonEmptySeen = 0;
    let firstEmptyTrimmed = -1;
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i] ?? "";
      if (line.trim() === "") {
        if (nonEmptySeen === 0) {
          firstEmptyTrimmed = i;
          continue;
        }
        continue;
      }
      nonEmptySeen++;
      if (nonEmptySeen > MAX_VIBES_LINES) {
        const stop = i;
        text = rawLines.slice(firstEmptyTrimmed + 1, stop).join("\n").replace(/\s+$/g, "");
        truncated = true;
        reasons.push(`line-cap(${nonEmptySeen}>${MAX_VIBES_LINES})`);
        break;
      }
    }
  }

  return { text, truncated, reasons };
}
