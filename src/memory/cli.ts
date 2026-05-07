#!/usr/bin/env bun
/**
 * CLI for the memory subsystem.
 *   bun run src/memory/cli.ts status
 *   bun run src/memory/cli.ts search "query" [--limit N]
 *   bun run src/memory/cli.ts promote [--limit N] [--apply]
 *   bun run src/memory/cli.ts dream [--dry-run] [--light-only] [--narrative]
 *   bun run src/memory/cli.ts index           # rebuild corpus cache (no-op, cache is mtime-based)
 *   bun run src/memory/cli.ts snapshot <url> [--note "..."] [--no-archive]
 *   bun run src/memory/cli.ts snapshot --text "..." [--source <url>] [--title T]
 */

import { loadRecallStore, loadPhaseSignalStore, markPromoted } from "./recall.ts";
import { searchMemory } from "./search.ts";
import { rankPromotionCandidates, formatCandidates } from "./promote.ts";
import { runDream } from "./dreaming.ts";
import { loadCorpus, invalidateCache } from "./corpus.ts";
import { captureSnapshot } from "./snapshot.ts";
import { reindexIncremental } from "./engram-bridge.ts";

function parseFlag(args: string[], flag: string, hasValue: boolean): string | boolean | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  if (hasValue) {
    const value = args[idx + 1];
    args.splice(idx, 2);
    return value;
  }
  args.splice(idx, 1);
  return true;
}

function positional(args: string[]): string {
  return args.filter((a) => !a.startsWith("--")).join(" ");
}

async function main() {
  const [, , cmd = "help", ...rest] = process.argv;
  const args = [...rest];

  switch (cmd) {
    case "status": {
      const recall = loadRecallStore();
      const signals = loadPhaseSignalStore();
      const corpus = loadCorpus();
      const entries = Object.values(recall.entries);
      const promoted = entries.filter((e) => e.promotedAt).length;
      const unpromoted = entries.length - promoted;
      console.log(JSON.stringify({
        corpus: { snippets: corpus.length },
        recall: {
          total: entries.length,
          promoted,
          unpromoted,
          updatedAt: recall.updatedAt,
        },
        signals: {
          total: Object.keys(signals.entries).length,
          updatedAt: signals.updatedAt,
        },
      }, null, 2));
      break;
    }

    case "search": {
      const limit = Number.parseInt((parseFlag(args, "--limit", true) as string) ?? "10", 10);
      const query = positional(args).trim();
      if (!query) {
        console.error("usage: memory search <query> [--limit N]");
        process.exit(2);
      }
      const results = searchMemory(query, { limit });
      for (const r of results) {
        console.log(`[${r.score.toFixed(2)}] ${r.path}:${r.startLine}-${r.endLine}`);
        console.log(`  tags: ${r.conceptTags?.join(", ") ?? "-"}`);
        console.log(r.snippet.split("\n").map((l) => "  " + l).join("\n"));
        console.log();
      }
      if (results.length === 0) {
        console.log("(no matches)");
      }
      break;
    }

    case "promote": {
      const limit = Number.parseInt((parseFlag(args, "--limit", true) as string) ?? "10", 10);
      const apply = parseFlag(args, "--apply", false) === true;
      const candidates = rankPromotionCandidates({ limit });
      console.log(formatCandidates(candidates));
      if (apply) {
        // Simple "apply" marks them promoted WITHOUT calling Claude —
        // assumes the caller has already written MEMORY.md. For automated
        // rewriting, use `dream` which invokes Claude.
        markPromoted(candidates.map((c) => c.key));
        console.log(`\nMarked ${candidates.length} candidates as promoted.`);
      }
      break;
    }

    case "dream": {
      const dryRun = parseFlag(args, "--dry-run", false) === true;
      const lightOnly = parseFlag(args, "--light-only", false) === true;
      const narrative = parseFlag(args, "--narrative", false) === true;
      const decay = parseFlag(args, "--decay", false) === true;
      const lookback = Number.parseInt((parseFlag(args, "--lookback", true) as string) ?? "3", 10);
      const deepLimit = Number.parseInt((parseFlag(args, "--deep-limit", true) as string) ?? "10", 10);
      const result = await runDream({
        dryRun,
        lightOnly,
        withNarrative: narrative,
        withDecay: decay,
        lightLookbackDays: lookback,
        deepLimit,
      });
      console.log(result.summary);
      break;
    }

    case "index": {
      invalidateCache();
      const corpus = loadCorpus();
      console.log(`Indexed ${corpus.length} snippets across the memory tree.`);
      break;
    }

    case "snapshot": {
      const note = parseFlag(args, "--note", true) as string | undefined;
      const title = parseFlag(args, "--title", true) as string | undefined;
      const source = parseFlag(args, "--source", true) as string | undefined;
      const text = parseFlag(args, "--text", true) as string | undefined;
      const noArchive = parseFlag(args, "--no-archive", false) === true;
      const url = positional(args).trim() || undefined;

      if (!url && !text) {
        console.error("usage: memory snapshot <url> [--note T] [--no-archive]");
        console.error("       memory snapshot --text \"...\" [--source <url>] [--title T]");
        process.exit(2);
      }

      try {
        const r = await captureSnapshot({
          url, text, source, title, note,
          archive: noArchive ? false : undefined,
        });
        console.log(`Snapshot saved: ${r.title}`);
        if (r.source) console.log(`  source:   ${r.source}`);
        console.log(`  archived: ${r.archivedUrl ?? "(none — local copy only)"}`);
        console.log(`  card:     ${r.cardPath}`);
        console.log(`  body:     ${r.bodyPath} (${r.bytes} chars, not embedded)`);
        // Reindex so the tiny card is associatively recallable within seconds.
        // The full body sits in a dotdir and is never embedded.
        await reindexIncremental();
      } catch (err) {
        console.error(`snapshot failed: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
      break;
    }

    case "help":
    default:
      console.log([
        "usage: memory <command> [options]",
        "",
        "commands:",
        "  status                         — print recall/signal/corpus stats",
        "  search <query> [--limit N]     — BM25 search (records recalls)",
        "  promote [--limit N] [--apply]  — rank candidates; --apply marks them promoted",
        "  dream [--dry-run] [--light-only] [--narrative] [--lookback D] [--deep-limit N]",
        "  index                          — force rebuild of the snippet cache",
        "  snapshot <url> [--note T]      — archive a page (wayback + local), recallable card",
        "  snapshot --text \"...\" [--source url] [--title T]",
      ].join("\n"));
      break;
  }
}

await main();
