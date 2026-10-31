import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpServerConfigSchema } from "../../../src/config/schema.js";
import type { CredentialStore } from "../../../src/credentials/credential-store.js";
import type { Logger } from "../../../src/logging/index.js";
import { networkSettings } from "../../../src/daemon/instance-env.js";
import type { CreateHttpClient } from "../../../src/daemon/instances/http-connection.js";
import { PooledUpstream, type PooledUpstreamListener } from "../../../src/daemon/instances/pooled-upstream.js";
import { STOP_SAVE_WAIT_MS, UpstreamPool, type PoolSpec } from "../../../src/daemon/instances/upstream-pool.js";
import { ConnectionSupersededError } from "../../../src/upstream/types.js";
import { settledWithin } from "../../_helpers/processes.js";
import { ScriptedUpstreamClient, stdioPoolOptions, tool } from "../../_helpers/scripted-upstream-client.js";
import { spyLogger, type SpyLogger } from "../../_helpers/spy-logger.js";

const store = {} as CredentialStore;

interface SpecOverrides {
  key?: string;
  name?: string;
  healthCheckIntervalSec?: number;
  env?: Record<string, string>;
}

function spec(overrides: SpecOverrides = {}): PoolSpec {
  const name = overrides.name ?? "svc";
  return {
    kind: "http",
    key: overrides.key ?? "k1",
    name,
    healthCheckIntervalSec: overrides.healthCheckIntervalSec ?? 0,
    http: {
      config: HttpServerConfigSchema.parse({ url: "https://mcp.example.com/mcp" }),
      credentialStore: store,
      reconnect: {},
      network: networkSettings({}),
      env: overrides.env ?? {},
    },
  };
}


function listener(): PooledUpstreamListener & { snapshots: unknown[]; logs: unknown[] } {
  const snapshots: unknown[] = [];
  const logs: unknown[] = [];
  return {
    snapshots,
    logs,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onLog: (level, message, context) => logs.push({ level, message, context }),
  };
}

describe("UpstreamPool with HTTP connections", () => {
  let daemonLog: SpyLogger;
  let created: ScriptedUpstreamClient[];
  let clientLoggers: Logger[];
  let clientDeps: Array<Parameters<CreateHttpClient>[2]>;
  let pool: UpstreamPool;

  beforeEach(() => {
    daemonLog = spyLogger();
    created = [];
    clientLoggers = [];
    clientDeps = [];
    pool = new UpstreamPool({
      logger: daemonLog,
      stdio: stdioPoolOptions(),
      createHttpClient: (name, _config, deps) => {
        const client = new ScriptedUpstreamClient(name);
        created.push(client);
        clientLoggers.push(deps.logger);
        clientDeps.push(deps);
        return client;
      },
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await pool.close(0);
  });

  it("shares one connection between leases with the same key and closes it with the last one", async () => {
    const first = pool.acquire(spec());
    const second = pool.acquire(spec());

    expect(created).toHaveLength(1);
    expect(second.upstream).toBe(first.upstream);
    expect(pool.upstreams()[0]!.ownerCount).toBe(2);
    first.release();
    first.release();
    expect(created[0]!.closed).toBe(false);
    expect(pool.upstreams()).toHaveLength(1);
    second.release();
    await vi.waitFor(() => expect(created[0]!.closed).toBe(true));
    expect(pool.upstreams()).toEqual([]);
  });

  it("opens a new connection for a key acquired again after its last release", () => {
    pool.acquire(spec()).release();
    pool.acquire(spec());
    expect(created).toHaveLength(2);
  });

  it("keeps connections with different keys apart", () => {
    pool.acquire(spec());
    pool.acquire(spec({ key: "k2" }));
    expect(created).toHaveLength(2);
  });

  it("connects at once and reports each change of state, with the last error while it isn't connected", async () => {
    const lease = pool.acquire(spec());
    const client = created[0]!;
    expect(client.connects).toBe(1);
    const watcher = listener();
    lease.upstream.subscribe(watcher);
    let finish!: () => void;
    client.attempt = () => new Promise<void>((resolve) => (finish = resolve)).then(() => client.setStatus("connected"));

    client.setStatus("disconnected", new Error("boom"));
    const retried = lease.upstream.retry();
    client.instructions = "use it well";
    client.tools = [tool("search")];
    finish();

    expect(await retried).toEqual({ name: "svc", status: "connected", tools: [tool("search")], instructions: "use it well" });
    expect(watcher.snapshots).toEqual([
      { name: "svc", status: "disconnected", error: "boom", tools: [] },
      { name: "svc", status: "connecting", error: "boom", tools: [] },
      { name: "svc", status: "connected", tools: [tool("search")], instructions: "use it well" },
    ]);
  });

  it("reports a changed tool list, and nothing when a list arrives unchanged or a change repeats the last report", async () => {
    const lease = pool.acquire(spec());
    const client = created[0]!;
    client.setTools([tool("search")]);
    const watcher = listener();
    lease.upstream.subscribe(watcher);

    client.setTools([tool("search")]);
    client.setTools([tool("search"), tool("fetch")]);
    client.setTools([tool("search"), tool("fetch")]);

    expect(watcher.snapshots).toEqual([{ name: "svc", status: "connected", tools: [tool("search"), tool("fetch")] }]);
  });

  it("sends no tool list while it isn't connected", () => {
    const lease = pool.acquire(spec());
    created[0]!.setTools([tool("search")]);
    created[0]!.setStatus("disconnected");
    expect(lease.upstream.snapshot().tools).toEqual([]);
  });

  it("doesn't report instructions while not connected", () => {
    const lease = pool.acquire(spec());
    created[0]!.instructions = "stale";
    created[0]!.setStatus("disconnected");
    expect(lease.upstream.snapshot()).not.toHaveProperty("instructions");
  });

  it("passes the connection's warnings and errors to listeners, without the server name, and logs everything in the daemon log", () => {
    const lease = pool.acquire(spec());
    const watcher = listener();
    lease.upstream.subscribe(watcher);
    const log = clientLoggers[0]!.child({ component: "oauth" });

    log.info("connected");
    log.debug("details");
    log.warn("refresh failed", { server: "svc", status: 500, retrying: true, details: { nested: 1 } });
    log.error("gave up");

    expect(watcher.logs).toEqual([
      { level: "warn", message: "refresh failed", context: { component: "oauth", status: 500, retrying: true } },
      { level: "error", message: "gave up", context: { component: "oauth" } },
    ]);
    expect(daemonLog.info).toHaveBeenCalledWith("connected", undefined);
    expect(daemonLog.warn).toHaveBeenCalledWith("refresh failed", expect.objectContaining({ status: 500 }));
  });

  it("caps long forwarded messages", () => {
    const lease = pool.acquire(spec());
    const watcher = listener();
    lease.upstream.subscribe(watcher);
    clientLoggers[0]!.warn("x".repeat(5_000), { error: "y".repeat(5_000) });
    const [{ message, context }] = watcher.logs as Array<{ message: string; context: { error: string } }>;
    expect(message.length).toBeLessThan(1_100);
    expect(context.error.length).toBeLessThan(1_100);
  });

  it("doesn't log a first connect that a reconnect or close replaced as failing", async () => {
    pool = new UpstreamPool({
      logger: daemonLog,
      stdio: stdioPoolOptions(),
      createHttpClient: (name) => {
        const client = new ScriptedUpstreamClient(name);
        client.attempt = () => Promise.reject(new ConnectionSupersededError(name));
        created.push(client);
        return client;
      },
    });

    pool.acquire(spec());
    await vi.waitFor(() => expect(created[0]!.status).toBe("disconnected"));
    await new Promise((resolve) => setImmediate(resolve));

    expect(daemonLog.warn.mock.calls.filter(([message]) => String(message).startsWith("failed to connect"))).toEqual([]);
  });

  it("keeps its own connect failures and authorization pauses in the daemon log, since each bridge logs them itself", async () => {
    pool = new UpstreamPool({
      logger: daemonLog,
      stdio: stdioPoolOptions(),
      createHttpClient: (name) => {
        const client = new ScriptedUpstreamClient(name);
        client.attempt = () => Promise.reject(new Error("refused"));
        created.push(client);
        return client;
      },
    });
    const lease = pool.acquire(spec());
    const watcher = listener();
    lease.upstream.subscribe(watcher);

    await vi.waitFor(() => expect(daemonLog.warn).toHaveBeenCalledWith("failed to connect: refused"));
    created[0]!.setStatus("auth_required", new Error("needs auth"));

    expect(daemonLog.warn).toHaveBeenCalledWith("authorization required; paused until the next call or reload: needs auth");
    expect(watcher.logs).toEqual([]);
    expect(lease.upstream.snapshot()).toMatchObject({ status: "auth_required", error: "needs auth" });
  });

  it("logs a pause for authorization once until the connection connects again", async () => {
    const lease = pool.acquire(spec());
    const client = created[0]!;
    const pauses = () => daemonLog.warn.mock.calls.filter(([message]) => String(message).startsWith("authorization required")).length;

    client.setStatus("auth_required", new Error("needs auth"));
    client.setStatus("connecting");
    client.setStatus("auth_required", new Error("still needs auth"));
    expect(pauses()).toBe(1);

    client.setStatus("connected");
    client.setStatus("auth_required", new Error("needs auth again"));
    expect(pauses()).toBe(2);
    lease.release();
  });

  it("health-checks each connection once, with the owner's interval, and reports failed pings", async () => {
    vi.useFakeTimers();
    const lease = pool.acquire(spec({ healthCheckIntervalSec: 1 }));
    pool.acquire(spec({ healthCheckIntervalSec: 5 }));
    const client = created[0]!;
    const ping = vi.spyOn(client, "ping").mockRejectedValue(new Error("timeout"));
    const watcher = listener();
    lease.upstream.subscribe(watcher);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(ping).toHaveBeenCalledTimes(1);
    expect(watcher.logs).toEqual([
      { level: "warn", message: "ping failed", context: { component: "health", error: "timeout", failures: 1 } },
    ]);
  });

  it("hands the health-check interval to the next owner when the first one leaves", async () => {
    vi.useFakeTimers();
    const first = pool.acquire(spec({ healthCheckIntervalSec: 0 }));
    const second = pool.acquire(spec({ healthCheckIntervalSec: 1 }));
    const ping = vi.spyOn(created[0]!, "ping");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ping).not.toHaveBeenCalled();

    first.release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ping).toHaveBeenCalledTimes(1);
    second.setHealthCheckInterval(0);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it("applies an interval set through a later owner's lease only once that owner is the longest-standing one", async () => {
    vi.useFakeTimers();
    const first = pool.acquire(spec({ healthCheckIntervalSec: 0 }));
    const later = pool.acquire(spec({ healthCheckIntervalSec: 0 }));
    const ping = vi.spyOn(created[0]!, "ping");

    later.setHealthCheckInterval(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ping).not.toHaveBeenCalled();
    first.release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it("applies an interval the longest-standing owner sets at once", async () => {
    vi.useFakeTimers();
    const first = pool.acquire(spec({ healthCheckIntervalSec: 0 }));
    pool.acquire(spec({ healthCheckIntervalSec: 0 }));
    const ping = vi.spyOn(created[0]!, "ping");

    first.setHealthCheckInterval(1);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(ping).toHaveBeenCalledTimes(1);
  });

  it("gives every connection the same shared refreshes and the environment of the instance that opened it", () => {
    pool.acquire(spec({ env: { NOTION_OAUTH_SECRET: "a" } }));
    pool.acquire(spec({ key: "k2", name: "other", env: { NOTION_OAUTH_SECRET: "b" } }));

    expect(clientDeps.map((deps) => deps.env)).toEqual([{ NOTION_OAUTH_SECRET: "a" }, { NOTION_OAUTH_SECRET: "b" }]);
    expect(clientDeps[0]!.refreshes).toBeDefined();
    expect(clientDeps[1]!.refreshes).toBe(clientDeps[0]!.refreshes);
  });

  it("connects every connection to the named upstream again, connected or not, telling each it was replaced, and nothing else", async () => {
    pool.acquire(spec());
    pool.acquire(spec({ key: "k2" }));
    pool.acquire(spec({ key: "k3", name: "other" }));
    await vi.waitFor(() => expect(created.map((c) => c.status)).toEqual(["connected", "connected", "connected"]));
    created[1]!.setStatus("auth_required");
    let finish!: () => void;
    created[0]!.attempt = () => new Promise<void>((resolve) => (finish = resolve)).then(() => created[0]!.setStatus("connected"));

    let settled = false;
    const reconnecting = pool.credentialsChanged("svc").then((count) => {
      settled = true;
      return count;
    });
    await vi.waitFor(() => expect(created[1]!.status).toBe("connected"));
    expect(settled).toBe(false);
    finish();

    expect(await reconnecting).toBe(2);
    expect(created.map((c) => c.reconnects)).toEqual([1, 1, 0]);
    expect(created.map((c) => c.authRetirements)).toEqual([1, 1, 0]);
  });

  it("reconnects nothing, and says so, for a name it has no connection to", async () => {
    pool.acquire(spec());
    expect(await pool.credentialsChanged("missing")).toBe(0);
    expect(created[0]!.reconnects).toBe(0);
  });

  it("settles a reconnect whose attempt fails", async () => {
    pool.acquire(spec());
    created[0]!.attempt = () => Promise.reject(new Error("refused"));

    expect(await pool.credentialsChanged("svc")).toBe(1);
    expect(created[0]!.status).toBe("disconnected");
  });

  it("gives each connection its own count of refreshes whose tokens aren't saved yet", () => {
    pool.acquire(spec());
    pool.acquire(spec({ key: "k2" }));

    expect(clientDeps[0]!.pendingSaves).toBeDefined();
    expect(clientDeps[1]!.pendingSaves).not.toBe(clientDeps[0]!.pendingSaves);
  });

  it("closes a released connection's client at once, and finishes closing only once its refreshes saved their tokens", async () => {
    const lease = pool.acquire(spec());
    const settle = clientDeps[0]!.pendingSaves.track();
    lease.release();
    const closing = pool.close(10_000);

    await vi.waitFor(() => expect(created[0]!.closed).toBe(true));
    expect(await settledWithin(closing, 100)).toBe(false);
    expect(created[0]!.authRetirements).toBe(0);
    settle();

    await closing;
    expect(created[0]!.authRetirements).toBe(1);
  });

  it("keeps connections still closing from changing stored credentials when told those of their upstream changed, and only those", async () => {
    const [svc, other] = [pool.acquire(spec()), pool.acquire(spec({ key: "k2", name: "other" }))];
    const settles = [clientDeps[0]!.pendingSaves.track(), clientDeps[1]!.pendingSaves.track()];
    svc.release();
    other.release();

    expect(await pool.credentialsChanged("svc")).toBe(0);

    expect(created.map((c) => c.authRetirements)).toEqual([1, 0]);
    for (const settle of settles) settle();
  });

  it("stops waiting for refreshes to save after the time it was given when the manager stops", async () => {
    pool.acquire(spec());
    clientDeps[0]!.pendingSaves.track();
    const startedAt = Date.now();

    await pool.close(200);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(190);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("lets a connection a reload or idle close is closing wait longer than a stopping manager would for its refreshes to save", async () => {
    vi.useFakeTimers();
    const closing = vi.spyOn(PooledUpstream.prototype, "close");
    const lease = pool.acquire(spec());
    const settle = clientDeps[0]!.pendingSaves.track();
    lease.release();
    let closed = false;
    void (closing.mock.results[0]!.value as Promise<void>).then(() => (closed = true));

    await vi.advanceTimersByTimeAsync(STOP_SAVE_WAIT_MS + 1);
    expect(closed).toBe(false);
    settle();
    await vi.advanceTimersByTimeAsync(0);

    expect(closed).toBe(true);
  });

  it("caps the save wait of a connection a reload or idle close is already closing when the manager stops", async () => {
    const lease = pool.acquire(spec());
    clientDeps[0]!.pendingSaves.track();
    lease.release();

    expect(await settledWithin(pool.close(50), 1_000)).toBe(true);
  });

  it("waits no longer than a stopping manager may for refreshes to save, however long it was given", async () => {
    vi.useFakeTimers();
    pool.acquire(spec());
    clientDeps[0]!.pendingSaves.track();
    let closed = false;
    void pool.close(10_000).then(() => (closed = true));

    await vi.advanceTimersByTimeAsync(STOP_SAVE_WAIT_MS - 1);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(closed).toBe(true);
  });

  it("closes every connection on close", async () => {
    pool.acquire(spec());
    pool.acquire(spec({ key: "k2" }));
    await pool.close(0);
    expect(created.map((c) => c.closed)).toEqual([true, true]);
    expect(pool.upstreams()).toEqual([]);
  });
});
