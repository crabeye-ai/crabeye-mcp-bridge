import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolRegistry } from "./tool-registry.js";

export interface SessionStatsSnapshot {
  tokens_saved: number;
  baseline_tokens: number;
  bridge_tokens: number;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class SessionStats {
  private registry: ToolRegistry;
  private metaToolTokens: number = 0;
  private cumulativeSearchTokens: number = 0;
  private unsubscribe: () => void;

  constructor(registry: ToolRegistry, metaTools: Tool[]) {
    this.registry = registry;
    this.metaToolTokens = estimateTokens(JSON.stringify(metaTools));
    this.unsubscribe = this.registry.onChanged(() => {
      // Baseline recalculated on every snapshot, nothing to cache
    });
  }

  recordSearchResponse(responseJson: string): void {
    this.cumulativeSearchTokens += estimateTokens(responseJson);
  }

  getSnapshot(): SessionStatsSnapshot {
    const allTools = this.registry.listTools();
    const baselineTokens = estimateTokens(JSON.stringify(allTools));
    const bridgeTokens = this.metaToolTokens + this.cumulativeSearchTokens;
    return {
      tokens_saved: Math.max(0, baselineTokens - bridgeTokens),
      baseline_tokens: baselineTokens,
      bridge_tokens: bridgeTokens,
    };
  }

  dispose(): void {
    this.unsubscribe();
  }
}
