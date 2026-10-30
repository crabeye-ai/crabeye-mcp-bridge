import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpServerConfigSchema } from "../../../src/config/schema.js";
import type { CredentialStore } from "../../../src/credentials/credential-store.js";
import type { Logger } from "../../../src/logging/index.js";
import { networkSettings } from "../../../src/daemon/instance-env.js";
import { HttpUpstreamPool, type PooledUpstreamListener, type PooledUpstreamSpec } from "../../../src/daemon/instances/http-upstream-pool.js";
import { ScriptedUpstreamClient, tool } from "../../_helpers/scripted-upstream-client.js";
import { spyLogger, type SpyLogger } from "../../_helpers/spy-logger.js";

const store = {} as CredentialStore;

function spec(overrides: Partial<PooledUpstreamSpec> = {}): PooledUpstreamSpec {
  return {
    key: "k1",
    name: "svc",
    config: HttpServerConfigSchema.parse({ url: "https://mcp.example.com/mcp" }),
    credentialStore: store,
    reconnect: {},
    healthCheckIntervalSec: 0,
    network: networkSettings({}),
    ...overrides,
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

describe("HttpUpstreamPool", () => {
  let daemonLog: SpyLogger;
  let created: ScriptedUpstreamClient[];
  let clientLoggers: Logger[];
  let pool: HttpUpstreamPool;

  beforeEach(() => {
    daemonLog = spyLogger();
    created = [];
    clientLoggers = [];
    pool = new HttpUpstreamPool({
      logger: daemonLog,
      createClient: (name, _config, deps) => {
        const client = new ScriptedUpstreamClient(name);
        created.push(client);
        clientLoggers.push(deps.logger);
        return client;
      },
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await pool.close();
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

  it("keeps its own connect failures and authorization pauses in the daemon log, since each bridge logs them itself", async () => {
    pool = new HttpUpstreamPool({
      logger: daemonLog,
      createClient: (name) => {
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

  it("closes every connection on close", async () => {
    pool.acquire(spec());
    pool.acquire(spec({ key: "k2" }));
    await pool.close();
    expect(created.map((c) => c.closed)).toEqual([true, true]);
    expect(pool.upstreams()).toEqual([]);
  });
});
