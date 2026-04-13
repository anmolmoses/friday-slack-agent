import type { AgentDefinition } from "../agents/loader.ts";
import { loadAgentDefinition } from "../agents/loader.ts";

/**
 * Caches parsed agent definitions. Loaded once per agent name, persists for the
 * lifetime of the process. Call `invalidate()` or `clear()` to force reload.
 */
export class AgentCache {
  private cache = new Map<string, AgentDefinition | null>();
  private agentDirs: string[];

  constructor(agentDirs: string[]) {
    this.agentDirs = agentDirs;
  }

  async get(agentType: string): Promise<AgentDefinition | null> {
    if (this.cache.has(agentType)) {
      return this.cache.get(agentType) ?? null;
    }

    // Try each directory in order
    for (const dir of this.agentDirs) {
      const def = await loadAgentDefinition(`${dir}/${agentType}.md`);
      if (def) {
        this.cache.set(agentType, def);
        return def;
      }
    }

    this.cache.set(agentType, null);
    return null;
  }

  invalidate(agentType: string): void {
    this.cache.delete(agentType);
  }

  clear(): void {
    this.cache.clear();
  }
}
