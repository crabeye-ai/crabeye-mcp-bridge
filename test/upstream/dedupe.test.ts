import { describe, it, expect } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { DaemonStdioClient } from "../../src/upstream/daemon-stdio-client.js";
import { UpstreamManager } from "../../src/upstream/upstream-manager.js";
import { ToolRegistry } from "../../src/server/tool-registry.js";
import { BridgeConfigSchema } from "../../src/config/schema.js";
import type { Logger } from "../../src/logging/index.js";

function noopLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
    setLevel: noop,
  };
  return logger;
}

function captureWarn(): { logger: Logger; warns: string[] } {
  const warns: string[] = [];
  const base = noopLogger();
  const logger: Logger = {
    ...base,
    warn: (msg: string) => warns.push(msg),
    child: () => logger,
  };
  return { logger, warns };
}

function makeStubServer(toolName: string): { server: Server; serverSide: ReturnType<typeof InMemoryTransport.createLinkedPair>[1] } {
  const server = new Server(
    { name: "stub", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true } } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [{ name: toolName, description: "tool", inputSchema: { type: "object" as const } }],
  }));
  const [, serverSide] = InMemoryTransport.createLinkedPair();
  return { server, serverSide };
}

describe("UpstreamManager hash dedupe", () => {
  it(
    "two STDIO entries with identical resolved spec collapse to one underlying client; both names visible",
    async () => {
      const { logger, warns } = captureWarn();
      const toolRegistry = new ToolRegistry();

      // Track how many DaemonStdioClient instances the factory creates.
      let factoryCalls = 0;
      const config = BridgeConfigSchema.parse({
        mcpServers: {
          "primary": { command: "node", args: ["server.js"] },
          "alias": { command: "node", args: ["server.js"] },
        },
      });

      const manager = new UpstreamManager({
        config,
        toolRegistry,
        logger,
        _clientFactory: (name) => {
          factoryCalls++;
          const stub = makeStubServer(`tool-${name}`);
          const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
          stub.server.connect(serverSide);
          return new DaemonStdioClient({
            name,
            config: { command: "node", args: ["server.js"] },
            resolvedEnv: {},
            _transportFactory: () => clientSide,
          });
        },
      });

      const result = await manager.connectAll();
      expect(result.connected).toBe(2);

      // One factory call -> one underlying client, but both names usable.
      expect(factoryCalls).toBe(1);
      expect(manager.getClient("primary")).toBeDefined();
      expect(manager.getClient("alias")).toBeDefined();
      expect(manager.getClient("primary")).toBe(manager.getClient("alias"));

      // Tool registry shows the same tools under both name prefixes.
      expect(toolRegistry.getTool("primary__tool-primary")).toBeDefined();
      expect(toolRegistry.getTool("alias__tool-primary")).toBeDefined();

      // WARN log fired on collapse.
      expect(warns.some((w) => w.includes("shares resolved spec hash"))).toBe(true);

      await manager.closeAll();
    },
  );

  it("two STDIO entries with different args do NOT collapse", async () => {
    const toolRegistry = new ToolRegistry();
    let factoryCalls = 0;
    const config = BridgeConfigSchema.parse({
      mcpServers: {
        "alpha": { command: "node", args: ["server.js"] },
        "beta": { command: "node", args: ["other.js"] },
      },
    });

    const manager = new UpstreamManager({
      config,
      toolRegistry,
      _clientFactory: (name) => {
        factoryCalls++;
        const stub = makeStubServer(`tool-${name}`);
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        stub.server.connect(serverSide);
        return new DaemonStdioClient({
          name,
          config: { command: "node", args: ["server.js"] },
          resolvedEnv: {},
          _transportFactory: () => clientSide,
        });
      },
    });

    await manager.connectAll();
    expect(factoryCalls).toBe(2);
    expect(manager.getClient("alpha")).not.toBe(manager.getClient("beta"));

    await manager.closeAll();
  });

  it(
    "two STDIO entries with different env values do NOT collapse (different hash)",
    async () => {
      const toolRegistry = new ToolRegistry();
      let factoryCalls = 0;
      const config = BridgeConfigSchema.parse({
        mcpServers: {
          "alpha": { command: "node", args: ["server.js"], env: { TOKEN: "a" } },
          "beta": { command: "node", args: ["server.js"], env: { TOKEN: "b" } },
        },
      });

      const manager = new UpstreamManager({
        config,
        toolRegistry,
        _clientFactory: (name) => {
          factoryCalls++;
          const stub = makeStubServer(`tool-${name}`);
          const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
          stub.server.connect(serverSide);
          return new DaemonStdioClient({
            name,
            config: { command: "node", args: ["server.js"] },
            resolvedEnv: {},
            _transportFactory: () => clientSide,
          });
        },
      });

      await manager.connectAll();
      expect(factoryCalls).toBe(2);
      await manager.closeAll();
    },
  );
});
