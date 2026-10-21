import {
  serveStdio,
  StdioServerTransport,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";
import { Server, ProtocolError, ProtocolErrorCode, isJSONRPCRequest } from "@modelcontextprotocol/server";
import type {
  CallToolResult,
  InputRequiredResult,
  JSONRPCMessage,
  ProtocolEra,
  ServerContext,
  Transport,
} from "@modelcontextprotocol/server";
import type { Readable, Writable } from "node:stream";
import { ToolRegistry } from "./tool-registry.js";
import { parseNamespacedName } from "./tool-namespacing.js";
import { ApprovalFlow } from "./policy-approval.js";
import { ClientMetadata } from "./client-metadata.js";
import {
  awaitConnectedClient,
  cancelledError,
  reauthorizationError,
  removedError,
  untilSettledOrCancelled,
} from "./upstream-wait.js";
import type { UpstreamClient } from "../upstream/types.js";
import {
  ToolSearchService,
  SEARCH_TOOL_NAME,
  RUN_TOOL_NAME,
  searchToolDefinition,
  runToolDefinition,
} from "../search/index.js";
import type { SearchToolsParams } from "../search/index.js";
import type { PolicyDecision, PolicyEngine } from "../policy/index.js";
import { SessionStats } from "./session-stats.js";
import type { SessionStatsSnapshot } from "./session-stats.js";
import { RateLimiterDisposedError, type RateLimiter } from "./rate-limiter.js";
import type { Logger } from "../logging/index.js";
import { APP_NAME, APP_VERSION } from "../constants.js";

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
  "Skip search_tools when you already have everything you need to call the tool. If a server below documents a tool with its full input schema, call it via run_tool right away — searching first only burns a round-trip. Search remains required when you don't yet know the namespaced tool name or its arguments.",
  "",
  "Discovery workflow:",
  '1. Start broad: search by provider or category to get summaries: { "queries": [{ "provider": "linear" }] }',
  '2. Drill in: use a tool filter or expand_tools to get full definitions: { "queries": [{ "provider": "linear", "expand_tools": true }] } or { "queries": [{ "tool": "create", "provider": "linear" }] }',
  "",
  "Results are always grouped by provider: results[].providers[].tools[]",
  "After discovering tools, use run_tool to execute them; it is the only way to call them.",
  "When in doubt, search — it is always better to search and find nothing than to miss an available tool.",
].join("\n");

export interface BridgeServerOptions {
  stdin?: Readable;
  stdout?: Writable;
  toolRegistry?: ToolRegistry;
  toolSearchService?: ToolSearchService;
  policyEngine?: PolicyEngine;
  getUpstreamClient?: (name: string) => UpstreamClient | undefined;
  whenUpstreamRegistered?: (name: string) => Promise<void>;
  getRateLimiter?: (name: string) => RateLimiter | undefined;
  onClientsChanged?: (listener: () => void) => () => void;
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

function interceptStart(transport: Transport, beforeStart: () => void): {
  started: Promise<void>;
  restoreStart: () => void;
} {
  const originalStart = transport.start;
  let settleWith!: (startResult: Promise<void>) => void;
  const started = new Promise<void>((resolve, reject) => {
    settleWith = (startResult) => startResult.then(resolve, reject);
  });
  transport.start = () => {
    beforeStart();
    const startResult = originalStart.call(transport);
    settleWith(startResult);
    return startResult;
  };
  return {
    started,
    restoreStart: () => {
      transport.start = originalStart;
    },
  };
}

function isVersionProbe(message: JSONRPCMessage): boolean {
  return isJSONRPCRequest(message) && message.method === "server/discover";
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

const BRIDGE_TOOLS = [searchToolDefinition, runToolDefinition];

function directCallError(name: string): ProtocolError {
  const quoted = JSON.stringify(name);
  const advice = parseNamespacedName(name)
    ? `Call ${quoted} through run_tool: { "name": ${quoted}, "arguments": { ... } }.`
    : `Unknown tool ${quoted}; call upstream tools through run_tool.`;
  return new ProtocolError(ProtocolErrorCode.InvalidParams, `${advice} This bridge's only tools are search_tools and run_tool.`);
}

function throwIfDenied(decision: PolicyDecision | undefined): void {
  if (decision?.kind === "deny") throw new ProtocolError(ProtocolErrorCode.InvalidRequest, decision.reason);
}

export class BridgeServer {
  private handle: StdioServerHandle | undefined;
  private toolRegistry: ToolRegistry;
  private toolSearchService: ToolSearchService;
  private policyEngine: PolicyEngine | undefined;
  private sessionStats: SessionStats;
  private approval = new ApprovalFlow();
  private options: BridgeServerOptions;
  private markSessionStarted!: () => void;
  private readonly sessionStart: Promise<void>;

  constructor(options?: BridgeServerOptions) {
    this.options = options ?? {};
    this.sessionStart = new Promise<void>((resolve) => {
      this.markSessionStarted = resolve;
    });
    this.toolRegistry = options?.toolRegistry ?? new ToolRegistry();
    this.policyEngine = options?.policyEngine;
    this.toolSearchService = options?.toolSearchService ?? new ToolSearchService(this.toolRegistry, this.policyEngine);
    this.sessionStats = new SessionStats(this.toolRegistry, BRIDGE_TOOLS);
  }

  private buildServer(era: ProtocolEra): Server {
    const server = new Server(
      { name: APP_NAME, version: APP_VERSION },
      {
        capabilities: { tools: {} },
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
      this.markSessionStarted();
      this.logClientOnce(connection, ctx);
      return { tools: BRIDGE_TOOLS };
    });

    server.setRequestHandler("tools/call", async (request, ctx) => {
      this.markSessionStarted();
      this.logClientOnce(connection, ctx);
      const { name, arguments: args } = request.params;

      if (name === SEARCH_TOOL_NAME) return this.handleSearchTools(args);
      if (name === RUN_TOOL_NAME) return this.handleRunTool(args, ctx, connection);
      throw directCallError(name);
    });

    this.options.logger?.info("server instance built", { component: "bridge", era });
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

  private handleSearchTools(args: Record<string, unknown> | undefined): CallToolResult {
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

    const result = this.toolSearchService.search(params);
    this.sessionStats.recordSearchResponse(JSON.stringify(result));
    const snapshot = this.sessionStats.getSnapshot();
    const response: object = this.options.showStats ? { session_stats: snapshot, ...result } : result;
    this.options.onSearchStats?.(snapshot);
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

    const toolKey = `${parsed.source}__${parsed.toolName}`;
    const decision = this.policyEngine?.evaluate(parsed.source, parsed.toolName, args);
    throwIfDenied(decision);
    if (decision?.kind === "prompt") {
      if (!connection.client.supportsFormElicitation(ctx)) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidRequest,
          `Tool ${toolKey} requires confirmation but the client does not support elicitation`,
        );
      }
      const outcome = await this.approval.resolve(toolKey, args, decision.request, ctx);
      if (outcome !== "approved") return outcome;
    }

    const getClient = this.options.getUpstreamClient;
    if (!getClient) {
      throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        `No upstream client resolver configured`,
      );
    }

    const signal = ctx.mcpReq.signal;
    if (!getClient(parsed.source)) await this.awaitPendingRegistration(parsed.source, signal);
    if (!getClient(parsed.source)) {
      throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        `Upstream server not found: ${parsed.source}`,
      );
    }

    const waitOptions = {
      getClient,
      onClientsChanged: this.options.onClientsChanged,
      signal,
      logger: this.options.logger,
    };
    await awaitConnectedClient(parsed.source, waitOptions);

    const rateLimiter = this.options.getRateLimiter?.(parsed.source);
    if (rateLimiter) {
      try {
        await rateLimiter.acquire(signal);
      } catch (err) {
        if (signal.aborted) throw cancelledError();
        if (err instanceof RateLimiterDisposedError) throw removedError(parsed.source);
        const message = err instanceof Error ? err.message : String(err);
        throw new ProtocolError(ProtocolErrorCode.InternalError, message);
      }
    }

    const client = await awaitConnectedClient(parsed.source, waitOptions);
    this.refuseIfPolicyTightened(parsed.source, parsed.toolName, args, decision);
    try {
      return await client.callTool({ name: parsed.toolName, arguments: args }, { signal });
    } catch (err) {
      if (signal.aborted) throw cancelledError();
      if (client.status === "auth_required") throw reauthorizationError(parsed.source, client.name);
      const message = err instanceof Error ? err.message : String(err);
      throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        `Upstream server "${parsed.source}" error: ${message}`,
      );
    }
  }

  private async awaitPendingRegistration(source: string, signal: AbortSignal): Promise<void> {
    const whenRegistered = this.options.whenUpstreamRegistered;
    if (!whenRegistered) return;
    await this.sessionStart;
    await untilSettledOrCancelled(whenRegistered(source), signal);
  }

  private refuseIfPolicyTightened(
    source: string,
    toolName: string,
    args: Record<string, unknown> | undefined,
    decisionBeforeWait: PolicyDecision | undefined,
  ): void {
    const decision = this.policyEngine?.evaluate(source, toolName, args);
    throwIfDenied(decision);
    if (decision?.kind === "prompt" && decisionBeforeWait?.kind !== "prompt") {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidRequest,
        `Tool ${source}__${toolName} now requires confirmation after a configuration change; please retry`,
      );
    }
  }

  async connect(transport: Transport): Promise<void> {
    if (this.handle) {
      throw new Error("BridgeServer is already connected — close() first");
    }

    const { started, restoreStart } = interceptStart(transport, () => this.watchForSessionStart(transport));

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
      await handle.close().catch(() => {});
      throw err;
    } finally {
      restoreStart();
    }
  }

  sessionStarted(): Promise<void> {
    return this.sessionStart;
  }

  private watchForSessionStart(transport: Transport): void {
    const deliver = transport.onmessage;
    if (!deliver) {
      this.markSessionStarted();
      return;
    }
    transport.onmessage = (message, extra) => {
      if (!isVersionProbe(message)) this.markSessionStarted();
      deliver(message, extra);
    };
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport(
      this.options.stdin,
      this.options.stdout,
    );
    await this.connect(transport);
  }

  async close(): Promise<void> {
    await this.handle?.close();
    this.handle = undefined;
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
