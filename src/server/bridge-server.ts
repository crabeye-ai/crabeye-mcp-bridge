import {
  serveStdio,
  StdioServerTransport,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";
import { Server, ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import type {
  CallToolResult,
  InputRequiredResult,
  ProtocolEra,
  ServerContext,
  Transport,
} from "@modelcontextprotocol/server";
import type { Readable, Writable } from "node:stream";
import { ToolRegistry } from "./tool-registry.js";
import { parseNamespacedName } from "./tool-namespacing.js";
import { ApprovalFlow } from "./policy-approval.js";
import { ClientMetadata } from "./client-metadata.js";
import type { ConnectionStatus, UpstreamClient } from "../upstream/types.js";
import {
  ToolSearchService,
  SEARCH_TOOL_NAME,
  RUN_TOOL_NAME,
  searchToolDefinition,
  runToolDefinition,
} from "../search/index.js";
import type { SearchToolsParams } from "../search/index.js";
import type { PolicyEngine } from "../policy/index.js";
import { SessionStats } from "./session-stats.js";
import type { SessionStatsSnapshot } from "./session-stats.js";
import type { RateLimiter } from "./rate-limiter.js";
import type { Logger } from "../logging/index.js";
import { APP_NAME, APP_VERSION } from "../constants.js";

const WAIT_FOR_RESPAWN_MS = 60_000;

const BASE_INSTRUCTIONS = [
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
  "Skip search_tools when you already have everything you need to call the tool. If a server below documents a tool with its full input schema (or the tool is already auto-enabled), call it directly via run_tool — searching first only burns a round-trip. Search remains required when you don't yet know the namespaced tool name or its arguments.",
  "",
  "Discovery workflow:",
  '1. Start broad: search by provider or category to get summaries: { "queries": [{ "provider": "linear" }] }',
  '2. Drill in: use a tool filter or expand_tools to get full definitions: { "queries": [{ "provider": "linear", "expand_tools": true }] } or { "queries": [{ "tool": "create", "provider": "linear" }] }',
  "",
  "Results are always grouped by provider: results[].providers[].tools[]",
  "After discovering tools, use run_tool to execute them. You can also call auto-enabled tools directly by their namespaced name.",
  "When in doubt, search — it is always better to search and find nothing than to miss an available tool.",
].join("\n");

export interface BridgeServerOptions {
  stdin?: Readable;
  stdout?: Writable;
  toolRegistry?: ToolRegistry;
  toolSearchService?: ToolSearchService;
  policyEngine?: PolicyEngine;
  getUpstreamClient?: (name: string) => UpstreamClient | undefined;
  getRateLimiter?: (name: string) => RateLimiter | undefined;
  logger?: Logger;
  showStats?: boolean;
  onSearchStats?: (stats: SessionStatsSnapshot) => void;
  /**
   * Optional renderer for the per-server `_bridge.passthrough` blocks.
   * When provided, the returned string is appended after the base bridge
   * instructions on every regenerate. Empty string means no servers
   * contributed (or no upstreams are connected yet).
   */
  buildPassthrough?: () => string;
}

interface Connection {
  readonly client: ClientMetadata;
  clientLogged: boolean;
}

function observeStart(transport: Transport): {
  started: Promise<void>;
  stopObserving: () => void;
} {
  const originalStart = transport.start;
  let settleWith!: (startResult: Promise<void>) => void;
  const started = new Promise<void>((resolve, reject) => {
    settleWith = (startResult) => startResult.then(resolve, reject);
  });
  transport.start = () => {
    const startResult = originalStart.call(transport);
    settleWith(startResult);
    return startResult;
  };
  return {
    started,
    stopObserving: () => {
      transport.start = originalStart;
    },
  };
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export class BridgeServer {
  private server: Server | undefined;
  private handle: StdioServerHandle | undefined;
  private toolRegistry: ToolRegistry;
  private toolSearchService: ToolSearchService | undefined;
  private policyEngine: PolicyEngine | undefined;
  private sessionStats: SessionStats | undefined;
  private approval = new ApprovalFlow();
  private unsubscribe: (() => void) | undefined;
  private options: BridgeServerOptions;

  constructor(options?: BridgeServerOptions) {
    this.options = options ?? {};
    this.toolRegistry = options?.toolRegistry ?? new ToolRegistry();
    this.toolSearchService = options?.toolSearchService;
    this.policyEngine = options?.policyEngine;

    if (this.toolSearchService) {
      this.sessionStats = new SessionStats(
        this.toolRegistry,
        [searchToolDefinition, runToolDefinition],
      );
    }

    this.subscribeToolListChanged();
  }

  private subscribeToolListChanged(): void {
    if (this.unsubscribe) return;
    const notify = () => {
      this.server?.sendToolListChanged().catch(() => {
      });
    };
    this.unsubscribe = this.toolSearchService
      ? this.toolSearchService.onVisibleToolsChanged(notify)
      : this.toolRegistry.onChanged(notify);
  }

  private buildServer(era: ProtocolEra): Server {
    const server = new Server(
      { name: APP_NAME, version: APP_VERSION },
      {
        capabilities: { tools: { listChanged: true } },
        instructions: this.composeInstructions(),
        requestState: { verify: this.approval.verify },
      },
    );

    const connection: Connection = {
      client: new ClientMetadata(era, server),
      clientLogged: false,
    };
    server.oninitialized = () => this.logClientOnce(connection);

    server.setRequestHandler("tools/list", (_request, ctx) => {
      this.logClientOnce(connection, ctx);
      if (this.toolSearchService) {
        return { tools: this.toolSearchService.getVisibleTools() };
      }
      return { tools: this.toolRegistry.listTools() };
    });

    server.setRequestHandler("tools/call", async (request, ctx) => {
      this.logClientOnce(connection, ctx);
      const { name, arguments: args } = request.params;

      if (this.toolSearchService && name === SEARCH_TOOL_NAME) {
        return this.handleSearchTools(this.toolSearchService, args);
      }
      if (this.toolSearchService && name === RUN_TOOL_NAME) {
        return this.handleRunTool(args, ctx, connection);
      }

      // Direct tool call (tool must be in registry)
      if (!this.toolRegistry.getTool(name)) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${name}`);
      }
      return this.routeToUpstream(name, args, ctx, connection);
    });

    this.options.logger?.info("server instance built", { component: "bridge", era });

    this.server = server;
    return server;
  }

  private logClientOnce(connection: Connection, ctx?: ServerContext): void {
    if (connection.clientLogged) return;
    const identity = connection.client.identity(ctx);
    if (!identity) return;
    connection.clientLogged = true;
    this.options.logger?.info("client connected", {
      component: "bridge",
      era: connection.client.era,
      clientName: identity.name,
      clientVersion: identity.version,
      protocolVersion: identity.protocolVersion,
    });
  }

  private handleSearchTools(
    service: ToolSearchService,
    args: Record<string, unknown> | undefined,
  ): CallToolResult {
    const params = (args ?? {}) as unknown as SearchToolsParams;

    if (!Array.isArray(params.queries) || params.queries.length === 0) {
      return errorResult("Error: 'queries' must be a non-empty array of query objects.");
    }
    for (let i = 0; i < params.queries.length; i++) {
      const q = params.queries[i];
      if (!q.tool && !q.provider && !q.category) {
        return errorResult(
          `Error: queries[${i}] must have at least one of 'tool', 'provider', or 'category'.`,
        );
      }
    }

    const result = service.search(params);
    let response: object = result;
    if (this.sessionStats) {
      this.sessionStats.recordSearchResponse(JSON.stringify(result));
      const snapshot = this.sessionStats.getSnapshot();
      if (this.options.showStats) {
        response = { session_stats: snapshot, ...result };
      }
      this.options.onSearchStats?.(snapshot);
    }
    return { content: [{ type: "text", text: JSON.stringify(response) }] };
  }

  private handleRunTool(
    args: Record<string, unknown> | undefined,
    ctx: ServerContext,
    connection: Connection,
  ): Promise<CallToolResult | InputRequiredResult> | CallToolResult {
    const toolName = (args as { name?: string })?.name;
    const toolArgs = (args as { arguments?: Record<string, unknown> })?.arguments;

    if (!toolName) {
      return errorResult(
        "Error: 'name' is required — provide the full namespaced tool name (e.g. 'linear__create_issue').",
      );
    }
    return this.routeToUpstream(toolName, toolArgs, ctx, connection);
  }

  private async routeToUpstream(
    name: string,
    args: Record<string, unknown> | undefined,
    ctx: ServerContext,
    connection: Connection,
  ): Promise<CallToolResult | InputRequiredResult> {
    const parsed = parseNamespacedName(name);
    if (!parsed) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Invalid tool name (missing namespace): ${name}`,
      );
    }

    if (this.policyEngine) {
      const toolKey = `${parsed.source}__${parsed.toolName}`;
      const decision = this.policyEngine.evaluate(parsed.source, parsed.toolName, args);
      if (decision.kind === "deny") {
        throw new ProtocolError(ProtocolErrorCode.InvalidRequest, decision.reason);
      }
      if (decision.kind === "prompt") {
        if (!connection.client.supportsFormElicitation(ctx)) {
          throw new ProtocolError(
            ProtocolErrorCode.InvalidRequest,
            `Tool ${toolKey} requires confirmation but the client does not support elicitation`,
          );
        }
        const outcome = await this.approval.resolve(toolKey, args, decision.request, ctx);
        if (outcome !== "approved") return outcome;
      }
    }

    const getClient = this.options.getUpstreamClient;
    if (!getClient) {
      throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        `No upstream client resolver configured`,
      );
    }

    const client = getClient(parsed.source);
    if (!client) {
      throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        `Upstream server not found: ${parsed.source}`,
      );
    }

    if (client.status !== "connected") {
      if (client.status === "error") {
        throw new ProtocolError(
          ProtocolErrorCode.InternalError,
          `Upstream server "${parsed.source}" has failed permanently. Please retry later.`,
        );
      }

      // Server is reconnecting — wait for it
      this.options.logger?.info("waiting for server to reconnect", {
        component: "bridge",
        server: parsed.source,
      });

      const reconnected = await this.waitForReconnect(client);

      if (!reconnected) {
        // waitForReconnect resolves false for both "errored" and "timed out".
        // Cast to widen back to the full ConnectionStatus union: the
        // mutable status field can transition during the await, so the
        // narrowing TS inferred before the await is no longer accurate.
        const statusAfterWait = client.status as ConnectionStatus;
        if (statusAfterWait === "error") {
          throw new ProtocolError(
            ProtocolErrorCode.InternalError,
            `Upstream server "${parsed.source}" has failed permanently. Please retry later.`,
          );
        }
        throw new ProtocolError(
          ProtocolErrorCode.InternalError,
          `Upstream server "${parsed.source}" did not reconnect within ${WAIT_FOR_RESPAWN_MS / 1000}s. Please retry in 30 seconds.`,
        );
      }

      this.options.logger?.info("server reconnected, executing tool call", {
        component: "bridge",
        server: parsed.source,
      });
    }

    const rateLimiter = this.options.getRateLimiter?.(parsed.source);
    if (rateLimiter) {
      try {
        await rateLimiter.acquire();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new ProtocolError(ProtocolErrorCode.InternalError, message);
      }
    }

    try {
      return await client.callTool({
        name: parsed.toolName,
        arguments: args,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        `Upstream server "${parsed.source}" error: ${message}`,
      );
    }
  }

  private waitForReconnect(client: UpstreamClient): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      // Edge case: status changed between the check and subscribing
      if (client.status === "connected") {
        resolve(true);
        return;
      }
      if (client.status === "error") {
        resolve(false);
        return;
      }

      const timeout = setTimeout(() => {
        unsubscribe();
        resolve(false);
      }, WAIT_FOR_RESPAWN_MS);

      const unsubscribe = client.onStatusChange((event) => {
        if (event.current === "connected") {
          clearTimeout(timeout);
          unsubscribe();
          resolve(true);
        } else if (event.current === "error") {
          clearTimeout(timeout);
          unsubscribe();
          resolve(false);
        }
      });
    });
  }

  async connect(transport: Transport): Promise<void> {
    if (this.handle) {
      throw new Error("BridgeServer is already connected — close() first");
    }

    const { started, stopObserving } = observeStart(transport);

    this.subscribeToolListChanged();

    const handle = serveStdio((mcpCtx) => this.buildServer(mcpCtx.era), {
      transport,
      onerror: (error) => {
        this.options.logger?.warn("serve transport error", {
          component: "bridge",
          error: error.message,
        });
      },
    });
    this.handle = handle;

    try {
      await started;
    } catch (err) {
      this.handle = undefined;
      this.server = undefined;
      await handle.close().catch(() => {});
      throw err;
    } finally {
      stopObserving();
    }
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
    this.sessionStats?.dispose();
    await this.handle?.close();
    this.handle = undefined;
    this.server = undefined;
  }

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  private composeInstructions(): string {
    const passthrough = this.options.buildPassthrough?.() ?? "";
    if (passthrough.length === 0) return BASE_INSTRUCTIONS;
    return `${BASE_INSTRUCTIONS}\n\n${passthrough}`;
  }
}
