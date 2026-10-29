import http from "node:http";
import type { AddressInfo } from "node:net";
import { readBody } from "./web-http.js";

export interface HeldTokenResponse {
  outcome: "rotated" | "rejected";
  release: () => void;
}

export interface RotatingAuthServer {
  resourceUrl: string;
  issuer: string;
  currentRefreshToken: () => string;
  holdResponses: (hold: boolean) => void;
  held: () => HeldTokenResponse[];
  close: () => Promise<void>;
}

export async function startRotatingAuthServer(firstRefreshToken: string): Promise<RotatingAuthServer> {
  let current = firstRefreshToken;
  let issued = 0;
  let hold = false;
  const held: HeldTokenResponse[] = [];

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
    if (url.pathname === "/token" && req.method === "POST") {
      const refreshToken = new URLSearchParams(body.toString("utf8")).get("refresh_token") ?? "";
      const rotated = refreshToken === current;
      if (rotated) {
        issued++;
        current = `${firstRefreshToken}-rotated-${issued}`;
      }
      const tokens = { access_token: `at-${issued}`, token_type: "Bearer", refresh_token: current, expires_in: 3600 };
      const respond = rotated
        ? () => json(200, tokens)
        : () => json(400, { error: "invalid_grant", error_description: "refresh token already used" });
      if (!hold) return respond();
      held.push({ outcome: rotated ? "rotated" : "rejected", release: respond });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    resourceUrl: `http://127.0.0.1:${port}/mcp`,
    issuer: `http://127.0.0.1:${port}`,
    currentRefreshToken: () => current,
    holdResponses: (value) => {
      hold = value;
    },
    held: () => [...held],
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
