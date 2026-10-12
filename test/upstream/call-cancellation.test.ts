import { afterEach, describe, expect, it } from "vitest";
import { InMemoryTransport, Server } from "@modelcontextprotocol/server";
import { HttpUpstreamClient } from "../../src/upstream/http-client.js";

describe("upstream tool call cancellation", () => {
  let client: HttpUpstreamClient | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("aborts the upstream's handling of a tool call when the caller's signal aborts", async () => {
    let started!: () => void;
    const handlerStarted = new Promise<void>((resolve) => { started = resolve; });
    let aborted!: () => void;
    const handlerAborted = new Promise<void>((resolve) => { aborted = resolve; });
    client = new HttpUpstreamClient({
      name: "slow",
      config: { type: "streamable-http", url: "http://localhost:9999" },
      _transportFactory: () => {
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        const server = new Server({ name: "slow", version: "1.0.0" }, { capabilities: { tools: {} } });
        server.setRequestHandler("tools/list", () => ({ tools: [] }));
        server.setRequestHandler("tools/call", (_request, ctx) => new Promise((resolve) => {
          started();
          ctx.mcpReq.signal.addEventListener("abort", () => {
            aborted();
            resolve({ content: [] });
          });
        }));
        void server.connect(serverSide);
        return clientSide;
      },
    });
    await client.connect();
    const controller = new AbortController();

    const call = client.callTool({ name: "wait" }, { signal: controller.signal });
    await handlerStarted;
    controller.abort();

    await expect(call).rejects.toThrow();
    await handlerAborted;
  });
});
