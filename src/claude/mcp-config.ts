import path from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";

const FRIDAY_ROOT = path.resolve(import.meta.dir, "../..");
const MCP_TMP_DIR = "/tmp/friday-mcp";

export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

/**
 * Generate a per-thread MCP config JSON file.
 * Returns the path to the generated file.
 */
export function generateMcpConfig(threadId: string): string {
  mkdirSync(MCP_TMP_DIR, { recursive: true });

  const config: McpConfig = {
    mcpServers: {
      "friday-slack": {
        command: "bun",
        args: [path.join(FRIDAY_ROOT, "mcp", "slack-server.ts")],
      },
      "friday-status": {
        command: "bun",
        args: [path.join(FRIDAY_ROOT, "mcp", "friday-status-server.ts")],
      },
    },
  };

  const configPath = path.join(MCP_TMP_DIR, `${threadId}.json`);
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}
