import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StdioServerConfigSchema } from "../../../src/config/schema.js";
import type { CredentialStore } from "../../../src/credentials/credential-store.js";
import type { StdioUpstreamClientOptions } from "../../../src/daemon/instances/stdio-upstream-client.js";
import { UpstreamPool, type PoolSpec } from "../../../src/daemon/instances/upstream-pool.js";
import { ScriptedStdioClient, stdioPoolOptions } from "../../_helpers/scripted-upstream-client.js";
import { spyLogger, type SpyLogger } from "../../_helpers/spy-logger.js";
import { ConnectionSupersededError } from "../../../src/upstream/types.js";

const GRACE_MS = 1_000;

function stdioSpec(name = "svc", key = "k1"): PoolSpec {
  return {
    kind: "stdio",
    key,
    name,
    healthCheckIntervalSec: 0,
    stdio: { config: StdioServerConfigSchema.parse({ command: "node" }), childEnv: {}, credentialStore: {} as CredentialStore, reconnect: {} },
  };
}

describe("UpstreamPool with STDIO servers", () => {
  let created: ScriptedStdioClient[];
  let createdWith: StdioUpstreamClientOptions[];
  let empties: number;
  let log: SpyLogger;
  let pool: UpstreamPool;

  beforeEach(() => {
    vi.useFakeTimers();
    created = [];
    createdWith = [];
    empties = 0;
    const stdio = stdioPoolOptions({
      graceMs: GRACE_MS,
      createClient: (options) => {
        const client = new ScriptedStdioClient(options.name);
        created.push(client);
        createdWith.push(options);
        return client;
      },
    });
    log = spyLogger();
    pool = new UpstreamPool({ logger: log, stdio, onEmpty: () => empties++ });
  });

  afterEach(async () => {
    await pool.close(0);
    vi.useRealTimers();
  });

  it("starts one server for all owners and names with the same key, counting each instance once", () => {
    const [one, other] = [{}, {}];
    const first = pool.acquire(stdioSpec("a"), one);
    const second = pool.acquire(stdioSpec("b"), one);
    pool.acquire(stdioSpec("c"), other);

    expect(created).toHaveLength(1);
    expect(second.upstream).toBe(first.upstream);
    expect(pool.children()).toEqual([{ pid: 4242, key: "k1", serverName: "a", era: "legacy", startedAt: 1, instances: 2 }]);
  });

  it("keeps a released server for graceMs, then stops it as idle and reports the pool empty", async () => {
    pool.acquire(stdioSpec()).release();

    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    expect(created[0]!.stops).toEqual([]);
    expect(pool.isEmpty).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(created[0]!.stops).toEqual(["idle"]);
    expect(pool.isEmpty).toBe(true);
    expect(empties).toBe(1);
  });

  it("stops a released server at once when it goes away during graceMs, instead of starting it again for nobody", async () => {
    pool.acquire(stdioSpec()).release();

    created[0]!.setStatus("disconnected", new Error("exited"));
    await vi.advanceTimersByTimeAsync(0);

    expect(created[0]!.stops).toEqual(["idle"]);
    expect(pool.isEmpty).toBe(true);
  });

  it("stops a released server at once when it is already down", async () => {
    const lease = pool.acquire(stdioSpec());
    created[0]!.setStatus("disconnected", new Error("can't start"));

    lease.release();
    await vi.advanceTimersByTimeAsync(0);

    expect(created[0]!.stops).toEqual(["idle"]);
  });

  it("reuses a released server acquired again within graceMs, and keeps it past the old deadline", async () => {
    pool.acquire(stdioSpec("old")).release();
    await vi.advanceTimersByTimeAsync(GRACE_MS / 2);
    pool.acquire(stdioSpec("new"));

    await vi.advanceTimersByTimeAsync(GRACE_MS);

    expect(created).toHaveLength(1);
    expect(created[0]!.stops).toEqual([]);
  });

  it("starts a server found to be legacy as one the next time its key is acquired, and no other key", async () => {
    pool.acquire(stdioSpec("a", "k1")).release();
    createdWith[0]!.onLegacy!();
    await vi.advanceTimersByTimeAsync(GRACE_MS);

    pool.acquire(stdioSpec("a", "k1"));
    pool.acquire(stdioSpec("b", "k2"));

    expect(createdWith.map((options) => options.knownLegacy)).toEqual([false, true, false]);
  });

  it("starts a new server for a key acquired again after its grace ran out", async () => {
    pool.acquire(stdioSpec()).release();
    await vi.advanceTimersByTimeAsync(GRACE_MS);

    pool.acquire(stdioSpec());

    expect(created).toHaveLength(2);
  });

  it("restarts the server with a key, and nothing for an unknown one", () => {
    pool.acquire(stdioSpec());

    expect(pool.restart("k1")).toBe(1);
    expect(pool.restart("other")).toBe(0);
    expect(created[0]!.restarts).toEqual(["restart"]);
  });

  it.each([
    ["fails", new Error("spawn node ENOENT"), 1],
    ["is replaced by a later connect", new ConnectionSupersededError("svc"), 0],
  ])("logs a restart whose connect %s, and only then, without leaving it unhandled", async (_case, failure, warnings) => {
    pool.acquire(stdioSpec());
    created[0]!.restart = () => Promise.reject(failure);

    pool.restart("k1");
    await vi.advanceTimersByTimeAsync(0);

    expect(log.warn.mock.calls.filter(([message]) => String(message).startsWith("failed to connect"))).toHaveLength(warnings);
  });

  it("restarts a server whose health checks fail, saying it stopped answering, instead of connecting again", async () => {
    pool.acquire({ ...stdioSpec(), healthCheckIntervalSec: 1 });
    created[0]!.setStatus("connected");
    created[0]!.ping = () => Promise.reject(new Error("no answer"));

    await vi.advanceTimersByTimeAsync(3_100);

    expect(created[0]!.restarts).toEqual(["not answering pings"]);
    expect(created[0]!.reconnects).toBe(0);
  });

  it("names a shared server after the next owner once the first one lets it go", () => {
    const first = pool.acquire(stdioSpec("a"));
    pool.acquire(stdioSpec("b"));

    first.release();

    expect(pool.children()[0]!.serverName).toBe("b");
  });

  it("leaves STDIO servers alone when an upstream's stored credentials change", async () => {
    pool.acquire(stdioSpec());

    expect(await pool.credentialsChanged("svc")).toBe(0);
    expect(created[0]!.reconnects).toBe(0);
  });

  it("stops every server on close as a shutdown, including one waiting out its grace", async () => {
    pool.acquire(stdioSpec("a", "k1"));
    pool.acquire(stdioSpec("b", "k2")).release();

    await pool.close(0);

    expect(created.map((client) => client.stops)).toEqual([["shutdown"], ["shutdown"]]);
  });
});
