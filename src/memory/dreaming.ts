import { writeFileSync, existsSync, appendFileSync, readFileSync, mkdirSync } from "node:fs";
import { DREAMS_MD, MEMORY_MD, MEMORY_DIR, FRIDAY_ROOT } from "./paths.ts";
import { loadRecentDailySnippets } from "./corpus.ts";
import { extractConceptTags, tokenize } from "./concepts.ts";
import { recordPhaseSignals, recordRecalls, markPromoted } from "./recall.ts";
import { rankPromotionCandidates, formatCandidates } from "./promote.ts";
import { pruneShortTerm } from "./decay.ts";
import type { DreamResult, PromotionCandidate } from "./types.ts";
import { snippetKey } from "./paths.ts";
import { log as logger } from "../logger.ts";

export interface DreamOptions {
  /** Days of daily notes the light phase considers */
  lightLookbackDays?: number;
  /** Skip writing anything to MEMORY.md, just rank & report */
  dryRun?: boolean;
  /** Skip the deep phase (useful for nightly preview runs) */
  lightOnly?: boolean;
  /** Max promotions the deep phase will attempt */
  deepLimit?: number;
  /** Also run the REM narrative phase */
  withNarrative?: boolean;
  /** Run the decay phase (T2): archive aged-out, unrecalled short-term files */
  withDecay?: boolean;
}

/**
 * Light phase: scan recent daily snippets, score them against MEMORY.md
 * content to find what's novel, and bump recall+phase signals so the
 * deep phase has material to work with.
 */
export async function runLightPhase(opts: { lookbackDays: number }): Promise<number> {
  const snippets = loadRecentDailySnippets(opts.lookbackDays);
  if (snippets.length === 0) return 0;

  const memoryText = existsSync(MEMORY_MD) ? readFileSync(MEMORY_MD, "utf-8").toLowerCase() : "";
  const memoryTokens = new Set(tokenize(memoryText));

  const hits: Array<{ key: string; snippet: typeof snippets[number]; novelty: number }> = [];
  for (const snip of snippets) {
    if (snip.tokens.length === 0) continue;
    const uniq = new Set(snip.tokens);
    let overlap = 0;
    for (const t of uniq) if (memoryTokens.has(t)) overlap++;
    const novelty = uniq.size > 0 ? 1 - overlap / uniq.size : 0;
    if (novelty < 0.25) continue; // mostly already-captured — skip
    const key = snippetKey(snip.path, snip.startLine, snip.endLine);
    hits.push({ key, snippet: snip, novelty });
  }

  if (hits.length === 0) return 0;

  // Feed recall so these snippets have a baseline the deep phase can score
  recordRecalls(
    hits.map(({ snippet, novelty }) => ({
      path: snippet.path,
      startLine: snippet.startLine,
      endLine: snippet.endLine,
      snippet: snippet.text,
      score: Math.min(1, 0.3 + novelty),
      query: `__light_phase_${new Date().toISOString().slice(0, 10)}__`,
      conceptTags: extractConceptTags(snippet.text, 5),
    })),
  );

  recordPhaseSignals(
    hits.map((h) => h.key),
    "light",
  );

  return hits.length;
}

/**
 * Deep phase: rank short-term recall entries, write durable ones to MEMORY.md
 * via a Claude subagent (so it's smart about dedup & formatting), then mark
 * them as promoted.
 */
export async function runDeepPhase(opts: {
  limit: number;
  dryRun: boolean;
}): Promise<{ candidates: PromotionCandidate[]; promoted: number; summary: string }> {
  const candidates = rankPromotionCandidates({
    limit: opts.limit,
    minScore: 0.8,
  });

  if (candidates.length === 0) {
    return { candidates: [], promoted: 0, summary: "No candidates met the 0.8 promotion gate." };
  }

  if (opts.dryRun) {
    return {
      candidates,
      promoted: 0,
      summary: "Dry run — would promote:\n" + formatCandidates(candidates),
    };
  }

  const appliedSummary = await writeCandidatesToMemory(candidates);
  markPromoted(candidates.map((c) => c.key));
  return { candidates, promoted: candidates.length, summary: appliedSummary };
}

/**
 * REM phase: extract themes across recent signals. No LLM narrative in this
 * build — just aggregates top concept tags and writes a diary stub to DREAMS.md
 * so the cycle is observable.
 */
export async function runRemPhase(opts: { lookbackDays: number }): Promise<{
  themes: string[];
  remHits: number;
}> {
  const snippets = loadRecentDailySnippets(opts.lookbackDays);
  const tagCounts = new Map<string, number>();
  const keys: string[] = [];
  for (const snip of snippets) {
    keys.push(snippetKey(snip.path, snip.startLine, snip.endLine));
    for (const tag of extractConceptTags(snip.text, 5)) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }
  recordPhaseSignals(keys, "rem");
  const themes = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([tag]) => tag);

  const date = new Date().toISOString().slice(0, 10);
  const line = themes.length
    ? `## ${date} REM\nThemes: ${themes.join(", ")}\n`
    : `## ${date} REM\n(no discernible themes)\n`;
  try {
    mkdirSync(MEMORY_DIR, { recursive: true });
    if (existsSync(DREAMS_MD)) {
      appendFileSync(DREAMS_MD, "\n" + line);
    } else {
      writeFileSync(DREAMS_MD, `# Dreams\n\n${line}`);
    }
  } catch (err) {
    logger.warn("memory/dream", `failed to write DREAMS.md: ${err}`);
  }
  return { themes, remHits: keys.length };
}

export async function runDream(options: DreamOptions = {}): Promise<DreamResult> {
  const {
    lightLookbackDays = 3,
    dryRun = false,
    lightOnly = false,
    deepLimit = 10,
    withNarrative = false,
    withDecay = false,
  } = options;

  const ran: DreamResult["ran"] = [];

  const lightHits = await runLightPhase({ lookbackDays: lightLookbackDays });
  ran.push("light");

  let remThemes: string[] = [];
  let remHits = 0;
  if (withNarrative) {
    const rem = await runRemPhase({ lookbackDays: lightLookbackDays });
    remThemes = rem.themes;
    remHits = rem.remHits;
    ran.push("rem");
  }

  let deepPromoted = 0;
  let deepSummary = "Deep phase skipped.";
  let candidates: PromotionCandidate[] = [];
  if (!lightOnly) {
    const deep = await runDeepPhase({ limit: deepLimit, dryRun });
    deepPromoted = deep.promoted;
    deepSummary = deep.summary;
    candidates = deep.candidates;
    ran.push("deep");
  }

  // Decay phase (T2): archive short-term files that have aged out, scaled by
  // emotion. Recalled-recently and promoted files are always kept. Honors dryRun.
  let decayArchived = 0;
  if (withDecay) {
    try {
      const prune = pruneShortTerm({ dryRun });
      decayArchived = prune.archived;
      ran.push("decay");
    } catch (err) {
      logger.warn("memory/dream", `decay phase failed: ${err}`);
    }
  }

  return {
    ran,
    lightHits,
    remHits,
    deepPromoted,
    decayArchived,
    candidates,
    themes: remThemes,
    summary: [
      `Light: scanned ${lightLookbackDays}d, ${lightHits} novel hits.`,
      remThemes.length > 0 ? `REM themes: ${remThemes.join(", ")}` : null,
      `Deep: ${lightOnly ? "skipped" : dryRun ? "dry-run" : `promoted ${deepPromoted}`}.`,
      deepSummary !== "Deep phase skipped." ? deepSummary : null,
      withDecay ? `Decay: ${dryRun ? "would archive" : "archived"} ${decayArchived} aged short-term file(s).` : null,
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

/**
 * Hand the top promotion candidates to a short-lived Claude subagent and
 * ask it to update MEMORY.md. Returns the assistant's final text.
 */
async function writeCandidatesToMemory(candidates: PromotionCandidate[]): Promise<string> {
  const promptBody = [
    "You are the deep-phase memory consolidator.",
    "",
    "I'm giving you short-term memory snippets that have been recalled repeatedly over multiple days,",
    "or that were emotionally salient enough to keep on their own (marked ⚡flashbulb).",
    "Your job: update `memory/MEMORY.md` so these durable facts are captured there (no duplicates).",
    "",
    "Rules:",
    "- Edit MEMORY.md in place (Edit tool). Keep existing structure.",
    "- Do NOT add routine chatter; only genuinely durable facts (rules, people, systems, lessons) —",
    "  EXCEPT ⚡flashbulb items, which earned their place by emotional weight even if recalled once.",
    "- If a fact is already in MEMORY.md, refine/merge rather than duplicate.",
    "- Cite the source daily note in a parenthetical like `(2026-04-23 thread ...)` only when it helps traceability.",
    "- Keep MEMORY.md under ~300 lines. If adding content pushes over, consolidate older sections.",
    "",
    "Candidates:",
    "",
    candidates
      .map(
        (c, i) => {
          const emo = c.emotion && c.emotion !== "neutral"
            ? `, emotion ${c.emotion}/${(c.emotionIntensity ?? 0).toFixed(2)}`
            : "";
          const flash = c.flashbulb ? " ⚡flashbulb" : "";
          return `### ${i + 1}. ${c.path}:${c.startLine}-${c.endLine}  (score ${c.score.toFixed(2)}${flash}, recalls ${c.recallCount}, days ${c.dailyCount}${emo}, tags ${c.conceptTags.join(",") || "-"})\n${c.snippet.slice(0, 800)}`;
        },
      )
      .join("\n\n"),
    "",
    "Respond with a ≤10-bullet list of what you added/updated.",
  ].join("\n");

  const proc = Bun.spawn(
    [
      "claude",
      "-p",
      promptBody,
      "--output-format",
      "stream-json",
      "--verbose",
      "--max-turns",
      "8",
      "--add-dir",
      MEMORY_DIR,
      "--permission-mode",
      "acceptEdits",
    ],
    {
      cwd: FRIDAY_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FRIDAY_SPAWNED: "1" },
    },
  );

  let finalText = "";
  const decoder = new TextDecoder();
  const reader = proc.stdout.getReader();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (evt.type === "result" && typeof evt.result === "string") {
          finalText = evt.result;
        }
      } catch {
        /* skip non-json */
      }
    }
  }
  await proc.exited;
  return finalText.trim() || "Deep phase completed (no summary returned).";
}
