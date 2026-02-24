import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Readable, Writable } from "node:stream";
import { ToolRegistry } from "./tool-registry.js";
import { parseNamespacedName } from "./tool-namespacing.js";
import type { UpstreamClient } from "../upstream/types.js";

export interface BridgeServerOptions {
  stdin?: Readable;
  stdout?: Writable;
  toolRegistry?: ToolRegistry;
  getUpstreamClient?: (name: string) => UpstreamClient | undefined;
}

export class BridgeServer {
  private server: Server;
  private toolRegistry: ToolRegistry;
  private unsubscribe: (() => void) | undefined;
  private options: BridgeServerOptions;

  constructor(options?: BridgeServerOptions) {
    this.options = options ?? {};
    this.toolRegistry = options?.toolRegistry ?? new ToolRegistry();

    this.server = new Server(
      { name: "kokuai-bridge", version: "0.1.0" },
      { capabilities: { tools: { listChanged: true } } },
    );

    this.server.setRequestHandler(ListToolsRequestSchema, () => {
      return { tools: this.toolRegistry.listTools() };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const registered = this.toolRegistry.getTool(name);

      if (!registered) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Unknown tool: ${name}`,
        );
      }

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
    });

    this.unsubscribe = this.toolRegistry.onChanged(() => {
      this.server.sendToolListChanged().catch(() => {
        // Ignore errors when no client is connected
      });
    });
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
