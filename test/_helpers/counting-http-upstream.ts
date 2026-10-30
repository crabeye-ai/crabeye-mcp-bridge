import http from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Server, WebStandardStreamableHTTPServerTransport, createMcpHandler, type ProtocolEra } from "@modelcontextprotocol/server";
import { oauthMetadataFor, readBody, sendWebResponse, toWebRequest } from "./web-http.js";

export const COUNTING_TOOLS = [
  { name: "echo", inputSchema: { type: "object" as const } },
  { name: "slow", inputSchema: { type: "object" as const } },
];

/** What the `echo` tool answers when called without arguments. */
export const ECHOED = [{ type: "text", text: "called echo {}" }];

export interface CountingUpstreamOptions {
  era?: ProtocolEra;
  instructions?: string;
  /** Require a bearer token issued by this server's own rotating authorization server. */
  oauth?: boolean;
  /** Serve HTTPS with this key and certificate. */
  tls?: { key: string; cert: string };
}

export interface CountingUpstream {
  url: string;
  issuer: string;
  /** How many requests arrived for each JSON-RPC method. */
  count: (method: string) => number;
  /** Legacy sessions started. */
  sessions: () => number;
  /** Tool calls whose handling the client cancelled. */
  cancellations: () => number;
  /** The Authorization header of every MCP request, in order. */
  authorizations: () => Array<string | undefined>;
  tokenRequests: () => number;
  /** Ends every legacy session: requests naming one get 404 from now on. */
  endSessions: () => Promise<void>;
  /** Answers health checks (`ping`, and `server/discover` once connected) with HTTP 500 while set. */
  failHealthChecks: (fail: boolean) => void;
  /** Refuses the current access token, so the client has to refresh. */
  expireAccessToken: () => void;
  /** While false, drops open connections and every new one, as an unreachable server would. */
  setReachable: (reachable: boolean) => void;
  /** Connections from clients that are still open. */
  openSockets: () => number;
  close: () => Promise<void>;
}

function toolServer(onCancelled: () => void, instructions: string | undefined): Server {
  const server = new Server({ name: "counting", version: "1.0.0" }, { capabilities: { tools: {} }, ...(instructions && { instructions }) });
  server.setRequestHandler("tools/list", () => ({ tools: COUNTING_TOOLS }));
  server.setRequestHandler("tools/call", (request, ctx) => {
    if (request.params.name !== "slow") {
      return { content: [{ type: "text" as const, text: `called ${request.params.name} ${JSON.stringify(request.params.arguments ?? {})}` }] };
    }
    return new Promise((resolve) => {
      ctx.mcpReq.signal.addEventListener("abort", () => {
        onCancelled();
        resolve({ content: [] });
      });
    });
  });
  return server;
}

interface Inbound {
  method: string;
  id?: unknown;
}

function messagesOf(body: Buffer): Inbound[] {
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    return messages.filter((m): m is Inbound => typeof m === "object" && m !== null && typeof (m as { method?: unknown }).method === "string");
  } catch {
    return [];
  }
}

export async function startCountingUpstream({ era = "modern", instructions, oauth = false, tls }: CountingUpstreamOptions = {}): Promise<CountingUpstream> {
  const counts = new Map<string, number>();
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const authorizations: Array<string | undefined> = [];
  let sessionCount = 0;
  let cancellations = 0;
  let failingHealth = false;
  let reachable = true;
  let tokenRequests = 0;
  let issued = 0;
  let refreshToken = "rt-0";
  let accessToken = "at-0";
  const onCancelled = () => cancellations++;
  const modern = createMcpHandler(() => toolServer(onCancelled, instructions));

  async function legacy(request: Request, messages: Inbound[]): Promise<Response> {
    const sessionId = request.headers.get("mcp-session-id");
    if (sessionId !== null) {
      const transport = sessions.get(sessionId);
      if (transport === undefined) return new Response("session not found", { status: 404 });
      return transport.handleRequest(request);
    }
    if (!messages.some((m) => m.method === "initialize")) {
      return Response.json({ jsonrpc: "2.0", id: messages[0]?.id ?? null, error: { code: -32601, message: "Method not found" } });
    }
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        sessionCount++;
        sessions.set(id, transport);
      },
    });
    await toolServer(onCancelled, instructions).connect(transport);
    return transport.handleRequest(request);
  }

  const scheme = tls ? "https" : "http";
  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const base = `${scheme}://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const url = new URL(req.url!, base);
    const body = await readBody(req);
    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const metadata = oauth ? oauthMetadataFor(url.pathname, base) : undefined;
    if (metadata !== undefined) return json(200, metadata);
    if (oauth && url.pathname === "/token") {
      tokenRequests++;
      if (new URLSearchParams(body.toString("utf8")).get("refresh_token") !== refreshToken) {
        return json(400, { error: "invalid_grant", error_description: "refresh token already used" });
      }
      issued++;
      refreshToken = `rt-${issued}`;
      accessToken = `at-${issued}`;
      return json(200, { access_token: accessToken, token_type: "Bearer", refresh_token: refreshToken, expires_in: 3600 });
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404);
      return res.end();
    }
    const messages = messagesOf(body);
    const methods = messages.map((m) => m.method);
    for (const method of methods) counts.set(method, (counts.get(method) ?? 0) + 1);
    authorizations.push(req.headers.authorization);
    if (oauth && req.headers.authorization !== `Bearer ${accessToken}`) {
      res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
      return res.end();
    }
    const healthCheck = methods.includes("ping") || (methods.includes("server/discover") && (counts.get("tools/list") ?? 0) > 0);
    if (failingHealth && healthCheck) {
      res.writeHead(500);
      return res.end();
    }
    const disconnected = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) disconnected.abort();
    });
    const request = toWebRequest(req, url, body, disconnected.signal);
    await sendWebResponse(res, era === "legacy" ? await legacy(request, messages) : await modern.fetch(request));
  };
  const server = tls ? https.createServer(tls, handle) : http.createServer(handle);
  server.keepAliveTimeout = 60_000;
  let openSockets = 0;
  server.on("connection", (socket) => {
    if (!reachable) return socket.destroy();
    openSockets++;
    socket.once("close", () => openSockets--);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `${scheme}://127.0.0.1:${port}/mcp`,
    issuer: `${scheme}://127.0.0.1:${port}`,
    count: (method) => counts.get(method) ?? 0,
    sessions: () => sessionCount,
    cancellations: () => cancellations,
    authorizations: () => [...authorizations],
    tokenRequests: () => tokenRequests,
    endSessions: async () => {
      const ended = [...sessions.values()];
      sessions.clear();
      await Promise.all(ended.map((transport) => transport.close()));
    },
    failHealthChecks: (fail) => {
      failingHealth = fail;
    },
    expireAccessToken: () => {
      accessToken = `expired-${randomUUID()}`;
    },
    openSockets: () => openSockets,
    setReachable: (value) => {
      reachable = value;
      if (!reachable) server.closeAllConnections();
    },
    close: async () => {
      await Promise.all([...sessions.values()].map((transport) => transport.close()));
      await modern.close();
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}
