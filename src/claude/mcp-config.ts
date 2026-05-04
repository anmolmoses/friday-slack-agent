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

  const servers: Record<string, McpServerConfig> = {
    "friday-slack": {
      command: "npx",
      args: ["bun", path.join(FRIDAY_ROOT, "mcp", "slack-server.ts")],
    },
    "friday-status": {
      command: "npx",
      args: ["bun", path.join(FRIDAY_ROOT, "mcp", "friday-status-server.ts")],
    },
  };

  // Production MongoDB, read-only. `--readOnly` blocks all write operations
  // at the MCP server level regardless of what the underlying DB user is
  // allowed to do, so Friday physically cannot mutate production data.
  const mongoUri = process.env.MONGODB_URI;
  if (mongoUri) {
    servers["mongodb"] = {
      command: "npx",
      args: ["-y", "mongodb-mcp-server@latest", "--readOnly"],
      env: { MDB_MCP_CONNECTION_STRING: mongoUri },
    };
  }

  const config: McpConfig = { mcpServers: servers };
  const configPath = path.join(MCP_TMP_DIR, `${threadId}.json`);
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}
