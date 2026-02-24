import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export const NAMESPACE_SEPARATOR = "__";

/**
 * Returns a shallow clone of `tool` with name prefixed as `${source}__${tool.name}`.
 */
export function namespaceTool(source: string, tool: Tool): Tool {
  return { ...tool, name: `${source}${NAMESPACE_SEPARATOR}${tool.name}` };
}

/**
 * Splits a namespaced tool name on the first `__` separator.
 * Returns `undefined` if the name contains no separator.
 */
export function parseNamespacedName(
  name: string,
): { source: string; toolName: string } | undefined {
  const idx = name.indexOf(NAMESPACE_SEPARATOR);
  if (idx === -1) return undefined;
  return {
    source: name.slice(0, idx),
    toolName: name.slice(idx + NAMESPACE_SEPARATOR.length),
  };
}
