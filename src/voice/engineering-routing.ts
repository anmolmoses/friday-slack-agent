import type { VoiceRepo } from "./config.ts";
import { inferRepoFromText } from "../slack/routing.ts";

export interface ResolvedVoiceRepo {
  name: string;
  path: string;
  reason: string;
}

export type EngineeringEngine = "codex" | "claude";

export interface CodexDispatchCommandArgs {
  repoPath: string;
  promptPath: string;
  enableSearch?: boolean;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  approval?: "untrusted" | "on-failure" | "on-request" | "never";
}

export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

export function buildCodexDispatchCommand(args: CodexDispatchCommandArgs): string {
  const approval = args.approval ?? "never";
  const sandbox = args.sandbox ?? "danger-full-access";
  const topLevelOptions = [
    "codex",
    `--ask-for-approval ${approval}`,
    args.enableSearch === false ? "" : "--search",
  ].filter(Boolean);
  const execOptions = [
    "exec",
    `--sandbox ${sandbox}`,
    `--cd ${shellQuote(args.repoPath)}`,
    "-",
    `< ${shellQuote(args.promptPath)}`,
  ];
  return [
    `cd ${shellQuote(args.repoPath)}`,
    [...topLevelOptions, ...execOptions].join(" "),
    "printf '\\n[Friday voice Codex dispatch complete]\\n'",
  ].join(" && ");
}

export function resolveVoiceRepo(args: {
  prompt: string;
  repo?: string;
  configured: VoiceRepo[];
  fallbackPath: string;
}): ResolvedVoiceRepo {
  const { prompt, repo, configured, fallbackPath } = args;
  const names = configured.map((r) => r.name);
  const lower = (s: string) => s.toLowerCase();

  if (repo) {
    const explicit = configured.find((r) => lower(r.name) === lower(repo));
    if (explicit) {
      return {
        name: explicit.name,
        path: explicit.path,
        reason: `explicit repo "${repo}"`,
      };
    }
  }

  const fromUrl = inferRepoFromText(prompt, names);
  if (fromUrl) {
    const match = configured.find((r) => r.name === fromUrl);
    if (match) return { name: match.name, path: match.path, reason: "GitHub URL" };
  }

  for (const r of configured) {
    const escaped = r.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (
      new RegExp(`(^|[^a-z0-9_-])${escaped}([^a-z0-9_-]|$)`, "i").test(prompt)
    ) {
      return {
        name: r.name,
        path: r.path,
        reason: `repo name "${r.name}" mentioned`,
      };
    }
  }

  if (/\b(friday|voice route|voice daemon|voice agent|realtime voice|hud|engram)\b/i.test(prompt)) {
    return {
      name: "friday",
      path: fallbackPath,
      reason: "keyword alias -> friday",
    };
  }

  const aliases: Array<[RegExp, string]> = [
    [
      /\b(api|backend|server|cron|mongo|database|db|payments?|endpoint|route|controller|service|migration|schema|auth|socket|websocket|queue|worker)\b/i,
      "example-backend",
    ],
    [
      /\b(mobile|app|expo|react native|ios|android|ota|eas)\b/i,
      "example-mobile",
    ],
    [
      /\b(web|website|next|landing|frontend|client next|react component|component|page|ui)\b/i,
      "example-web",
    ],
    [/\b(admin|dashboard|internal tool)\b/i, "example-admin"],
    [/\b(talent|candidate|recruit)\b/i, "example-talent-client"],
    [/\b(slack lookup|slack-lookup)\b/i, "slack-lookup"],
    [
      /\b(built at example|built-at-example|portfolio)\b/i,
      "Example-Internal",
    ],
  ];
  for (const [pattern, name] of aliases) {
    if (!pattern.test(prompt)) continue;
    const match = configured.find((r) => r.name === name);
    if (match) {
      return {
        name: match.name,
        path: match.path,
        reason: `keyword alias -> ${name}`,
      };
    }
  }

  return {
    name: "friday",
    path: fallbackPath,
    reason: "no repo inferred; using Friday repo",
  };
}

export function resolveEngineeringEngine(engine = "auto"): EngineeringEngine {
  return engine.toLowerCase() === "claude" ? "claude" : "codex";
}
