import type http from "node:http";

export async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export function toWebRequest(req: http.IncomingMessage, url: URL, body: Buffer, signal?: AbortSignal): Request {
  return new Request(url, {
    method: req.method,
    ...(signal && { signal }),
    headers: Object.entries(req.headers).filter((e): e is [string, string] => typeof e[1] === "string"),
    body: req.method === "GET" || req.method === "HEAD" ? undefined : new Uint8Array(body),
  });
}

export async function sendWebResponse(res: http.ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

/** The OAuth discovery document a test server at `base` serves for `pathname`, if it is one. */
export function oauthMetadataFor(pathname: string, base: string): Record<string, unknown> | undefined {
  if (pathname.startsWith("/.well-known/oauth-protected-resource")) {
    return { resource: `${base}/mcp`, authorization_servers: [base] };
  }
  if (pathname.startsWith("/.well-known/oauth-authorization-server")) {
    return {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    };
  }
  return undefined;
}
