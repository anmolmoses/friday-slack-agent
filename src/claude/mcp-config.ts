import path from "node:path";
import os from "node:os";
import { writeFileSync, mkdirSync } from "node:fs";

const FRIDAY_ROOT = path.resolve(import.meta.dir, "../..");
const MCP_TMP_DIR = "/tmp/friday-mcp";

/**
 * Persistent browser profile. The Playwright MCP reuses this user-data-dir on
 * every run, so cookies/SSO sessions survive between spawns. Log in once with
 * `bin/browser-login.sh` (headed) and every subsequent headless run is already
 * authenticated — this is what lets Friday open GX-Team-gated Notion pages,
 * Google Docs, and internal tools instead of bouncing in a redirect loop.
 */
const BROWSER_PROFILE_DIR = path.join(os.homedir(), ".friday", "browser-profile");

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
    // Browser automation against a PERSISTENT profile so gated pages work.
    // Pinned here (not just root .mcp.json) so it's in the config we pass via
    // --mcp-config regardless of CLI merge behaviour.
    "playwright": {
      command: "npx",
      args: ["@playwright/mcp", "--headless", "--user-data-dir", BROWSER_PROFILE_DIR],
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

  // Native Notion access (structured, not browser-scraped). Set NOTION_TOKEN in
  // Friday's env to an internal-integration token, then share the relevant
  // pages/databases with that integration. We build the OpenAPI auth header
  // here so it works across @notionhq/notion-mcp-server versions.
  const notionToken = process.env.NOTION_TOKEN;
  if (notionToken) {
    servers["notion"] = {
      command: "npx",
      args: ["-y", "@notionhq/notion-mcp-server"],
      env: {
        OPENAPI_MCP_HEADERS: JSON.stringify({
          Authorization: `Bearer ${notionToken}`,
          "Notion-Version": "2022-06-28",
        }),
      },
    };
  }

  const config: McpConfig = { mcpServers: servers };
  const configPath = path.join(MCP_TMP_DIR, `${threadId}.json`);
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}
