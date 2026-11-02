import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeConfigSchema, type BridgeConfig } from "../../../src/config/schema.js";
import type { CredentialStore } from "../../../src/credentials/credential-store.js";
import { takeSlotFor } from "../../../src/daemon/instances/hosted-calls.js";
import { Instance, type InstanceNotification } from "../../../src/daemon/instances/instance.js";
import type { Lease } from "../../../src/daemon/instances/upstream-pool.js";
import { CallRefusedError } from "../../../src/upstream/call-errors.js";
import { UpstreamPool } from "../../../src/daemon/instances/upstream-pool.js";
import type { InstanceSource } from "../../../src/daemon/protocol.js";
import { WAIT_FOR_RESPAWN_MS } from "../../../src/server/upstream-wait.js";
import { ScriptedUpstreamClient, stdioPoolOptions } from "../../_helpers/scripted-upstream-client.js";
import { spyLogger, type SpyLogger } from "../../_helpers/spy-logger.js";

const WINDOW_MS = 30_000;
const limited = (maxCalls: number, extra: Record<string, unknown> = {}) => ({
  url: "https://svc.example.com/mcp",
  _bridge: { rateLimit: { maxCalls, windowSeconds: WINDOW_MS / 1000 }, ...extra },
});

describe("An instance's tool calls", () => {
  let configs: Map<string, unknown>;
  let clients: ScriptedUpstreamClient[];
  let pool: UpstreamPool;
  let log: SpyLogger;
  const instances: Instance[] = [];

  async function open(path = "/home/u/a.json"): Promise<Instance> {
    const source: InstanceSource = { kind: "file", path };
    const instance = await Instance.open(source, { env: {}, childEnv: {} }, {
      pool,
      logger: log,
      loadConfig: async ({ path: loaded }) => ({ config: BridgeConfigSchema.parse(configs.get(loaded)) as BridgeConfig, watchPaths: [] }),
      createCredentialStore: () => ({}) as CredentialStore,
    });
    instances.push(instance);
    return instance;
  }

  async function call(instance: Instance, options: { approved?: boolean; signal?: AbortSignal } = {}) {
    const upstream = await instance.upstream("svc");
    let outcome: "called" | Error | undefined;
    void upstream!
      .callTool({ name: "op", arguments: { q: 1 } }, { signal: options.signal ?? new AbortController().signal, approved: options.approved })
      .then(
        () => (outcome = "called"),
        (err: Error) => (outcome = err),
      );
    await vi.advanceTimersByTimeAsync(0);
    return { outcome: () => outcome };
  }

  async function reload(instance: Instance, path: string, config: unknown): Promise<void> {
    configs.set(path, config);
    await instance.reload();
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    configs = new Map([["/home/u/a.json", { mcpServers: { svc: limited(1) } }]]);
    log = spyLogger();
    clients = [];
    pool = new UpstreamPool({
      logger: spyLogger(),
      stdio: stdioPoolOptions(),
      createHttpClient: (name) => {
        const client = new ScriptedUpstreamClient(name);
        clients.push(client);
        return client;
      },
    });
  });

  afterEach(async () => {
    await Promise.all(instances.splice(0).map((instance) => instance.close()));
    await pool.close(0);
    vi.useRealTimers();
  });

  it("holds a call until its rate limit has a slot", async () => {
    const instance = await open();
    await call(instance);

    const second = await call(instance);
    expect(second.outcome()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(WINDOW_MS);

    expect(second.outcome()).toBe("called");
    expect(clients[0]!.calls.map(({ name, arguments: args }) => ({ name, args }))).toEqual([
      { name: "op", args: { q: 1 } },
      { name: "op", args: { q: 1 } },
    ]);
  });

  it("shares one budget between instances whose configs set the same limit on one connection, and gives another limit its own", async () => {
    configs.set("/home/u/b.json", { mcpServers: { svc: limited(1) } });
    configs.set("/home/u/c.json", { mcpServers: { svc: limited(5) } });
    const [a, b, c] = [await open(), await open("/home/u/b.json"), await open("/home/u/c.json")];
    await call(a);

    const sameLimit = await call(b);
    const ownLimit = await call(c);

    expect(clients).toHaveLength(1);
    expect(sameLimit.outcome()).toBeUndefined();
    expect(ownLimit.outcome()).toBe("called");
  });

  it.each([
    ["it shares the budget with another config", true],
    ["it is the only one using it", false],
  ])("refuses a waiting call at once as removed when a reload removes its server and %s", async (_case, shared) => {
    configs.set("/home/u/b.json", { mcpServers: { svc: limited(1) } });
    const instance = await open();
    if (shared) await open("/home/u/b.json");
    await call(instance);
    const waiting = await call(instance);

    await reload(instance, "/home/u/a.json", { mcpServers: {} });
    await vi.advanceTimersByTimeAsync(0);

    expect(waiting.outcome()).toEqual(new CallRefusedError('Upstream server "svc" was removed from the configuration'));
  });

  it.each([
    ["it shares the old connection with another config", true],
    ["it is the only one using it", false],
  ])("sends a waiting call to the new connection at once when a reload replaces the server and %s", async (_case, shared) => {
    configs.set("/home/u/b.json", { mcpServers: { svc: limited(1) } });
    const instance = await open();
    if (shared) await open("/home/u/b.json");
    await call(instance);
    const waiting = await call(instance);

    await reload(instance, "/home/u/a.json", { mcpServers: { svc: { ...limited(1), url: "https://moved.example.com/mcp" } } });
    await vi.advanceTimersByTimeAsync(0);

    expect(waiting.outcome()).toBe("called");
    expect(clients.map((client) => client.calls.length)).toEqual([1, 1]);
  });

  it("holds a waiting call to the replacement's limit when the connection it moves to has no slot left", async () => {
    const moved = { ...limited(1), url: "https://moved.example.com/mcp" };
    configs.set("/home/u/b.json", { mcpServers: { svc: moved } });
    const instance = await open();
    await call(await open("/home/u/b.json"));
    await call(instance);
    const waiting = await call(instance);

    await reload(instance, "/home/u/a.json", { mcpServers: { svc: moved } });
    await vi.advanceTimersByTimeAsync(0);

    expect(waiting.outcome()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    expect(waiting.outcome()).toBe("called");
  });

  it("applies a changed limit in place, then lets a waiting call run when a reload lifts it", async () => {
    const instance = await open();
    await call(instance);
    const waiting = await call(instance);

    await reload(instance, "/home/u/a.json", { mcpServers: { svc: limited(3) } });
    await vi.advanceTimersByTimeAsync(0);
    expect(waiting.outcome()).toBe("called");
    const third = await call(instance);
    expect(third.outcome()).toBe("called");
    const fourth = await call(instance);
    expect(fourth.outcome()).toBeUndefined();

    await reload(instance, "/home/u/a.json", { mcpServers: { svc: { url: "https://svc.example.com/mcp", _bridge: { rateLimit: false } } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(fourth.outcome()).toBe("called");
    expect((await call(instance)).outcome()).toBe("called");
  });

  it("keeps holding a waiting call to the limit when a reload moves it to a budget another config already uses", async () => {
    configs.set("/home/u/b.json", { mcpServers: { svc: limited(2) } });
    const instance = await open();
    const other = await open("/home/u/b.json");
    await call(instance);
    const waiting = await call(instance);
    await call(other);
    await call(other);

    await reload(instance, "/home/u/a.json", { mcpServers: { svc: limited(2) } });
    await vi.advanceTimersByTimeAsync(0);

    expect(waiting.outcome()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    expect(waiting.outcome()).toBe("called");
  });

  describe("while a call waits for its server to reconnect after its slot", () => {
    async function waitingForReconnect(instance: Instance) {
      await call(instance);
      const waiting = await call(instance);
      clients[0]!.attempt = () => new Promise(() => {});
      clients[0]!.setStatus("disconnected", new Error("reset"));
      await vi.advanceTimersByTimeAsync(WINDOW_MS);
      expect(waiting.outcome()).toBeUndefined();
      return waiting;
    }

    it("refuses it at once as removed when a reload removes the server", async () => {
      const instance = await open();
      const waiting = await waitingForReconnect(instance);

      await reload(instance, "/home/u/a.json", { mcpServers: {} });
      await vi.advanceTimersByTimeAsync(0);

      expect(waiting.outcome()).toEqual(new CallRefusedError('Upstream server "svc" was removed from the configuration'));
    });

    it("calls the replacement when a reload replaces the server", async () => {
      const instance = await open();
      const waiting = await waitingForReconnect(instance);

      await reload(instance, "/home/u/a.json", { mcpServers: { svc: { ...limited(1), url: "https://moved.example.com/mcp" } } });
      await vi.advanceTimersByTimeAsync(0);

      expect(waiting.outcome()).toBe("called");
      expect(clients[1]!.calls).toHaveLength(1);
    });

    it.each([
      ["disables its tool", { toolPolicy: "never" }, "Tool svc__op is disabled by policy"],
      ["makes its tool need approval", { toolPolicy: "prompt" }, "Tool svc__op now requires confirmation after a configuration change; please retry"],
    ])("refuses it when a reload %s meanwhile", async (_case, policy, message) => {
      const instance = await open();
      const waiting = await waitingForReconnect(instance);

      await reload(instance, "/home/u/a.json", { mcpServers: { svc: limited(1, policy) } });
      clients[0]!.setStatus("connected");
      await vi.advanceTimersByTimeAsync(0);

      expect(waiting.outcome()).toEqual(new CallRefusedError(message));
      expect(clients[0]!.calls).toHaveLength(1);
    });
  });

  it("waits for a server that dropped while the call waited for its slot, then calls it", async () => {
    const instance = await open();
    await call(instance);
    const waiting = await call(instance);
    clients[0]!.attempt = () => new Promise(() => {});
    clients[0]!.setStatus("disconnected", new Error("reset"));

    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    expect(waiting.outcome()).toBeUndefined();
    clients[0]!.setStatus("connected");
    await vi.advanceTimersByTimeAsync(0);

    expect(waiting.outcome()).toBe("called");
  });

  it.each([
    ["doesn't come back", "disconnected", 'Upstream server "svc" is unavailable; reconnecting in the background. Please retry shortly.'],
    ["needs authorization", "auth_required", 'Upstream server "svc" needs re-authorization. Run: crabeye-mcp-bridge auth svc (or update its configured credentials if it does not use OAuth).'],
  ] as const)("refuses a call whose server %s after its slot", async (_case, status, message) => {
    const instance = await open();
    const client = clients[0]!;
    client.attempt = status === "auth_required" ? async () => client.setStatus(status) : () => new Promise(() => {});
    client.setStatus(status, new Error("down"));

    const refused = await call(instance);
    await vi.advanceTimersByTimeAsync(WAIT_FOR_RESPAWN_MS);

    expect(refused.outcome()).toEqual(new CallRefusedError(message));
  });

  it("refuses a waiting call whose tool a reload disabled", async () => {
    const instance = await open();
    await call(instance);
    const waiting = await call(instance);

    await reload(instance, "/home/u/a.json", { mcpServers: { svc: limited(1, { toolPolicy: "never" }) } });
    await vi.advanceTimersByTimeAsync(WINDOW_MS);

    expect(waiting.outcome()).toEqual(new CallRefusedError("Tool svc__op is disabled by policy"));
    expect(clients[0]!.calls).toHaveLength(1);
  });

  it("refuses a call whose tool now needs approval unless the client approved it", async () => {
    configs.set("/home/u/a.json", { mcpServers: { svc: limited(10, { toolPolicy: "prompt" }) } });
    const instance = await open();

    const unapproved = await call(instance);
    const approved = await call(instance, { approved: true });

    expect(unapproved.outcome()).toEqual(new CallRefusedError("Tool svc__op now requires confirmation after a configuration change; please retry"));
    expect(approved.outcome()).toBe("called");
  });

  it("gives up a cancelled call's place without refusing it, and the next waiting call gets the slot", async () => {
    const instance = await open();
    await call(instance);
    const cancel = new AbortController();
    const cancelled = await call(instance, { signal: cancel.signal });
    const next = await call(instance);

    cancel.abort(new Error("Request cancelled"));
    await vi.advanceTimersByTimeAsync(WINDOW_MS);

    expect(cancelled.outcome()).toEqual(new Error("Rate limit wait cancelled"));
    expect(next.outcome()).toBe("called");
    expect(clients[0]!.calls).toHaveLength(2);
  });

  it("tells the bridges of the configs following a default limit once, at info, when it first makes a call wait", async () => {
    configs.set("/home/u/a.json", { mcpServers: { svc: { url: "https://svc.example.com/mcp" } }, _bridge: { defaultRateLimit: { maxCalls: 1, windowSeconds: 30 } } });
    configs.set("/home/u/b.json", { mcpServers: { svc: limited(1) } });
    const [instance, other] = [await open(), await open("/home/u/b.json")];
    const notifications: InstanceNotification[] = [];
    const elsewhere: InstanceNotification[] = [];
    instance.attach({ send: (notification) => notifications.push(notification) });
    other.attach({ send: (notification) => elsewhere.push(notification) });

    for (let i = 0; i < 4; i++) await call(instance);

    expect(elsewhere.filter(({ method }) => method === "LOG")).toEqual([]);
    expect(log.info).toHaveBeenCalledWith(
      'default rate limit (1 calls / 30s) reached for "svc"; tune with _bridge.rateLimit or set _bridge.defaultRateLimit: false to opt out',
      { server: "svc" },
    );
    expect(notifications.filter(({ method }) => method === "LOG").map(({ params }) => params)).toEqual([
      {
        upstream: "svc",
        level: "info",
        message: 'default rate limit (1 calls / 30s) reached for "svc"; tune with _bridge.rateLimit or set _bridge.defaultRateLimit: false to opt out',
      },
    ]);
  });
});

describe("Taking a slot for a hosted name", () => {
  it("refuses the call as removed when the name still has the lease that was released, instead of looping", async () => {
    let asked = 0;
    const released = {
      takeSlot: async () => {
        if (++asked > 1) throw new Error("asked the released lease again");
        return "released";
      },
    } as unknown as Lease;

    await expect(takeSlotFor("svc", () => released, new AbortController().signal)).rejects.toEqual(
      new CallRefusedError('Upstream server "svc" was removed from the configuration'),
    );
  });
});
