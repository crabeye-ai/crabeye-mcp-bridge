import { describe, it, expect } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { Transport } from "@modelcontextprotocol/client";
import { BridgeServer } from "../../src/server/bridge-server.js";
import { ToolRegistry } from "../../src/server/tool-registry.js";

function failingTransport(message: string): Transport {
  return {
    async start() {
      throw new Error(message);
    },
    async send() {},
    async close() {},
  };
}

describe("BridgeServer connect lifecycle", () => {
  it("rejects connect() when the transport fails to start, sync or async", async () => {
    const server = new BridgeServer();
    await expect(server.connect(failingTransport("stdin is gone"))).rejects.toThrow(
      /stdin is gone/,
    );

    const late: Transport = {
      async start() {
        await new Promise((r) => setTimeout(r, 5));
        throw new Error("pipe closed late");
      },
      async send() {},
      async close() {},
    };
    await expect(server.connect(late)).rejects.toThrow(/pipe closed late/);

    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    await expect(server.connect(serverTransport)).resolves.toBeUndefined();
    await server.close();
  });

  it("refuses a second connect() while one is active", async () => {
    const server = new BridgeServer();
    const [, first] = InMemoryTransport.createLinkedPair();
    const [, second] = InMemoryTransport.createLinkedPair();

    await server.connect(first);
    await expect(server.connect(second)).rejects.toThrow(/already connected/);

    const client = new Client({ name: "t", version: "0" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.close();
    await server.connect(serverSide);
    await client.connect(clientSide);
    expect((await client.listTools()).tools).toBeDefined();
    await client.close();
    await server.close();
  });

  it("leaves the caller's transport.start untouched after connect()", async () => {
    const server = new BridgeServer();
    const [, transport] = InMemoryTransport.createLinkedPair();
    const originalStart = transport.start;

    await server.connect(transport);

    expect(transport.start).toBe(originalStart);
    await server.close();
  });

  it("close() before connect() is a no-op", async () => {
    const server = new BridgeServer();
    await expect(server.close()).resolves.toBeUndefined();
  });

  it("still notifies tool-list changes after a connect/close/connect cycle", async () => {
    const registry = new ToolRegistry();
    const server = new BridgeServer({ toolRegistry: registry });

    const [, first] = InMemoryTransport.createLinkedPair();
    await server.connect(first);
    await server.close();

    const client = new Client({ name: "t", version: "0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    await client.connect(c);

    const notified = new Promise<void>((resolve) => {
      client.setNotificationHandler("notifications/tools/list_changed", () => resolve());
    });
    registry.setToolsForSource("linear", [
      { name: "linear__create_issue", description: "x", inputSchema: { type: "object" } },
    ]);

    await expect(
      Promise.race([
        notified,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 2000)),
      ]),
    ).resolves.toBeUndefined();

    await client.close();
    await server.close();
  });
});
