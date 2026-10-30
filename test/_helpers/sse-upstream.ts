import http from "node:http";
import type { AddressInfo } from "node:net";
import { readBody } from "./web-http.js";

export interface SseUpstream {
  url: string;
  /** Event streams clients opened. */
  streams: () => number;
  close: () => Promise<void>;
}

interface Message {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: { protocolVersion?: string };
}

/** A server on the deprecated HTTP+SSE transport with one `echo` tool. */
export async function startSseUpstream(): Promise<SseUpstream> {
  const sessions = new Map<string, http.ServerResponse>();
  let opened = 0;

  function answer(message: Message): unknown {
    if (message.method === "initialize") {
      return { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "sse", version: "1" } };
    }
    if (message.method === "tools/list") return { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
    if (message.method === "tools/call") return { content: [{ type: "text", text: "echoed over sse" }] };
    if (message.method === "ping") return {};
    return undefined;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/sse") {
      const sessionId = String(++opened);
      sessions.set(sessionId, res);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);
      res.on("close", () => sessions.delete(sessionId));
      return;
    }
    const stream = sessions.get(url.searchParams.get("sessionId") ?? "");
    if (req.method !== "POST" || url.pathname !== "/messages" || stream === undefined) {
      res.writeHead(404).end();
      return;
    }
    const message = JSON.parse((await readBody(req)).toString("utf8")) as Message;
    res.writeHead(202).end();
    if (message.id === undefined) return;
    const result = answer(message);
    const reply = result === undefined ? { error: { code: -32601, message: "Method not found" } } : { result };
    stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, ...reply })}\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/sse`,
    streams: () => opened,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
