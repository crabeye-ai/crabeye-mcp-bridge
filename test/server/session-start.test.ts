import { describe, it, expect, afterEach } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/client";
import { BridgeServer } from "../../src/server/bridge-server.js";
import { transportKeepingFirstMessageHandler } from "../_helpers/transports.js";

const VERSION_PROBE: JSONRPCMessage = {
  jsonrpc: "2.0",
  id: "probe-1",
  method: "server/discover",
  params: {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "prober", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  },
};

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

async function answer(transport: InMemoryTransport, message: JSONRPCMessage): Promise<JSONRPCMessage> {
  const reply = new Promise<JSONRPCMessage>((resolve) => {
    transport.onmessage = resolve;
  });
  await transport.send(message);
  return reply;
}

function transportWithoutMessageHandler(): Transport {
  return {
    async start() {},
    async send() {},
    async close() {},
    get onmessage() {
      return undefined;
    },
    set onmessage(_handler) {},
  };
}

describe("BridgeServer session start", () => {
  let server: BridgeServer;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
    await server.close();
  });

  async function connectBridge(
    wrap: (transport: Transport) => Transport = (transport) => transport,
  ): Promise<{ started: () => boolean; clientSide: InMemoryTransport }> {
    server = new BridgeServer();
    let started = false;
    void server.sessionStarted().then(() => {
      started = true;
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(wrap(serverSide));
    return { started: () => started, clientSide };
  }

  it("does not start a session for a connection that only probes the version", async () => {
    const { started, clientSide } = await connectBridge();
    await clientSide.start();

    expect(await answer(clientSide, VERSION_PROBE)).toMatchObject({ id: "probe-1", result: expect.any(Object) });
    await answer(clientSide, { ...VERSION_PROBE, id: "probe-2" });
    await settle();

    expect(started()).toBe(false);
    await clientSide.close();
  });

  it("starts the session on a 2025-era initialize", async () => {
    const { started, clientSide } = await connectBridge();
    client = new Client({ name: "legacy", version: "1" });

    await client.connect(clientSide);
    await settle();

    expect(client.getProtocolEra()).toBe("legacy");
    expect(started()).toBe(true);
  });

  it("starts the session on a modern client's first request after its probe", async () => {
    const { started, clientSide } = await connectBridge();
    client = new Client({ name: "modern", version: "1" }, { versionNegotiation: { mode: "auto" } });

    await client.connect(clientSide);
    await settle();
    expect(client.getProtocolEra()).toBe("modern");
    expect(started()).toBe(false);

    await client.listTools();
    await settle();
    expect(started()).toBe(true);
  });

  it("starts the session on the first tool request even when the transport drops the session watcher", async () => {
    const { started, clientSide } = await connectBridge(transportKeepingFirstMessageHandler);
    client = new Client({ name: "modern", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(clientSide);
    await settle();
    expect(started()).toBe(false);

    await client.listTools();
    await settle();

    expect(started()).toBe(true);
  });

  it("starts the session at once when the transport cannot report messages", async () => {
    server = new BridgeServer();

    await server.connect(transportWithoutMessageHandler());

    await expect(server.sessionStarted()).resolves.toBeUndefined();
  });
});
