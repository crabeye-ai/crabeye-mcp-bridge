import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Readable, Writable } from "node:stream";
import { ToolRegistry } from "./tool-registry.js";
import { parseNamespacedName } from "./tool-namespacing.js";
import type { UpstreamClient } from "../upstream/types.js";
import {
  ToolSearchService,
  SEARCH_TOOL_NAME,
  RUN_TOOL_NAME,
} from "../search/index.js";
import type { SearchToolsParams } from "../search/index.js";
import type { PolicyEngine } from "../policy/index.js";
import { APP_NAME, APP_VERSION } from "../constants.js";

export interface BridgeServerOptions {
  stdin?: Readable;
  stdout?: Writable;
  toolRegistry?: ToolRegistry;
  toolSearchService?: ToolSearchService;
  policyEngine?: PolicyEngine;
  getUpstreamClient?: (name: string) => UpstreamClient | undefined;
}

export class BridgeServer {
  private server: Server;
  private toolRegistry: ToolRegistry;
  private toolSearchService: ToolSearchService | undefined;
  private policyEngine: PolicyEngine | undefined;
  private unsubscribe: (() => void) | undefined;
  private options: BridgeServerOptions;

  constructor(options?: BridgeServerOptions) {
    this.options = options ?? {};
    this.toolRegistry = options?.toolRegistry ?? new ToolRegistry();
    this.toolSearchService = options?.toolSearchService;
    this.policyEngine = options?.policyEngine;

    const instructions = [
      "This MCP bridge connects you to many external tools and services.",
      "You MUST call search_tools BEFORE any of the following:",
      "- The user mentions a service, tool, or MCP server by name",
      "- The user says 'use X', 'with X', 'in X', 'on X', 'via X', or 'through X'",
      "- The user asks you to perform an action that might be handled by an external service (create, update, query, send, manage, etc.)",
      "- The user asks what tools or integrations are available, or what you can do",
      "- The user asks 'can you...?' about a capability that could involve an external service",
      "- You are about to claim a tool is unavailable or that you cannot perform an action — search first, then answer",
      "- You are about to fall back to a web search for something that might be available as a tool",
      "",
      "Discovery workflow:",
      '1. Start broad: search by provider or category to get summaries: { "queries": [{ "provider": "linear" }] }',
      '2. Drill in: use a tool filter or expand_tools to get full definitions: { "queries": [{ "provider": "linear", "expand_tools": true }] } or { "queries": [{ "tool": "create", "provider": "linear" }] }',
      "",
      "Results are always grouped by provider: results[].providers[].tools[]",
      "After discovering tools, use run_tool to execute them. You can also call auto-enabled tools directly by their namespaced name.",
      "When in doubt, search — it is always better to search and find nothing than to miss an available tool.",
    ].join("\n");

    this.server = new Server(
      { name: APP_NAME, version: APP_VERSION },
      {
        capabilities: { tools: { listChanged: true } },
        instructions,
      },
    );

    this.server.setRequestHandler(ListToolsRequestSchema, () => {
      if (this.toolSearchService) {
        return { tools: this.toolSearchService.getVisibleTools() };
      }
      return { tools: this.toolRegistry.listTools() };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      // Handle search_tools call
      if (this.toolSearchService && name === SEARCH_TOOL_NAME) {
        const params = (args ?? {}) as SearchToolsParams;

        if (!Array.isArray(params.queries) || params.queries.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: 'queries' must be a non-empty array of query objects.",
              },
            ],
            isError: true,
          };
        }

        for (let i = 0; i < params.queries.length; i++) {
          const q = params.queries[i];
          if (!q.tool && !q.provider && !q.category) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Error: queries[${i}] must have at least one of 'tool', 'provider', or 'category'.`,
                },
              ],
              isError: true,
            };
          }
        }

        const result = this.toolSearchService.search(params);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      }

      // Handle run_tool call
      if (this.toolSearchService && name === RUN_TOOL_NAME) {
        const toolName = (args as { name?: string })?.name;
        const toolArgs = (args as { arguments?: Record<string, unknown> })?.arguments;

        if (!toolName) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: 'name' is required — provide the full namespaced tool name (e.g. 'linear__create_issue').",
              },
            ],
            isError: true,
          };
        }

        return this.routeToUpstream(toolName, toolArgs);
      }

      // Direct tool call (tool must be in registry)
      const registered = this.toolRegistry.getTool(name);
      if (!registered) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Unknown tool: ${name}`,
        );
      }

      return this.routeToUpstream(name, args);
    });

    if (this.toolSearchService) {
      this.unsubscribe = this.toolSearchService.onVisibleToolsChanged(() => {
        this.server.sendToolListChanged().catch(() => {
          // Ignore errors when no client is connected
        });
      });
    } else {
      this.unsubscribe = this.toolRegistry.onChanged(() => {
        this.server.sendToolListChanged().catch(() => {
          // Ignore errors when no client is connected
        });
      });
    }
  }

  private async routeToUpstream(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const parsed = parseNamespacedName(name);
    if (!parsed) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid tool name (missing namespace): ${name}`,
      );
    }

    if (this.policyEngine) {
      const elicitFn = this.server.elicitInput.bind(this.server);
      await this.policyEngine.enforce(parsed.source, parsed.toolName, args, elicitFn);
    }

    const getClient = this.options.getUpstreamClient;
    if (!getClient) {
      throw new McpError(
        ErrorCode.InternalError,
        `No upstream client resolver configured`,
      );
    }

    const client = getClient(parsed.source);
    if (!client) {
      throw new McpError(
        ErrorCode.InternalError,
        `Upstream server not found: ${parsed.source}`,
      );
    }

    if (client.status !== "connected") {
      throw new McpError(
        ErrorCode.InternalError,
        `Upstream server "${parsed.source}" is not connected (status: ${client.status})`,
      );
    }

    try {
      return await client.callTool({
        name: parsed.toolName,
        arguments: args,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new McpError(
        ErrorCode.InternalError,
        `Upstream server "${parsed.source}" error: ${message}`,
      );
    }
  }

  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport(
      this.options.stdin,
      this.options.stdout,
    );
    await this.connect(transport);
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.server.close();
  }

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }
}
