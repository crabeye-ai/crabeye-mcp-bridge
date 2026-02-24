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

export interface BridgeServerOptions {
  stdin?: Readable;
  stdout?: Writable;
  toolRegistry?: ToolRegistry;
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

    this.server.setRequestHandler(CallToolRequestSchema, (request) => {
      const { name } = request.params;
      const registered = this.toolRegistry.getTool(name);

      if (!registered) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Unknown tool: ${name}`,
        );
      }

      throw new McpError(
        ErrorCode.InternalError,
        `Tool routing not implemented for: ${name}`,
      );
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
