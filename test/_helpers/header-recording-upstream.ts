import http from "node:http";
import type { AddressInfo } from "node:net";
import { Server, createMcpHandler, type ProtocolEra, type Tool } from "@modelcontextprotocol/server";
import { readBody, sendWebResponse, toWebRequest } from "./web-http.js";

export interface RecordedRequest {
  method: string | undefined;
  headers: Record<string, string>;
}

export interface HeaderRecorder {
  handle: (request: Request) => Promise<Response>;
  requests: () => RecordedRequest[];
  close: () => Promise<void>;
}

export interface HeaderRecordingUpstream extends HeaderRecorder {
  url: string;
}

export const HEADER_TOOLS: Tool[] = [
  { name: "plain", inputSchema: { type: "object" } },
  { name: "café ☕", inputSchema: { type: "object" } },
  {
    name: "regional",
    inputSchema: { type: "object", properties: { region: { type: "string", "x-mcp-header": "Region" } } },
  },
];

function toolServer(): Server {
  const server = new Server({ name: "header-recorder", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler("tools/list", () => ({ tools: HEADER_TOOLS }));
  server.setRequestHandler("tools/call", (request) => ({
    content: [{ type: "text" as const, text: `called ${request.params.name}` }],
  }));
  return server;
}

function parseRequest(body: string): { method?: string; id?: unknown } | undefined {
  try {
    const message: unknown = JSON.parse(body);
    if (message === null || typeof message !== "object" || Array.isArray(message)) return undefined;
    const { method, id } = message as { method?: unknown; id?: unknown };
    return { method: typeof method === "string" ? method : undefined, id };
  } catch {
    return undefined;
  }
}

export function createHeaderRecorder({ era = "modern" }: { era?: ProtocolEra } = {}): HeaderRecorder {
  const recorded: RecordedRequest[] = [];
  const handler = createMcpHandler(() => toolServer());
  return {
    handle: async (request) => {
      const message = parseRequest(await request.clone().text());
      recorded.push({ method: message?.method, headers: Object.fromEntries(request.headers) });
      if (era === "legacy" && message?.method === "server/discover") {
        return Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
      }
      return handler.fetch(request);
    },
    requests: () => [...recorded],
    close: () => handler.close(),
  };
}

export async function startHeaderRecordingUpstream(options: { era?: ProtocolEra } = {}): Promise<HeaderRecordingUpstream> {
  const recorder = createHeaderRecorder(options);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    await sendWebResponse(res, await recorder.handle(toWebRequest(req, url, await readBody(req))));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    ...recorder,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    close: async () => {
      await recorder.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
