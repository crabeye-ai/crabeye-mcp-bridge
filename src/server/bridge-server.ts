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

export interface BridgeServerOptions {
  stdin?: Readable;
  stdout?: Writable;
  toolRegistry?: ToolRegistry;
  toolSearchService?: ToolSearchService;
  getUpstreamClient?: (name: string) => UpstreamClient | undefined;
}

export class BridgeServer {
  private server: Server;
  private toolRegistry: ToolRegistry;
  private toolSearchService: ToolSearchService | undefined;
  private unsubscribe: (() => void) | undefined;
  private options: BridgeServerOptions;

  constructor(options?: BridgeServerOptions) {
    this.options = options ?? {};
    this.toolRegistry = options?.toolRegistry ?? new ToolRegistry();
    this.toolSearchService = options?.toolSearchService;

    this.server = new Server(
      { name: "crabeye-mcp-bridge", version: "0.1.0" },
      { capabilities: { tools: { listChanged: true } } },
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
        const hasInput =
          (params.queries && params.queries.length > 0) ||
          (params.providers && params.providers.length > 0) ||
          (params.categories && params.categories.length > 0);

        if (!hasInput) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: At least one of 'queries', 'providers', or 'categories' must be specified.",
              },
            ],
            isError: true,
          };
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
