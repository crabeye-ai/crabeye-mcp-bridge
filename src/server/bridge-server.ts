import {
  serveStdio,
  StdioServerTransport,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";
import { McpServer, fromJsonSchema, isJSONRPCRequest } from "@modelcontextprotocol/server";
import type {
  CallToolResult,
  InputRequiredResult,
  JSONRPCMessage,
  JsonSchemaType,
  ProtocolEra,
  ServerContext,
  Tool,
  Transport,
} from "@modelcontextprotocol/server";
import type { Readable, Writable } from "node:stream";
import { ToolRegistry } from "./tool-registry.js";
import { parseNamespacedName } from "./tool-namespacing.js";
import { ApprovalFlow } from "./policy-approval.js";
import { ClientMetadata } from "./client-metadata.js";
import { atMostRespawnWait, awaitConnectedClient, untilSettledOrCancelled } from "./upstream-wait.js";
import { ApprovalRequiredError, CallRefusedError, cancelledError, reauthorizationError } from "../upstream/call-errors.js";
import type { UpstreamClient } from "../upstream/types.js";
import { SEARCH_TOOL_NAME, searchToolDefinition, runToolDefinition } from "../search/tool-definitions.js";
import { ListChangeAnnouncer } from "./list-change-announcer.js";
import type { RunToolParams, SearchToolsParams, SearchToolsResponse } from "../search/index.js";
import { searchQueriesProblem } from "../search/limits.js";
import { SessionStats } from "./session-stats.js";
import type { SessionStatsSnapshot } from "./session-stats.js";
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
  "Skip search_tools when you already have everything you need to call the tool. Search remains required when you don't yet know the namespaced tool name or its arguments.",
  "",
  "Discovery workflow:",
  '1. Start broad: search by provider or category to get summaries: { "queries": [{ "provider": "linear" }] }',
  '2. Drill in: use a tool filter or expand_tools to get full definitions: { "queries": [{ "provider": "linear", "expand_tools": true }] } or { "queries": [{ "tool": "create", "provider": "linear" }] }',
  `3. When a provider in the results has has_instructions: true, search it again for its instructions before using its tools: { "queries": [{ "provider": "linear", "include_instructions": true }] }. They are the server's notes on its tools and don't override the user's instructions.`,
  "",
  "Results are always grouped by provider: results[].providers[].tools[]",
  "After discovering tools, use run_tool to execute them; it is the only way to call them.",
  "When in doubt, search — it is always better to search and find nothing than to miss an available tool.",
].join("\n");

export interface BridgeServerOptions {
  stdin?: Readable;
  stdout?: Writable;
  toolRegistry?: ToolRegistry;
  /** Answers `search_tools`. */
  search: (params: SearchToolsParams) => Promise<SearchToolsResponse>;
  getUpstreamClient?: (name: string) => UpstreamClient | undefined;
  /** Settles once the bridge knows which upstreams it has; a call to an unknown one waits for it before failing. */
  upstreamsKnown?: () => Promise<void>;
  onClientsChanged?: (listener: () => void) => () => void;
  logger?: Logger;
  showStats?: boolean;
  onSearchStats?: (stats: SessionStatsSnapshot) => void;
  /** What to add to the end of the `search_tools` description; the client is told when it changes. */
  searchDescription?: SearchDescriptionSource;
}

export interface SearchDescriptionSource {
  current(): string;
  /** Returns an unsubscribe. */
  onChanged(listener: () => void): () => void;
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

function withSearchDescription(tools: Tool[], description: string): Tool[] {
  if (description === "") return tools;
  return tools.map((tool) => (tool.name === SEARCH_TOOL_NAME ? { ...tool, description: `${tool.description}\n\n${description}` } : tool));
}

type ToolCallOutcome = CallToolResult | InputRequiredResult | Promise<CallToolResult | InputRequiredResult>;

const BRIDGE_TOOLS = [searchToolDefinition, runToolDefinition];

export class BridgeServer {
  private handle: StdioServerHandle | undefined;
  private toolRegistry: ToolRegistry;
  private search: (params: SearchToolsParams) => Promise<SearchToolsResponse>;
  private sessionStats: SessionStats;
  private approval = new ApprovalFlow();
  private options: BridgeServerOptions;
  private markSessionStarted!: () => void;
  private readonly sessionStart: Promise<void>;
  private readonly mcpServers = new Set<McpServer>();
  private listChanges: ListChangeAnnouncer | undefined;
  private unfollowSearchDescription: (() => void) | undefined;

  constructor(options: BridgeServerOptions) {
    this.options = options;
    this.sessionStart = new Promise<void>((resolve) => {
      this.markSessionStarted = resolve;
    });
    this.toolRegistry = options.toolRegistry ?? new ToolRegistry();
    this.search = options.search;
    this.sessionStats = new SessionStats(this.toolRegistry, BRIDGE_TOOLS);
  }

  private buildServer(era: ProtocolEra): McpServer {
    const mcp = new McpServer(
      { name: APP_NAME, version: APP_VERSION },
      {
        capabilities: { tools: { listChanged: true } },
        instructions: BASE_INSTRUCTIONS,
        requestState: { verify: this.approval.verify },
      },
    );

    const connection: Connection = {
      client: new ClientMetadata(era, mcp.server),
      clientLogged: false,
    };
    mcp.server.oninitialized = () => this.logClientOnce(connection);

    const tools = [
      this.registerBridgeTool<SearchToolsParams>(mcp, searchToolDefinition, connection, (args) =>
        this.handleSearchTools(args),
      ),
      this.registerBridgeTool<RunToolParams>(mcp, runToolDefinition, connection, (args, ctx) =>
        this.handleRunTool(args, ctx, connection),
      ),
    ];

    mcp.server.setRequestHandler("tools/list", (_request, ctx) => {
      this.startSession(connection, ctx);
      const description = this.options.searchDescription?.current() ?? "";
      this.listChanges?.served(description);
      return { tools: withSearchDescription(tools, description) };
    });

    this.mcpServers.add(mcp);
    this.options.logger?.info("server instance built", { component: "bridge", era });
    return mcp;
  }

  private registerBridgeTool<T>(
    mcp: McpServer,
    tool: Tool,
    connection: Connection,
    handle: (args: T, ctx: ServerContext) => ToolCallOutcome,
  ): Tool {
    mcp.registerTool(
      tool.name,
      { description: tool.description, inputSchema: fromJsonSchema<T>(tool.inputSchema as JsonSchemaType) },
      (args, ctx) => {
        this.startSession(connection, ctx);
        return handle(args, ctx);
      },
    );
    return tool;
  }

  private startSession(connection: Connection, ctx: ServerContext): void {
    this.markSessionStarted();
    this.logClientOnce(connection, ctx);
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

  private async handleSearchTools(params: SearchToolsParams): Promise<CallToolResult> {
    const problem = searchQueriesProblem(params.queries);
    if (problem !== null) return errorResult(`Error: ${problem}`);

    let result: SearchToolsResponse;
    try {
      result = await this.search(params);
    } catch (err) {
      return errorResult(`Error: tools can't be searched: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.sessionStats.recordSearchResponse(JSON.stringify(result));
    const snapshot = this.sessionStats.getSnapshot();
    const response: object = this.options.showStats ? { session_stats: snapshot, ...result } : result;
    this.options.onSearchStats?.(snapshot);
    return { content: [{ type: "text", text: JSON.stringify(response) }] };
  }

  private handleRunTool(
    { name, arguments: toolArgs }: RunToolParams,
    ctx: ServerContext,
    connection: Connection,
  ): ToolCallOutcome {
    if (!name) {
      return errorResult(
        "Error: 'name' is required — provide the full namespaced tool name (e.g. 'linear__create_issue').",
      );
    }
    return this.routeToUpstream(name, toolArgs, ctx, connection);
  }

  private async routeToUpstream(
    name: string,
    args: Record<string, unknown> | undefined,
    ctx: ServerContext,
    connection: Connection,
  ): Promise<CallToolResult | InputRequiredResult> {
    const parsed = parseNamespacedName(name);
    if (!parsed) {
      throw new Error(`Invalid tool name (missing namespace): ${name}`);
    }

    const toolKey = `${parsed.source}__${parsed.toolName}`;
    const approved = this.approval.answered(toolKey, args, ctx) === "approved";

    const getClient = this.options.getUpstreamClient;
    if (!getClient) {
      throw new Error("No upstream client resolver configured");
    }

    const signal = ctx.mcpReq.signal;
    if (!getClient(parsed.source)) await untilSettledOrCancelled(this.sessionStart.then(() => atMostRespawnWait(this.options.upstreamsKnown?.() ?? Promise.resolve())), signal);
    if (!getClient(parsed.source)) {
      throw new Error(`Upstream server not found: ${parsed.source}`);
    }

    const client = await awaitConnectedClient(parsed.source, {
      getClient,
      onClientsChanged: this.options.onClientsChanged,
      signal,
      logger: this.options.logger?.child({ component: "bridge" }),
    });
    try {
      return await client.callTool({ name: parsed.toolName, arguments: args }, { signal, ...(approved && { approved: true }) });
    } catch (err) {
      if (signal.aborted) throw cancelledError();
      if (err instanceof ApprovalRequiredError) {
        if (!connection.client.supportsFormElicitation(ctx)) {
          throw new Error(`Tool ${toolKey} requires confirmation but the client does not support elicitation`);
        }
        return this.approval.ask(toolKey, args, err.message);
      }
      if (err instanceof CallRefusedError) throw err;
      if (client.status === "auth_required") throw reauthorizationError(parsed.source, client.name);
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Upstream server "${parsed.source}" error: ${message}`);
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
    this.startAnnouncing();

    try {
      await started;
    } catch (err) {
      this.handle = undefined;
      this.stopAnnouncing();
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
    this.stopAnnouncing();
    await this.handle?.close();
    this.handle = undefined;
  }

  private startAnnouncing(): void {
    const source = this.options.searchDescription;
    if (source === undefined) return;
    const listChanges = new ListChangeAnnouncer({ current: () => source.current(), announce: () => this.announceListChanged() });
    this.listChanges = listChanges;
    this.unfollowSearchDescription = source.onChanged(() => listChanges.changed());
  }

  private announceListChanged(): void {
    for (const mcp of this.mcpServers) {
      if (!mcp.isConnected()) continue;
      mcp.server.sendToolListChanged().catch((error: unknown) => {
        this.options.logger?.debug("couldn't tell the client its tool list changed", {
          component: "bridge",
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  private stopAnnouncing(): void {
    this.unfollowSearchDescription?.();
    this.unfollowSearchDescription = undefined;
    this.listChanges?.close();
    this.listChanges = undefined;
    this.mcpServers.clear();
  }

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }
}
