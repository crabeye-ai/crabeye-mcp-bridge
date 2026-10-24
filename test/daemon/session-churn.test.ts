import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ManagerDaemon } from "../../src/daemon/manager.js";
import { DaemonClient } from "../../src/daemon/client.js";
import { netTransport } from "../../src/daemon/net-transport.js";
import type { ChildHandle } from "../../src/daemon/child-handle.js";
import type { StatusResult } from "../../src/daemon/protocol.js";
import { processExists } from "../../src/process/process-utils.js";
import { until } from "../_helpers/daemon-fixtures.js";

const isWindows = process.platform === "win32";
const UPSTREAMS = 4;
const GRACE_MS = 20;
const IDLE_CHILD_SCRIPT = "process.stdin.resume(); setInterval(() => {}, 1000)";

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function specFor(upstream: number, realChild: boolean) {
  return {
    serverName: `srv-${upstream}`,
    command: process.execPath,
    args: realChild ? ["-e", IDLE_CHILD_SCRIPT, String(upstream)] : [`fake-${upstream}`],
    resolvedEnv: {},
    cwd: "",
    clientInfo: { name: "churn", version: "0" },
    clientCapabilities: {},
    protocolVersion: "2025-11-25",
  };
}

interface ChurnOptions {
  realChild: boolean;
  rounds: number;
  connectionsPerRound: number;
  expireEveryOtherRound: boolean;
  random: () => number;
}

describe.skipIf(isWindows)("daemon session churn", { timeout: 60_000 }, () => {
  let dir: string;
  let manager: ManagerDaemon | undefined;
  const clients = new Set<DaemonClient>();

  afterEach(async () => {
    for (const client of clients) client.close();
    clients.clear();
    await manager?.stop(0).catch(() => {});
    manager = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  async function startManager(realChild: boolean) {
    dir = await mkdtemp("/tmp/cbe-churn-");
    const fakes = { spawned: 0, killed: 0 };
    manager = new ManagerDaemon({
      socketPath: join(dir, "m.sock"),
      pidPath: join(dir, "m.pid"),
      lockPath: join(dir, "m.lock"),
      processTrackerPath: join(dir, "processes.json"),
      idleMs: 60_000,
      graceMs: GRACE_MS,
      killGraceMs: 200,
      childPingMs: 0,
      transport: netTransport,
      ...(!realChild && {
        _spawnChild: (_spec: unknown, cb: { onMessage: (payload: unknown) => void }) => {
          fakes.spawned++;
          const handle = {
            startedAt: Date.now(),
            pid: 80_000 + fakes.spawned,
            alive: true,
            cachedInit: null as unknown,
            setCachedInit(init: unknown) { handle.cachedInit = init; },
            send(payload: unknown) {
              const message = payload as { id?: number; method?: string };
              if (message.method === "quick" && message.id !== undefined) {
                setTimeout(() => cb.onMessage({ jsonrpc: "2.0", id: message.id, result: {} }), 1);
              }
            },
            async kill() {
              handle.alive = false;
              fakes.killed++;
            },
          };
          return handle as unknown as ChildHandle;
        },
      }),
    });
    await manager.start();
    return fakes;
  }

  async function connection(): Promise<DaemonClient> {
    const client = new DaemonClient({ socketPath: join(dir, "m.sock"), transport: netTransport, rpcTimeoutMs: 5_000, connectTimeoutMs: 5_000 });
    clients.add(client);
    await client.connect();
    return client;
  }

  function closeConnection(client: DaemonClient): void {
    client.close();
    clients.delete(client);
  }

  async function status(): Promise<StatusResult> {
    const client = await connection();
    try {
      return (await client.call("STATUS")) as StatusResult;
    } finally {
      closeConnection(client);
    }
  }

  function requestsInFlight(): { requests: number; subscriptions: number }[] {
    const { groups } = manager as unknown as {
      groups: Map<string, { rewriter: { outerIdToOrigin: Map<number, unknown>; listenOuterIds: Set<number> } }>;
    };
    return [...groups.values()].map(({ rewriter }) => ({
      requests: rewriter.outerIdToOrigin.size,
      subscriptions: rewriter.listenOuterIds.size,
    }));
  }

  async function openSession(client: DaemonClient, upstream: number, realChild: boolean): Promise<string> {
    const sessionId = randomUUID();
    await client.call("OPEN", { sessionId, spec: specFor(upstream, realChild) });
    return sessionId;
  }

  async function churn({ realChild, rounds, connectionsPerRound, expireEveryOtherRound, random }: ChurnOptions): Promise<Set<number>> {
    const pids = new Set<number>();
    const roundClients: DaemonClient[] = [];
    for (let round = 0; round < rounds; round++) {
      await Promise.all(
        Array.from({ length: connectionsPerRound }, async () => {
          const client = await connection();
          roundClients.push(client);
          const sessions = await Promise.all(
            Array.from({ length: 1 + Math.floor(random() * 6) }, async () => {
              const sessionId = await openSession(client, Math.floor(random() * UPSTREAMS), realChild);
              const rpc = (payload: Record<string, unknown>) => client.sendNotification("RPC", { sessionId, payload: { jsonrpc: "2.0", ...payload } });
              for (let n = 0; n < 3; n++) rpc({ id: n, method: random() < 0.5 ? "quick" : "hang" });
              rpc({ id: "sub", method: "resources/subscribe", params: { uri: `file:///shared/${Math.floor(random() * 3)}` } });
              rpc({ id: "listen", method: "subscriptions/listen", params: {} });
              return sessionId;
            }),
          );
          for (const child of (await status()).children) if (child.pid > 0) pids.add(child.pid);
          for (const sessionId of sessions) {
            if (random() < 0.5) await client.call("CLOSE", { sessionId });
          }
          if (random() < 0.5) closeConnection(client);
        }),
      );
      if (expireEveryOtherRound && round % 2 === 1) {
        for (const client of roundClients.splice(0)) closeConnection(client);
        await until(async () => (await status()).children.length === 0, 10_000);
      }
    }
    for (const client of roundClients.splice(0)) closeConnection(client);
    return pids;
  }

  async function expectNothingLeft(): Promise<StatusResult> {
    await until(async () => {
      const now = await status();
      return now.sessions.length === 0 && now.children.length === 0;
    }, 10_000);
    const after = await status();
    expect(after.sessions).toEqual([]);
    expect(after.children).toEqual([]);
    expect(after.telemetry.sessions.total).toBe(0);
    expect(after.telemetry.sessions.closedTotal).toBe(after.telemetry.sessions.openedTotal);
    expect(after.telemetry.children.total).toBe(0);
    return after;
  }

  it("keeps exact session and subscription bookkeeping while many sessions attach, subscribe and detach at once", async () => {
    await startManager(false);
    const anchor = await connection();
    const anchors = await Promise.all(Array.from({ length: UPSTREAMS }, (_, upstream) => openSession(anchor, upstream, false)));

    await churn({ realChild: false, rounds: 6, connectionsPerRound: 12, expireEveryOtherRound: false, random: seededRandom(193) });

    await until(async () => (await status()).sessions.length === UPSTREAMS, 10_000);
    const settled = await status();
    expect(settled.sessions.map(({ sessionId }) => sessionId).sort()).toEqual([...anchors].sort());
    expect(settled.children.map(({ refcount, subscriptionCount }) => ({ refcount, subscriptionCount }))).toEqual(
      Array.from({ length: UPSTREAMS }, () => ({ refcount: 1, subscriptionCount: 0 })),
    );
    expect(requestsInFlight()).toEqual(Array.from({ length: UPSTREAMS }, () => ({ requests: 0, subscriptions: 0 })));
    expect(settled.telemetry.sessions.openedTotal).toBeGreaterThan(100);
    expect(settled.telemetry.children.spawnedTotal).toBe(UPSTREAMS);

    closeConnection(anchor);
    await expectNothingLeft();
  });

  it("leaves no sessions or children behind when children expire and respawn during churn", async () => {
    const fakes = await startManager(false);

    await churn({ realChild: false, rounds: 6, connectionsPerRound: 12, expireEveryOtherRound: true, random: seededRandom(42) });

    const after = await expectNothingLeft();
    expect(after.telemetry.children.spawnedTotal).toBeGreaterThan(UPSTREAMS);
    expect(fakes.killed).toBe(fakes.spawned);
  });

  it("leaves no child process running after churn with real children that expire and respawn", async () => {
    await startManager(true);

    const pids = await churn({ realChild: true, rounds: 4, connectionsPerRound: 6, expireEveryOtherRound: true, random: seededRandom(7) });

    const after = await expectNothingLeft();
    expect(after.telemetry.children.spawnedTotal).toBeGreaterThan(UPSTREAMS);
    expect(pids.size).toBe(after.telemetry.children.spawnedTotal);
    await until(() => [...pids].every((pid) => !processExists(pid)), 10_000);
  });
});
