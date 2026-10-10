import http from "node:http";
import type { AddressInfo } from "node:net";
import { Server, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";

export type TokenEndpoint = "invalid_grant" | "unavailable" | "rate_limited_json" | "unavailable_json";
export type ResourceGuard = "token" | "insufficient_scope";

export interface ProtectedUpstream {
  url: string;
  mcpRequests: () => number;
  expireAccessToken: (refreshOutcome: TokenEndpoint) => void;
  close: () => Promise<void>;
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export async function startProtectedUpstream(tokenEndpoint: TokenEndpoint, guard: ResourceGuard = "token"): Promise<ProtectedUpstream> {
  let mcpRequests = 0;
  let acceptedToken: string | undefined = "valid";
  const server = http.createServer(async (req, res) => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const url = new URL(req.url!, base);
    const body = await readBody(req);
    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
    }
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
      return json(200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.pathname === "/token") {
      if (tokenEndpoint === "unavailable") {
        res.writeHead(503);
        return res.end();
      }
      if (tokenEndpoint === "rate_limited_json") return json(429, { error: "slow_down" });
      if (tokenEndpoint === "unavailable_json") return json(503, { error: "Service Unavailable" });
      return json(400, { error: "invalid_grant" });
    }
    if (url.pathname === "/mcp") {
      mcpRequests++;
      if (guard === "insufficient_scope") {
        res.writeHead(403, { "www-authenticate": `Bearer error="insufficient_scope", scope="admin"` });
        return res.end();
      }
      if (acceptedToken === undefined || req.headers.authorization !== `Bearer ${acceptedToken}`) {
        res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
        return res.end();
      }
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      const mcp = new Server({ name: "protected", version: "1.0.0" }, { capabilities: { tools: {} } });
      mcp.setRequestHandler("tools/list", () => ({ tools: [] }));
      await mcp.connect(transport);
      const response = await transport.handleRequest(
        new Request(url, {
          method: req.method,
          headers: Object.entries(req.headers).filter((e): e is [string, string] => typeof e[1] === "string"),
          body: req.method === "GET" ? undefined : new Uint8Array(body),
        }),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      return res.end(Buffer.from(await response.arrayBuffer()));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    mcpRequests: () => mcpRequests,
    expireAccessToken: (refreshOutcome) => {
      acceptedToken = undefined;
      tokenEndpoint = refreshOutcome;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
