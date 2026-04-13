import path from "node:path";
import type { Config } from "../config.ts";
import type { ThreadSession } from "../session/types.ts";
import type { AgentDefinition } from "../agents/loader.ts";

const FRIDAY_ROOT = path.resolve(import.meta.dir, "../..");

export function buildClaudeArgs(
  session: ThreadSession,
  prompt: string,
  config: Config["claude"],
  agentDef?: AgentDefinition | null,
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

  if (session.systemPrompt) {
    args.push("--append-system-prompt", session.systemPrompt);
  }

  // Memory system: inject instructions and give access to memory directory
  const memoryDir = path.join(FRIDAY_ROOT, "memory");
  const instructionsFile = path.join(memoryDir, "instructions.md");
  args.push("--add-dir", memoryDir);
  args.push("--append-system-prompt-file", instructionsFile);

  // Prompt cache optimization
  args.push("--exclude-dynamic-system-prompt-sections");

  // Agent-specific: model, effort, tool restrictions
  if (agentDef) {
    if (agentDef.model) {
      args.push("--model", resolveModel(agentDef.model));
    }
    if (agentDef.effort) {
      args.push("--effort", agentDef.effort);
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

  args.push("--permission-mode", config.permissionMode);

  return args;
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
