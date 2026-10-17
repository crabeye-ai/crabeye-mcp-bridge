import type http from "node:http";

export async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export function toWebRequest(req: http.IncomingMessage, url: URL, body: Buffer): Request {
  return new Request(url, {
    method: req.method,
    headers: Object.entries(req.headers).filter((e): e is [string, string] => typeof e[1] === "string"),
    body: req.method === "GET" || req.method === "HEAD" ? undefined : new Uint8Array(body),
  });
}

export async function sendWebResponse(res: http.ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}
