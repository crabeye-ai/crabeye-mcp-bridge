import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Server, createMcpHandler } from "@modelcontextprotocol/server";
import type { Tool } from "@modelcontextprotocol/client";
import { HttpUpstreamClient } from "../../src/upstream/http-client.js";
import { readBody, sendWebResponse, toWebRequest } from "../_helpers/web-http.js";
import { spyLogger } from "../_helpers/spy-logger.js";

const plain: Tool = { name: "plain", inputSchema: { type: "object" } };

async function startToolServer(pages: Array<{ tools: Tool[]; nextCursor?: string }>): Promise<{ url: string; close(): Promise<void> }> {
  const handler = createMcpHandler(() => {
    const server = new Server({ name: "tools", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler("tools/list", (request) => pages[Number(request.params?.cursor ?? 0)] ?? { tools: [] });
    server.setRequestHandler("tools/call", () => ({ content: [], structuredContent: { value: 1 } }));
    return server;
  });
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    await sendWebResponse(res, await handler.fetch(toWebRequest(req, new URL(req.url!, "http://127.0.0.1"), body)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    close: async () => {
      await handler.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("upstream tools the MCP SDK filters or refuses on a 2026-07-28 HTTP connection", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function connected(pages: Array<{ tools: Tool[]; nextCursor?: string }>): Promise<HttpUpstreamClient> {
    const server = await startToolServer(pages);
    const client = new HttpUpstreamClient({ name: "svc", config: { type: "streamable-http", url: server.url }, logger: spyLogger(), reconnectBaseDelay: 60_000 });
    cleanups.push(() => server.close(), () => client.close());
    await client.connect();
    return client;
  }

  it("leaves out a tool whose x-mcp-header parameter is a number, as the spec requires", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const numberHeader: Tool = { name: "number_header", inputSchema: { type: "object", properties: { n: { type: "number", "x-mcp-header": "N" } } } };

    const client = await connected([{ tools: [plain, numberHeader] }]);

    expect(client.tools.map((tool) => tool.name)).toEqual(["plain"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("excluding tool 'number_header'"));
  });

  it.each([
    ["isn't a valid URI", "my_tool:output", "Tool 'with_id' has an invalid outputSchema: URI scheme is malformed"],
    ["is a plain name", "my_tool_output", undefined],
  ])("refuses a call to a tool whose output schema has an $id that %s, and only then", async (_case, id, error) => {
    const withId: Tool = { name: "with_id", inputSchema: { type: "object" }, outputSchema: { type: "object", $id: id, properties: { value: { type: "number" } } } };
    const client = await connected([{ tools: [withId] }]);

    const call = client.callTool({ name: "with_id" });

    if (error === undefined) await expect(call).resolves.toMatchObject({ structuredContent: { value: 1 } });
    else await expect(call).rejects.toThrow(error);
  });

  it("lists every page of tools once, even when the server repeats a page", async () => {
    const second: Tool = { name: "second", inputSchema: { type: "object" } };

    const client = await connected([
      { tools: [plain], nextCursor: "1" },
      { tools: [second], nextCursor: "1" },
    ]);

    expect(client.tools.map((tool) => tool.name)).toEqual(["plain", "second"]);
  });
});
