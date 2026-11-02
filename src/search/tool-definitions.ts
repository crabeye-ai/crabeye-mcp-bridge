import type { Tool } from "@modelcontextprotocol/server";
import { DEFAULT_LIMIT, MAX_LIMIT } from "./limits.js";

export const SEARCH_TOOL_NAME = "search_tools";
export const RUN_TOOL_NAME = "run_tool";

export const searchToolDefinition: Tool = {
  name: SEARCH_TOOL_NAME,
  description: [
    "Search for available tools across all connected MCP servers. ALWAYS call this BEFORE claiming a tool is unavailable, before web search fallback, or when the user mentions any service/tool/integration.",
    "",
    "Discovery workflow:",
    "1. Search by provider or category to get provider summaries (tool counts, no details)",
    "2. If you need the tools, drill in with a tool filter or expand_tools: true to get full tool definitions",
    "",
    "When to use:",
    "- User mentions a service or tool by name — search by provider name first",
    "- User wants to perform an action (create, update, query, etc.) — search by tool keyword",
    "- User asks what tools or integrations are available — search by provider or category for summaries",
    "- User asks 'can you...?' about external capabilities — search before answering",
    "- You need a tool you haven't seen yet — every tool from the connected servers is found through this search",
    "",
    "Response shape: results[].providers[].tools[]",
    "Without a tool filter, only provider summaries are returned (name, category, tool_count). Use a tool query or expand_tools: true to get full tool definitions.",
    "Use text queries for fuzzy search or prefix with regex: for precise pattern matching.",
    "Each query object can have its own filters and pagination.",
  ].join("\n"),
  inputSchema: {
    type: "object" as const,
    properties: {
      queries: {
        type: "array",
        items: {
          type: "object",
          properties: {
            tool: {
              type: "string",
              description:
                "Text search query to match tool names and descriptions. " +
                "Prefix with regex: for regex matching (e.g. \"regex:.*issue.*\"). " +
                "Prefer passing several queries covering synonyms and related terms to minimize round-trips.",
            },
            provider: {
              type: "string",
              description:
                "Filter by upstream server/provider name. " +
                "Prefix match by default (e.g. \"git\" matches \"github\"). " +
                "Use regex: prefix for patterns (e.g. \"regex:^(linear|figma)$\").",
            },
            category: {
              type: "string",
              description:
                "Filter by tool category (configured via _bridge.category in server config). " +
                "Prefix match by default. Use regex: prefix for patterns.",
            },
            expand_tools: {
              type: "boolean",
              description:
                "When true, return full tool definitions for all tools from matched providers. " +
                "Without this, provider-only queries return summaries (name, tool_count) without tool details. " +
                "Ignored when a tool filter is present (tool filter always returns details).",
            },
            limit: {
              type: "number",
              description: `Maximum number of tool results for this query (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`,
            },
            offset: {
              type: "number",
              description: "Number of tool results to skip for pagination (default 0)",
            },
          },
        },
        description:
          "Array of query objects. Each query is self-contained with its own filters and pagination. " +
          "Results are deduplicated across queries — first query wins. " +
          "Each query must have at least one of: tool, provider, category.",
      },
    },
    required: ["queries"],
  },
};

export const runToolDefinition: Tool = {
  name: RUN_TOOL_NAME,
  description: [
    "Execute any tool from any connected MCP server by its full namespaced name (provider__tool_name format).",
    "Use this after discovering tools via search_tools.",
    "Pass the exact namespaced name from search results and the required arguments.",
  ].join("\n"),
  inputSchema: {
    type: "object" as const,
    properties: {
      name: {
        type: "string",
        description:
          "The full namespaced tool name to call (e.g. 'linear__create_issue')",
      },
      arguments: {
        type: "object",
        description: "Arguments to pass to the tool",
      },
    },
    required: ["name"],
  },
};
