import http from "node:http";
import type { AddressInfo } from "node:net";
import { oauthMetadataFor, readBody } from "./web-http.js";

/** What a token endpoint answers a refresh with: a server error, new tokens keeping the refresh token, or new tokens with a new one. */
type RefreshAnswer = "fail" | "keep" | "rotate";

export interface LoginAuthServer {
  readonly issuer: string;
  /** How refreshes are answered; "keep" by default. */
  refresh: RefreshAnswer;
  /** The refresh token a login's code exchange returns; none by default. */
  loginRefreshToken: string | undefined;
  /** Every form sent to the token endpoint, oldest first. */
  tokenRequests(): Array<Record<string, string>>;
  /** Holds refresh answers until `releaseRefreshes`. */
  holdRefreshes(): void;
  releaseRefreshes(): void;
  heldRefreshes(): number;
}

export interface LoginWorld {
  readonly resourceUrl: string;
  readonly a: LoginAuthServer;
  readonly b: LoginAuthServer;
  /** Makes the resource's metadata name `server` as its authorization server. */
  useAuthorizationServer(server: LoginAuthServer): void;
  close(): Promise<void>;
}

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function startAuthServer(name: string): Promise<{ server: http.Server; authServer: LoginAuthServer }> {
  const requests: Array<Record<string, string>> = [];
  const held: Array<() => void> = [];
  let holding = false;
  let issued = 0;
  let base = "";
  const authServer: LoginAuthServer = {
    get issuer() {
      return base;
    },
    refresh: "keep",
    loginRefreshToken: undefined,
    tokenRequests: () => [...requests],
    holdRefreshes: () => {
      holding = true;
    },
    releaseRefreshes: () => {
      holding = false;
      for (const answer of held.splice(0)) answer();
    },
    heldRefreshes: () => held.length,
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, base);
    const body = (await readBody(req)).toString("utf8");
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
      return json(res, 200, { ...oauthMetadataFor(url.pathname, base), registration_endpoint: `${base}/register` });
    }
    if (url.pathname === "/register" && req.method === "POST") {
      return json(res, 201, { ...JSON.parse(body), client_id: `${name}-client` });
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const form = Object.fromEntries(new URLSearchParams(body));
      requests.push(form);
      issued++;
      if (form.grant_type === "authorization_code") {
        const refreshToken = authServer.loginRefreshToken === undefined ? {} : { refresh_token: authServer.loginRefreshToken };
        return json(res, 200, { access_token: `${name}-login-${issued}`, token_type: "Bearer", expires_in: 3600, ...refreshToken });
      }
      const answer = (): void => {
        if (authServer.refresh === "fail") return json(res, 500, { error: "server_error" });
        const refreshToken = authServer.refresh === "rotate" ? { refresh_token: `${name}-rotated-${issued}` } : {};
        json(res, 200, { access_token: `${name}-refreshed-${issued}`, token_type: "Bearer", expires_in: 3600, ...refreshToken });
      };
      if (holding) held.push(answer);
      else answer();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  base = await listen(server);
  return { server, authServer };
}

/** A protected resource and two authorization servers, A and B, of which the resource names A until told otherwise. */
export async function startLoginWorld(): Promise<LoginWorld> {
  const [a, b] = await Promise.all([startAuthServer("a"), startAuthServer("b")]);
  let current = a.authServer;
  let resourceBase = "";
  const resource = http.createServer((req, res) => {
    const { pathname } = new URL(req.url!, resourceBase);
    if (pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return json(res, 200, { resource: `${resourceBase}/mcp`, authorization_servers: [current.issuer] });
    }
    res.writeHead(404);
    res.end();
  });
  resourceBase = await listen(resource);
  return {
    resourceUrl: `${resourceBase}/mcp`,
    a: a.authServer,
    b: b.authServer,
    useAuthorizationServer: (server) => {
      current = server;
    },
    close: async () => {
      a.authServer.releaseRefreshes();
      b.authServer.releaseRefreshes();
      await Promise.all([resource, a.server, b.server].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    },
  };
}
