import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { ConfigError } from "../../../src/config/loader.js";
import type { SkippedFile } from "../../../src/config/merged-loader.js";
import { BridgeConfigSchema } from "../../../src/config/schema.js";
import type { CredentialStore } from "../../../src/credentials/credential-store.js";
import { Instance } from "../../../src/daemon/instances/instance.js";
import { InstanceHost } from "../../../src/daemon/instances/instance-host.js";
import { UpstreamPool } from "../../../src/daemon/instances/upstream-pool.js";
import { MIN_BRIDGE_PROTOCOL_VERSION, type AttachResult } from "../../../src/daemon/protocol.js";
import type { FrameChannel } from "../../../src/daemon/transport.js";
import { ScriptedUpstreamClient, stdioPoolOptions, tool } from "../../_helpers/scripted-upstream-client.js";
import { spyLogger, type SpyLogger } from "../../_helpers/spy-logger.js";

const SOURCE = { kind: "file", path: "/home/u/bridge.json" } as const;

type Bridge = FrameChannel & { sent: unknown[] };

const BROKEN_CLIENT_FILE = { path: "/home/u/client.json", message: "Invalid JSON in config file: /home/u/client.json" };

const LEFT_OUT = "Invalid JSON in config file: /home/u/client.json; its servers are left out";
const RELOAD_FAILED = { method: "LOG", params: { level: "warn", message: "failed to reload config", context: { error: "Invalid JSON in config file: /home/u/client.json" } } };

const framesOf = (bridge: Bridge, method: string) => bridge.sent.filter((frame) => (frame as { method?: string }).method === method);

const logMessages = (bridge: Bridge) => framesOf(bridge, "LOG").map((frame) => (frame as { params: { message: string } }).params.message);

function scriptedLinear(name: string): ScriptedUpstreamClient {
  const client = new ScriptedUpstreamClient(name);
  client.instructions = "Use create_issue for bugs.";
  client.tools = [tool("create_issue"), tool("delete_issue")];
  return client;
}

function channel(): Bridge {
  const sent: unknown[] = [];
  return Object.assign(new EventEmitter(), { sent, send: (frame: unknown) => sent.push(frame) > 0, close: () => {}, remote: "test" }) as unknown as Bridge;
}

describe("What an instance tells its bridges about its config", () => {
  let config: Record<string, unknown> | "broken";
  let skipped: SkippedFile[];
  let listed: string[];
  let host: InstanceHost;
  let log: SpyLogger;

  async function attach(bridge = channel()): Promise<{ bridge: Bridge; result: AttachResult }> {
    const reply = await host.handleAttach("a", { bridgeProtocolVersion: MIN_BRIDGE_PROTOCOL_VERSION, source: SOURCE, env: {}, childEnv: {} }, bridge);
    return { bridge, result: reply.result as AttachResult };
  }

  const linear = (bridge: Record<string, unknown> = {}) => ({ url: "https://linear.example.com/mcp", _bridge: bridge });

  beforeEach(() => {
    config = { mcpServers: { linear: linear() } };
    skipped = [];
    listed = [BROKEN_CLIENT_FILE.path];
    log = spyLogger();
    host = new InstanceHost({
      idleMs: 60_000,
      logger: log,
      onIdle: () => {},
      stdio: stdioPoolOptions(),
      loadConfig: async () => {
        if (config === "broken") throw new ConfigError("Config validation failed", [{ path: "mcpServers.linear.url", message: "Invalid URL" }]);
        return { config: BridgeConfigSchema.parse(config), watchPaths: listed, skipped };
      },
      createCredentialStore: () => ({}) as CredentialStore,
      createHttpClient: scriptedLinear,
    });
  });

  afterEach(async () => {
    await host.close(0);
  });

  it("answers an attach with the config's log level", async () => {
    config = { mcpServers: { linear: linear() }, _bridge: { logLevel: "debug" } };

    expect((await attach()).result).toEqual({ upstreams: ["linear"], logLevel: "debug", description: { text: expect.stringContaining("\n- linear") } });
  });

  it("tells every attached bridge when a reload changes the log level, and says nothing when it doesn't", async () => {
    const { bridge: first } = await attach();
    config = { mcpServers: { linear: linear() }, _bridge: { logLevel: "warn" } };

    const { bridge: second } = await attach();
    await attach();

    for (const bridge of [first, second]) {
      expect(framesOf(bridge, "SETTINGS")).toEqual([{ method: "SETTINGS", params: { logLevel: "warn" } }]);
    }
  });

  it("tells every attached bridge that a reload failed, keeping the config it had", async () => {
    const { bridge: first } = await attach();
    config = "broken";

    const { bridge: second } = await attach();

    for (const bridge of [first, second]) {
      expect(bridge.sent).toContainEqual({
        method: "LOG",
        params: { level: "warn", message: "failed to reload config", context: { error: "Config validation failed: mcpServers.linear.url: Invalid URL" } },
      });
    }
    expect(host.statusInstances()[0]!.upstreams).toEqual(["linear"]);
  });

  it.each([
    ["a removed setting", { mcpServers: { linear: linear({ sharing: "auto" }) } }, /^sharing no longer has any effect/],
    ["a changed log format", { mcpServers: { linear: linear() }, _bridge: { logFormat: "json" } }, /^_bridge\.logFormat changed; restart the AI clients/],
  ])("tells every attached bridge about %s when it reloads", async (_case, next, message) => {
    const { bridge: first } = await attach();
    config = next;

    const { bridge: second } = await attach();

    for (const bridge of [first, second]) {
      expect(bridge.sent).toContainEqual({ method: "LOG", params: expect.objectContaining({ level: "warn", message: expect.stringMatching(message) }) });
    }
  });

  it("keeps the last config when a reload would leave out a file it lists, telling bridges once while it stays that way", async () => {
    const { bridge } = await attach();
    config = {};
    skipped = [BROKEN_CLIENT_FILE];

    await attach();
    await attach();

    expect(framesOf(bridge, "LOG")).toEqual([
      RELOAD_FAILED,
    ]);
    expect(host.statusInstances()[0]!.upstreams).toEqual(["linear"]);
  });

  it("tells bridges again when a listed file breaks the same way after it was fixed", async () => {
    const { bridge } = await attach();
    const breakFile = () => {
      config = {};
      skipped = [BROKEN_CLIENT_FILE];
    };

    breakFile();
    await attach();
    config = { mcpServers: { linear: linear() } };
    skipped = [];
    await attach();
    breakFile();
    await attach();

    expect(framesOf(bridge, "LOG")).toEqual([RELOAD_FAILED, RELOAD_FAILED]);
  });

  it("applies an edit that lists a new client file that isn't JSON yet, telling bridges it is left out", async () => {
    listed = [];
    const { bridge } = await attach();
    listed = [BROKEN_CLIENT_FILE.path];
    skipped = [BROKEN_CLIENT_FILE];
    config = { mcpServers: { linear: linear(), docs: { url: "https://docs.example.com/mcp" } } };

    const { bridge: finding } = await attach();
    await attach();

    expect(host.statusInstances()[0]!.upstreams).toEqual(["docs", "linear"]);
    expect(framesOf(bridge, "LOG").filter((frame) => !JSON.stringify(frame).includes("failed to watch"))).toEqual([
      { method: "LOG", params: { level: "warn", message: LEFT_OUT } },
    ]);
    expect(framesOf(finding, "LOG").filter((frame) => JSON.stringify(frame).includes("left out"))).toHaveLength(1);
  });

  it("tells a bridge that joins later about a file still left out, once", async () => {
    skipped = [BROKEN_CLIENT_FILE];
    const { bridge: first } = await attach();

    const { bridge: second } = await attach();

    expect(framesOf(second, "LOG")).toEqual([{ method: "LOG", params: { level: "warn", message: LEFT_OUT } }]);
    expect(framesOf(first, "LOG")).toEqual([{ method: "LOG", params: { level: "warn", message: LEFT_OUT } }]);
  });

  it("keeps the last config when a client file a reload added breaks", async () => {
    listed = ["/home/u/other.json"];
    const { bridge } = await attach();
    listed = ["/home/u/other.json", BROKEN_CLIENT_FILE.path];
    config = { mcpServers: { linear: linear(), docs: { url: "https://docs.example.com/mcp" } } };
    await attach();
    config = { mcpServers: { linear: linear() } };
    skipped = [BROKEN_CLIENT_FILE];

    await attach();

    expect(host.statusInstances()[0]!.upstreams).toEqual(["docs", "linear"]);
    expect(logMessages(bridge)).toContain("failed to reload config");
  });

  it("doesn't tell a bridge about a file left out that its attach finds fixed", async () => {
    skipped = [BROKEN_CLIENT_FILE];
    await attach();
    skipped = [];

    const { bridge } = await attach();

    expect(framesOf(bridge, "LOG")).toEqual([]);
  });

  it("keeps the last config when a file left out as it opened is fixed and then breaks again", async () => {
    skipped = [BROKEN_CLIENT_FILE];
    const { bridge } = await attach();
    config = { mcpServers: { linear: linear(), docs: { url: "https://docs.example.com/mcp" } } };
    skipped = [];
    await attach();
    config = {};
    skipped = [BROKEN_CLIENT_FILE];

    await attach();

    expect(host.statusInstances()[0]!.upstreams).toEqual(["docs", "linear"]);
    expect(logMessages(bridge)).toContain("failed to reload config");
  });

  it("tells each bridge that attaches which listed files the config leaves out", async () => {
    skipped = [BROKEN_CLIENT_FILE];

    const { bridge } = await attach();

    expect(framesOf(bridge, "LOG")).toEqual([
      { method: "LOG", params: { level: "warn", message: LEFT_OUT } },
    ]);
    expect(log.warn).toHaveBeenCalledWith(LEFT_OUT, undefined);
  });

  it("still applies edits to the other files when a file it lists was already left out as it opened", async () => {
    skipped = [BROKEN_CLIENT_FILE];
    const { bridge } = await attach();
    config = { mcpServers: { linear: linear(), docs: { url: "https://docs.example.com/mcp" } } };

    await attach();

    expect(host.statusInstances()[0]!.upstreams).toEqual(["docs", "linear"]);
    expect(logMessages(bridge)).not.toContain("failed to reload config");
  });

  it("logs a server a reload finds launching the bridge itself in the manager log only", async () => {
    const { bridge } = await attach();
    config = { mcpServers: { linear: linear(), self: { command: "npx", args: ["crabeye-mcp-bridge"] } } };

    await attach();

    expect(log.info).toHaveBeenCalledWith('skipping server "self": it launches crabeye-mcp-bridge itself', { component: "config" });
    expect(framesOf(bridge, "LOG")).toEqual([]);
  });

  it("doesn't repeat a warning about the config when a reload leaves it as it was", async () => {
    config = { mcpServers: { linear: linear({ sharing: "auto" }) } };
    const { bridge } = await attach();
    config = { mcpServers: { linear: linear({ sharing: "auto", category: "tracker" }) } };

    await attach();
    await attach();

    expect(framesOf(bridge, "LOG")).toEqual([]);
  });
});

describe("An instance's passthrough blocks", () => {
  let pool: UpstreamPool;
  let instance: Instance | undefined;

  beforeEach(() => {
    pool = new UpstreamPool({
      logger: spyLogger(),
      stdio: stdioPoolOptions(),
      createHttpClient: scriptedLinear,
    });
  });

  afterEach(async () => {
    await instance?.close();
    await pool.close(0);
  });

  async function open(servers: Record<string, unknown>): Promise<Instance> {
    instance = await Instance.open(SOURCE, { env: {}, childEnv: {} }, {
      pool,
      logger: spyLogger(),
      loadConfig: async () => ({ config: BridgeConfigSchema.parse({ mcpServers: servers }), watchPaths: [] }),
      createCredentialStore: () => ({}) as CredentialStore,
    });
    await vi.waitFor(() => expect(instance!.search({ queries: [{ provider: "linear" }] }).results[0]!.total).toBeGreaterThan(0));
    return instance;
  }

  it("renders a server's instructions and tools, leaving out tools the policy disables", async () => {
    const opened = await open({ linear: { url: "https://linear.example.com/mcp", _bridge: { passthrough: "tools", tools: { delete_issue: "never" } } } });

    expect(opened.passthrough()).toBe("## linear\n\nUse create_issue for bugs.\n\n### Tools\n\n- linear__create_issue");
  });

  it("renders nothing when no server asks for it", async () => {
    expect((await open({ linear: { url: "https://linear.example.com/mcp" } })).passthrough()).toBe("");
  });
});

describe("An instance's search description", () => {
  const HEADER = "Servers (search by provider name):";
  const linear = (bridge: Record<string, unknown> = { category: "issues" }) => ({ url: "https://linear.example.com/mcp", _bridge: bridge });
  const docs = { url: "https://docs.example.com/mcp" };
  let config: Record<string, unknown>;
  let clients: Map<string, ScriptedUpstreamClient>;
  let host: InstanceHost;

  beforeEach(() => {
    config = { mcpServers: { linear: linear(), docs } };
    clients = new Map();
    host = new InstanceHost({
      idleMs: 60_000,
      logger: spyLogger(),
      onIdle: () => {},
      stdio: stdioPoolOptions(),
      loadConfig: async () => ({ config: BridgeConfigSchema.parse(config), watchPaths: [] }),
      createCredentialStore: () => ({}) as CredentialStore,
      createHttpClient: (name) => {
        const client = scriptedLinear(name);
        clients.set(name, client);
        return client;
      },
    });
  });

  afterEach(async () => {
    await host.close(0);
  });

  async function attach(bridge = channel()): Promise<{ bridge: Bridge; result: AttachResult }> {
    const reply = await host.handleAttach("a", { bridgeProtocolVersion: MIN_BRIDGE_PROTOCOL_VERSION, source: SOURCE, env: {}, childEnv: {} }, bridge);
    return { bridge, result: reply.result as AttachResult };
  }

  const descriptions = (bridge: Bridge) => framesOf(bridge, "DESCRIPTION").map((frame) => (frame as { params: { text: string } }).params.text);

  async function connected(...names: string[]): Promise<void> {
    await vi.waitFor(() => expect(names.map((name) => clients.get(name)?.status)).toEqual(names.map(() => "connected")));
  }

  it("answers an attach with every server, in config order, with its category and the status of each that isn't connected", async () => {
    const { bridge: first } = await attach();
    await connected("linear", "docs");
    clients.get("docs")!.setStatus("disconnected", new Error("reset"));

    const { result } = await attach();

    expect(result.description).toEqual({ text: `${HEADER}\n- linear [issues]\n- docs: not connected` });
    expect(descriptions(first).at(-1)).toBe(result.description.text);
  });

  it("tells every attached bridge each time a server's status changes the text", async () => {
    const { bridge: a } = await attach();
    const { bridge: b } = await attach();
    await connected("linear", "docs");
    const docsClient = clients.get("docs")!;
    const needsAuthorization = "- docs: needs authorization; the user runs: crabeye-mcp-bridge auth docs, or updates its credentials if it doesn't use OAuth";

    for (const [status, error, shown] of [
      ["auth_required", new Error("HTTP 401"), needsAuthorization],
      ["connecting", undefined, "- docs: starting"],
      ["connected", undefined, "- docs"],
      ["disconnected", new Error("connect ECONNREFUSED"), "- docs: not connected"],
      ["connected", undefined, "- docs"],
      ["disconnected", undefined, "- docs: starting"],
      ["connected", undefined, "- docs"],
    ] as const) {
      docsClient.setStatus(status, error);
      for (const bridge of [a, b]) expect(descriptions(bridge).at(-1)).toBe(`${HEADER}\n- linear [issues]\n${shown}`);
    }
  });

  it("keeps a server that failed to connect listed as not connected while it tries again, telling bridges nothing", async () => {
    const { bridge } = await attach();
    await connected("linear", "docs");
    const docsClient = clients.get("docs")!;
    docsClient.setStatus("disconnected", new Error("connect ECONNREFUSED"));
    const heard = descriptions(bridge).length;

    docsClient.setStatus("connecting");
    docsClient.setStatus("disconnected", new Error("connect ETIMEDOUT"));
    docsClient.setStatus("connecting");

    expect(descriptions(bridge)).toHaveLength(heard);
    expect(descriptions(bridge).at(-1)).toBe(`${HEADER}\n- linear [issues]\n- docs: not connected`);
  });

  it("tells bridges when a reload adds or removes a server or changes a category, and not when it changes neither", async () => {
    const { bridge } = await attach();
    await connected("linear", "docs");
    const heard = descriptions(bridge).length;

    for (const unannounced of [
      { mcpServers: { linear: linear({ category: "issues", tools: { delete_issue: "never" } }), docs } },
      { mcpServers: { linear: linear({ category: "issues", rateLimit: { maxCalls: 5, windowSeconds: 60 } }), docs } },
      { mcpServers: { linear: linear({ category: "issues", rateLimit: { maxCalls: 5, windowSeconds: 60 } }), docs } },
    ]) {
      config = unannounced;
      await attach();
    }
    expect(descriptions(bridge)).toHaveLength(heard);

    config = { mcpServers: { linear: linear({ category: "tracker" }), docs } };
    await attach();
    expect(descriptions(bridge).at(-1)).toBe(`${HEADER}\n- linear [tracker]\n- docs`);

    config = { mcpServers: { linear: linear({ category: "tracker" }), wiki: { url: "https://wiki.example.com/mcp" } } };
    await attach();
    await connected("wiki");
    expect(descriptions(bridge).at(-1)).toBe(`${HEADER}\n- linear [tracker]\n- wiki`);
  });

  it("tells bridges nothing when a server changes its tools", async () => {
    const { bridge } = await attach();
    await connected("linear", "docs");
    const heard = descriptions(bridge).length;

    clients.get("linear")!.setTools([tool("other")]);

    expect(descriptions(bridge)).toHaveLength(heard);
  });

  it("is empty with no servers", async () => {
    config = { mcpServers: {} };

    expect((await attach()).result.description).toEqual({ text: "" });
  });
});
