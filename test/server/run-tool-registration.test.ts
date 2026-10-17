import { describe, it, expect, afterEach, vi } from "vitest";
import { Client, InMemoryTransport as ClientInMemoryTransport, type Transport } from "@modelcontextprotocol/client";
import { InMemoryTransport, Server } from "@modelcontextprotocol/server";
import { BridgeConfigSchema, type ServerConfig } from "../../src/config/schema.js";
import { diffConfigs } from "../../src/config/config-diff.js";
import { UpstreamManager } from "../../src/upstream/upstream-manager.js";
import { DaemonStdioClient } from "../../src/upstream/daemon-stdio-client.js";
import { HttpUpstreamClient } from "../../src/upstream/http-client.js";
import type { UpstreamClient } from "../../src/upstream/types.js";
import type { CredentialStore } from "../../src/credentials/credential-store.js";
import { ToolRegistry } from "../../src/server/tool-registry.js";
import { BridgeServer } from "../../src/server/bridge-server.js";
import { ToolSearchService } from "../../src/search/index.js";
import { makeTestStore } from "../_helpers/credential-store.js";
import { createTestPair } from "../_helpers/bridge-test-pair.js";
import { transportKeepingFirstMessageHandler } from "../_helpers/transports.js";

let sessionsOpened = 0;

function inMemoryUpstream(): InMemoryTransport {
  sessionsOpened++;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name: "upstream", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler("tools/list", () => ({ tools: [{ name: "echo", inputSchema: { type: "object" } }] }));
  server.setRequestHandler("tools/call", () => ({ content: [{ type: "text" as const, text: "echoed" }] }));
  void server.connect(serverSide);
  return clientSide;
}

function inMemoryClient(name: string, config: ServerConfig, resolvedEnv: Record<string, string>): UpstreamClient {
  if ("command" in config) return new DaemonStdioClient({ name, config, resolvedEnv, _transportFactory: inMemoryUpstream });
  return new HttpUpstreamClient({ name, config, _transportFactory: inMemoryUpstream });
}

function bridgeConfig(servers: Record<string, unknown>) {
  return BridgeConfigSchema.parse({ mcpServers: servers });
}

function runEcho(client: Client, source: string) {
  return client.callTool({ name: "run_tool", arguments: { name: `${source}__echo`, arguments: {} } });
}

describe("upstream registration", () => {
  let cleanups: Array<() => unknown> = [];
  let manager: UpstreamManager;

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    cleanups = [];
  });

  async function startManager(servers: Record<string, unknown>, toolRegistry = new ToolRegistry()): Promise<CredentialStore> {
    const { store, cleanup } = makeTestStore("run-tool-registration-");
    cleanups.push(cleanup);
    await store.set("token", { type: "secret", value: "s3cret" });
    manager = new UpstreamManager({
      config: bridgeConfig(servers),
      toolRegistry,
      credentialStore: store,
      _clientFactory: inMemoryClient,
    });
    cleanups.push(() => manager.closeAll());
    return store;
  }

  async function startBridge(
    servers: Record<string, unknown>,
    wrapTransport: (transport: ClientInMemoryTransport) => Transport = (transport) => transport,
  ): Promise<Client> {
    const toolRegistry = new ToolRegistry();
    await startManager(servers, toolRegistry);
    const server = new BridgeServer({
      toolRegistry,
      toolSearchService: new ToolSearchService(toolRegistry),
      getUpstreamClient: (name) => manager.getClient(name),
      onClientsChanged: (listener) => manager.onClientsChanged(listener),
      whenUpstreamRegistered: (name) => manager.whenRegistered(name),
    });
    cleanups.push(() => server.close());
    const [clientSide, serverSide] = ClientInMemoryTransport.createLinkedPair();
    await server.connect(wrapTransport(serverSide));
    void server.sessionStarted().then(() => manager.connectAll());
    const client = new Client({ name: "modern", version: "1" }, { versionNegotiation: { mode: "auto" } });
    cleanups.push(() => client.close());
    await client.connect(clientSide);
    expect(client.getProtocolEra()).toBe("modern");
    return client;
  }

  describe("run_tool as a modern client's first request after its version probe", () => {
    it.each([
      ["a STDIO server", { command: "node", args: ["server.js"] }],
      ["a STDIO server whose env reads the credential store", { command: "node", args: ["server.js"], env: { TOKEN: "${credential:token}" } }],
      ["an HTTP server", { type: "streamable-http", url: "http://127.0.0.1:1/mcp" }],
    ])("reaches %s", async (_name, alpha) => {
      const client = await startBridge({ alpha });

      expect((await runEcho(client, "alpha")).content).toEqual([{ type: "text", text: "echoed" }]);
    });

    it("reaches a STDIO server whose env reads the credential store when the transport drops the session watcher", async () => {
      const client = await startBridge(
        { alpha: { command: "node", args: ["server.js"], env: { TOKEN: "${credential:token}" } } },
        transportKeepingFirstMessageHandler,
      );

      expect((await runEcho(client, "alpha")).content).toEqual([{ type: "text", text: "echoed" }]);
    });

    it("reports a server that is not configured as not found", async () => {
      const client = await startBridge({ alpha: { command: "node", args: ["server.js"] } });

      await expect(runEcho(client, "ghost")).rejects.toThrow(/Upstream server not found: ghost/);
    });

    it("reports a server whose credentials cannot be resolved as not found", async () => {
      const client = await startBridge({
        alpha: { command: "node", args: ["server.js"], env: { TOKEN: "${credential:missing}" } },
      });

      await expect(runEcho(client, "alpha")).rejects.toThrow(/Upstream server not found: alpha/);
    });
  });

  it("run_tool reaches a STDIO server that a reload is still adding", async () => {
    const before = { beta: { command: "node", args: ["other.js"] } };
    const client = await startBridge(before);
    await client.listTools();
    const next = bridgeConfig({ ...before, alpha: { command: "node", args: ["server.js"], env: { TOKEN: "${credential:token}" } } });
    const reload = manager.applyConfigDiff(diffConfigs(bridgeConfig(before), next), next);

    expect((await runEcho(client, "alpha")).content).toEqual([{ type: "text", text: "echoed" }]);
    await reload;
  });

  it("waits only for the registration of the server asked about", async () => {
    const store = await startManager({
      alpha: { command: "node", args: ["server.js"], env: { TOKEN: "${credential:token}" } },
      beta: { type: "streamable-http", url: "http://127.0.0.1:1/mcp" },
    });
    let releaseCredential!: () => void;
    const credentialHeld = new Promise<void>((resolve) => {
      releaseCredential = resolve;
    });
    const get = store.get.bind(store);
    vi.spyOn(store, "get").mockImplementation(async (key: string) => {
      await credentialHeld;
      return get(key);
    });
    const connecting = manager.connectAll();
    const settledFirst = (name: string) =>
      Promise.race([
        manager.whenRegistered(name).then(() => "settled"),
        new Promise((resolve) => setImmediate(() => resolve("waiting"))),
      ]);

    expect(await settledFirst("beta")).toBe("settled");
    expect(await settledFirst("ghost")).toBe("settled");
    expect(await settledFirst("alpha")).toBe("waiting");
    releaseCredential();
    await manager.whenRegistered("alpha");
    expect(manager.getClient("alpha")).toBeDefined();
    await connecting;
  });

  it("reports a server whose credentials cannot be resolved as failed", async () => {
    await startManager({ alpha: { command: "node", args: ["server.js"], env: { TOKEN: "${credential:missing}" } } });

    expect((await manager.connectAll()).failed).toEqual([{ name: "alpha", error: expect.stringContaining("missing") }]);
  });

  it("keeps a connected STDIO server's session when a reload adds an alias of it", async () => {
    const before = { beta: { command: "node", args: ["shared.js"] } };
    await startManager(before);
    await manager.connectAll();
    const opened = sessionsOpened;
    const next = bridgeConfig({ ...before, alpha: { command: "node", args: ["shared.js"] } });

    await manager.applyConfigDiff(diffConfigs(bridgeConfig(before), next), next);

    expect(manager.getClient("alpha")).toBe(manager.getClient("beta"));
    expect(manager.getClient("beta")!.status).toBe("connected");
    expect(sessionsOpened).toBe(opened);
  });

  it("run_tool stops waiting for a registration when the client cancels, without looking the server up again", async () => {
    let markRegistrationAwaited!: () => void;
    const registrationAwaited = new Promise<void>((resolve) => {
      markRegistrationAwaited = resolve;
    });
    let finishRegistration!: () => void;
    const registration = new Promise<void>((resolve) => {
      finishRegistration = resolve;
    });
    const getUpstreamClient = vi.fn(() => undefined);
    const registry = new ToolRegistry();
    const { client, cleanup } = await createTestPair({
      registry,
      toolSearchService: new ToolSearchService(registry),
      getUpstreamClient,
      whenUpstreamRegistered: () => {
        markRegistrationAwaited();
        return registration;
      },
    });
    cleanups.push(cleanup);
    const controller = new AbortController();

    const call = client.callTool(
      { name: "run_tool", arguments: { name: "alpha__echo", arguments: {} } },
      { signal: controller.signal },
    );
    await registrationAwaited;
    controller.abort();
    await expect(call).rejects.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    finishRegistration();
    await new Promise((resolve) => setImmediate(resolve));

    expect(getUpstreamClient).toHaveBeenCalledTimes(1);
  });

  it("run_tool does not wait on registration for a server that is already registered", async () => {
    const whenUpstreamRegistered = vi.fn(() => new Promise<void>(() => {}));
    const upstream = { status: "connected", callTool: vi.fn(async () => ({ content: [{ type: "text", text: "echoed" }] })) };
    const registry = new ToolRegistry();
    const { client, cleanup } = await createTestPair({
      registry,
      toolSearchService: new ToolSearchService(registry),
      getUpstreamClient: () => upstream as unknown as UpstreamClient,
      whenUpstreamRegistered,
    });
    cleanups.push(cleanup);

    expect((await runEcho(client, "alpha")).content).toEqual([{ type: "text", text: "echoed" }]);
    expect(whenUpstreamRegistered).not.toHaveBeenCalled();
  });
});
