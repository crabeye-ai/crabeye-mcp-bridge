import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeConfigSchema, type BridgeConfig, type HttpServerConfig } from "../../../src/config/schema.js";
import type { CredentialStore } from "../../../src/credentials/credential-store.js";
import { HttpUpstreamPool } from "../../../src/daemon/instances/http-upstream-pool.js";
import { Instance, type InstanceDeps, type InstanceNotification } from "../../../src/daemon/instances/instance.js";
import type { InstanceSource } from "../../../src/daemon/protocol.js";
import type { Logger } from "../../../src/logging/index.js";
import { rewriteUntil } from "../../_helpers/rewrite-until.js";
import { ScriptedUpstreamClient } from "../../_helpers/scripted-upstream-client.js";
import { spyLogger, type SpyLogger } from "../../_helpers/spy-logger.js";

const MIXED = {
  mcpServers: {
    plain: { url: "https://plain.example.com/mcp" },
    events: { type: "sse", url: "https://events.example.com/sse" },
    oauth: { url: "https://oauth.example.com/mcp", _bridge: { auth: { type: "oauth2" } } },
    local: { command: "node", args: ["server.js"] },
  },
};

const WATCHED = { timeout: 10_000, interval: 200 };

const watchers = vi.hoisted(() => [] as Array<{ dir: string; closed: boolean }>);

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const watch = ((dir: string, ...rest: unknown[]) => {
    const watcher = (actual.watch as (...args: unknown[]) => import("node:fs").FSWatcher)(dir, ...rest);
    const entry = { dir, closed: false };
    watchers.push(entry);
    const close = watcher.close.bind(watcher);
    watcher.close = () => {
      entry.closed = true;
      close();
    };
    return watcher;
  }) as typeof actual.watch;
  return { ...actual, watch, default: { ...actual, watch } };
});

const watching = (dir: string): boolean => watchers.some((watcher) => watcher.dir === dir && !watcher.closed);

function recorder(): { notifications: InstanceNotification[]; send: (n: InstanceNotification) => void } {
  const notifications: InstanceNotification[] = [];
  return { notifications, send: (n) => notifications.push(n) };
}

describe("Instance", () => {
  let dir: string;
  let configPath: string;
  let source: InstanceSource;
  let current: unknown;
  let log: SpyLogger;
  let clients: ScriptedUpstreamClient[];
  let clientLogs: Map<string, Logger>;
  let created: Array<{ name: string; config: HttpServerConfig; env: Record<string, string> }>;
  let pool: HttpUpstreamPool;
  let stores: Array<Record<string, string>>;
  let deps: InstanceDeps;
  const instances: Instance[] = [];

  async function writeConfig(config: unknown): Promise<void> {
    current = config;
    await writeFile(configPath, JSON.stringify(config));
  }

  async function open(env: Record<string, string> = {}): Promise<Instance> {
    const instance = await Instance.open(source, env, deps);
    instances.push(instance);
    return instance;
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cbe-instance-"));
    configPath = join(dir, "bridge.json");
    source = { kind: "file", path: configPath };
    log = spyLogger();
    clients = [];
    clientLogs = new Map();
    created = [];
    stores = [];
    pool = new HttpUpstreamPool({
      logger: log,
      createClient: (name, config, { logger, env }) => {
        const client = new ScriptedUpstreamClient(name);
        clients.push(client);
        clientLogs.set(name, logger);
        created.push({ name, config, env });
        return client;
      },
    });
    deps = {
      pool,
      logger: log,
      loadConfig: async () => ({ config: BridgeConfigSchema.parse(current) as BridgeConfig, watchPaths: [configPath] }),
      createCredentialStore: (env) => {
        stores.push(env);
        return {} as CredentialStore;
      },
      watchDebounceMs: 20,
    };
    await writeConfig(MIXED);
  });

  afterEach(async () => {
    await Promise.all(instances.splice(0).map((instance) => instance.close()));
    await pool.close(0);
    await rm(dir, { recursive: true, force: true });
  });

  it("hosts every HTTP and SSE server, with or without _bridge.auth, and no STDIO one", async () => {
    const instance = await open();

    expect(instance.status()).toEqual({ source, bridges: 0, upstreams: ["events", "oauth", "plain"] });
    expect(clients.map((c) => c.name).sort()).toEqual(["events", "oauth", "plain"]);
  });

  it("opens its credential store with the instance's environment, and gives a connection only the client secret variable it names", async () => {
    current = { mcpServers: { ...MIXED.mcpServers, oauth: { ...MIXED.mcpServers.oauth, _bridge: { auth: { type: "oauth2", clientSecret: "${NOTION_OAUTH_SECRET}" } } } } };

    await open({ MCP_BRIDGE_MASTER_KEY: "k", NOTION_OAUTH_SECRET: "s", OTHER_OAUTH: "o" });

    expect(stores).toEqual([{ MCP_BRIDGE_MASTER_KEY: "k", NOTION_OAUTH_SECRET: "s", OTHER_OAUTH: "o" }]);
    expect(Object.fromEntries(created.map((c) => [c.name, c.env]))).toEqual({ plain: {}, events: {}, oauth: { NOTION_OAUTH_SECRET: "s" } });
  });

  it("rejects when the config can't be loaded", async () => {
    deps.loadConfig = () => Promise.reject(new Error("Config file not found: /x"));
    await expect(Instance.open(source, {}, deps)).rejects.toThrow("Config file not found");
  });

  it("greets an attachment with a snapshot of each server, then keeps it up to date until it detaches", async () => {
    const instance = await open();
    const bridge = recorder();

    instance.attach(bridge);
    expect(instance.upstreamNames().sort()).toEqual(["events", "oauth", "plain"]);
    expect(bridge.notifications.map((n) => n.method)).toEqual(["UPSTREAM", "UPSTREAM", "UPSTREAM"]);
    const plain = clients.find((c) => c.name === "plain")!;
    plain.setStatus("disconnected", new Error("reset"));
    expect(bridge.notifications.at(-1)).toEqual({ method: "UPSTREAM", params: { name: "plain", status: "disconnected", error: "reset", tools: [] } });

    instance.detach(bridge);
    plain.setStatus("connected");
    expect(bridge.notifications).toHaveLength(4);
    expect(instance.attachmentCount).toBe(0);
  });

  it("sends a connection's warnings to every attachment, naming the server", async () => {
    const instance = await open();
    const [a, b] = [recorder(), recorder()];
    instance.attach(a);
    instance.attach(b);

    clientLogs.get("plain")!.warn("ping failed", { failures: 1 });

    const expected = { method: "LOG", params: { upstream: "plain", level: "warn", message: "ping failed", context: { failures: 1 } } };
    expect(a.notifications).toContainEqual(expected);
    expect(b.notifications).toContainEqual(expected);
  });

  it("shares a connection with another instance that has the same server, and splits on a different master key", async () => {
    await open({ MCP_BRIDGE_MASTER_KEY: "k" });
    source = { kind: "file", path: join(dir, "other.json") };
    await open({ MCP_BRIDGE_MASTER_KEY: "k" });
    expect(clients).toHaveLength(3);
    expect(pool.upstreams().map((u) => u.ownerCount)).toEqual([2, 2, 2]);

    await open({ MCP_BRIDGE_MASTER_KEY: "other" });
    expect(clients).toHaveLength(6);
  });

  describe("when its config file changes", { timeout: 30_000 }, () => {
    afterEach(() => {
      expect(log.error).not.toHaveBeenCalled();
    });

    it("adds, removes and reconnects servers, telling attachments", async () => {
      const instance = await open();
      const bridge = recorder();
      instance.attach(bridge);
      const greeting = bridge.notifications.length;
      const oldPlain = clients.find((c) => c.name === "plain")!;

      const edited = {
        mcpServers: {
          plain: { url: "https://plain.example.com/v2" },
          fresh: { url: "https://fresh.example.com/mcp" },
        },
      };

      await rewriteUntil(() => writeConfig(edited), () => expect(instance.status().upstreams).toEqual(["fresh", "plain"]));
      await vi.waitFor(() => expect(oldPlain.closed).toBe(true), WATCHED);
      const plains = clients.filter((c) => c.name === "plain");
      expect(plains).toHaveLength(2);
      expect(plains[1]!.closed).toBe(false);
      expect(clients.find((c) => c.name === "events")!.closed).toBe(true);
      expect(bridge.notifications).toContainEqual({ method: "UPSTREAM_REMOVED", params: { upstream: "events" } });
      const sentAfterEdit = new Set(bridge.notifications.slice(greeting).filter((n) => n.method === "UPSTREAM").map((n) => n.params.name));
      expect(sentAfterEdit).toEqual(new Set(["plain", "fresh"]));
    });

    it("connects a server again with its new settings when its _bridge.auth changes", async () => {
      const instance = await open();
      const bridge = recorder();
      instance.attach(bridge);
      const greeting = bridge.notifications.length;
      const oauth = clients.find((c) => c.name === "oauth")!;
      const plain = clients.find((c) => c.name === "plain")!;
      const scoped = { mcpServers: { ...MIXED.mcpServers, oauth: { ...MIXED.mcpServers.oauth, _bridge: { auth: { type: "oauth2", scopes: ["read"] } } } } };

      await rewriteUntil(() => writeConfig(scoped), () => expect(created.filter((c) => c.name === "oauth")).toHaveLength(2));

      await vi.waitFor(() => expect(oauth.closed).toBe(true), WATCHED);
      expect(created.at(-1)!.config._bridge?.auth).toEqual({ type: "oauth2", scopes: ["read"] });
      expect(plain.closed).toBe(false);
      expect(bridge.notifications.slice(greeting)).toContainEqual(expect.objectContaining({ method: "UPSTREAM", params: expect.objectContaining({ name: "oauth" }) }));
      expect(bridge.notifications).not.toContainEqual({ method: "UPSTREAM_REMOVED", params: { upstream: "oauth" } });
    });

    it("keeps the last good config when the new one doesn't load", async () => {
      const instance = await open();
      deps.loadConfig = () => Promise.reject(new Error("Invalid JSON in config file"));

      await rewriteUntil(
        () => writeFile(configPath, "{ not json"),
        () => expect(log.warn).toHaveBeenCalledWith("failed to reload config", expect.objectContaining({ error: "Invalid JSON in config file" })),
      );
      expect(instance.status().upstreams).toEqual(["events", "oauth", "plain"]);
    });

    it("retries a server paused for authorization", async () => {
      await open();
      const plain = clients.find((c) => c.name === "plain")!;
      plain.setStatus("auth_required", new Error("needs auth"));
      const retries = plain.retries;

      await rewriteUntil(
        () => writeConfig({ ...MIXED, _bridge: { toolPolicy: "never" } }),
        () => expect(plain.retries).toBeGreaterThan(retries),
      );
    });
  });

  it("shares one reload between calls made while another reload runs", async () => {
    const instance = await open();
    let loads = 0;
    let finish!: () => void;
    const loadConfig = deps.loadConfig;
    deps.loadConfig = async (source) => {
      loads++;
      if (loads === 1) await new Promise<void>((resolve) => (finish = resolve));
      return loadConfig(source);
    };

    const running = instance.reload();
    const followers = [instance.reload(), instance.reload(), instance.reload()];
    finish();
    await Promise.all([running, ...followers]);

    expect(loads).toBe(2);
  });

  it("applies a changed health-check interval to the connections it opened", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      current = { ...MIXED, _bridge: { healthCheckInterval: 0 } };
      const instance = await open();
      const ping = vi.spyOn(clients.find((c) => c.name === "plain")!, "ping");
      current = { ...MIXED, _bridge: { healthCheckInterval: 1 } };

      await instance.reload();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(ping).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reloads before saying it has no such server", async () => {
    const instance = await open();
    current = { mcpServers: { ...MIXED.mcpServers, fresh: { url: "https://fresh.example.com/mcp" } } };

    expect((await instance.upstream("fresh"))?.name).toBe("fresh");
    expect(await instance.upstream("missing")).toBeUndefined();
  });

  it("applies an edit back to the config it had after a forced reload applied another", { timeout: 30_000 }, async () => {
    const instance = await open();
    current = { mcpServers: { plain: MIXED.mcpServers.plain } };
    await instance.reload();
    expect(instance.status().upstreams).toEqual(["plain"]);

    await rewriteUntil(() => writeConfig(MIXED), () => expect(instance.status().upstreams).toEqual(["events", "oauth", "plain"]));
  });

  it("watches the files a reload names, such as a client file added to the bridge-owned config", { timeout: 30_000 }, async () => {
    const clientsDir = await mkdtemp(join(tmpdir(), "cbe-instance-clients-"));
    onTestFinished(() => rm(clientsDir, { recursive: true, force: true }));
    const otherPath = join(clientsDir, "client.json");
    let watched = [configPath];
    const loadConfig = deps.loadConfig;
    deps.loadConfig = async (source) => ({ ...(await loadConfig(source)), watchPaths: watched });
    const instance = await open();
    await writeFile(otherPath, "{}");
    watched = [configPath, otherPath];
    expect(watching(clientsDir)).toBe(false);
    await instance.reload();
    expect(watching(clientsDir)).toBe(true);
    current = { mcpServers: { ...MIXED.mcpServers, fresh: { url: "https://fresh.example.com/mcp" } } };

    await rewriteUntil(() => writeFile(otherPath, JSON.stringify(current)), () => expect(instance.status().upstreams).toContain("fresh"));
  });

  it("keeps watching a file a later reload couldn't read, so fixing it is noticed", { timeout: 30_000 }, async () => {
    const clientsDir = await mkdtemp(join(tmpdir(), "cbe-instance-clients-"));
    onTestFinished(() => rm(clientsDir, { recursive: true, force: true }));
    const otherPath = join(clientsDir, "client.json");
    await writeFile(otherPath, "{}");
    let watched = [configPath, otherPath];
    const loadConfig = deps.loadConfig;
    deps.loadConfig = async (source) => ({ ...(await loadConfig(source)), watchPaths: watched });
    const instance = await open();
    expect(watching(clientsDir)).toBe(true);
    watched = [configPath];
    await instance.reload();
    expect(watching(clientsDir)).toBe(true);
    current = { mcpServers: { ...MIXED.mcpServers, fresh: { url: "https://fresh.example.com/mcp" } } };

    await rewriteUntil(() => writeFile(otherPath, JSON.stringify(current)), () => expect(instance.status().upstreams).toContain("fresh"));
  });

  it("releases its connections when it closes", async () => {
    const instance = await open();
    await instance.close();
    await vi.waitFor(() => expect(clients.every((c) => c.closed)).toBe(true));
    expect(instance.status().upstreams).toEqual([]);
  });
});
