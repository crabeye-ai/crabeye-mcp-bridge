import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface RegisteredTool {
  source: string;
  tool: Tool;
}

export type ToolListChangedCallback = () => void;

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();
  private sourceIndex = new Map<string, Set<string>>();
  private sourceCategories = new Map<string, string>();
  private listeners = new Set<ToolListChangedCallback>();

  listTools(): Tool[] {
    return Array.from(this.tools.values()).map((r) => r.tool);
  }

  listRegisteredTools(): RegisteredTool[] {
    return Array.from(this.tools.values());
  }

  listSources(): { name: string; toolCount: number }[] {
    const result: { name: string; toolCount: number }[] = [];
    for (const [name, toolNames] of this.sourceIndex) {
      result.push({ name, toolCount: toolNames.size });
    }
    return result;
  }

  getTool(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  setCategoryForSource(source: string, category: string): void {
    this.sourceCategories.set(source, category);
  }

  getCategoryForSource(source: string): string | undefined {
    return this.sourceCategories.get(source);
  }

  setToolsForSource(source: string, tools: Tool[]): void {
    const oldNames = this.sourceIndex.get(source);
    if (oldNames) {
      for (const name of oldNames) {
        this.tools.delete(name);
      }
    }

    const newNames = new Set<string>();
    for (const tool of tools) {
      this.tools.set(tool.name, { source, tool });
      newNames.add(tool.name);
    }
    this.sourceIndex.set(source, newNames);

    this.notify();
  }

  removeSource(source: string): void {
    const names = this.sourceIndex.get(source);
    if (!names || names.size === 0) {
      this.sourceIndex.delete(source);
      return;
    }

    let removed = false;
    for (const name of names) {
      const current = this.tools.get(name);
      if (current && current.source === source) {
        this.tools.delete(name);
        removed = true;
      }
    }
    this.sourceIndex.delete(source);
    this.sourceCategories.delete(source);

    if (removed) {
      this.notify();
    }
  }

  onChanged(callback: ToolListChangedCallback): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Listeners must not throw, but don't let one block others
      }
    }
  }
}
