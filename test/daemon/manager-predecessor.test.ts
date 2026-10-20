import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:net";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ManagerDaemon, LockBusyError, DaemonAlreadyRunningError, type ManagerOptions } from "../../src/daemon/manager.js";
import { DaemonClient } from "../../src/daemon/client.js";
import { netTransport } from "../../src/daemon/net-transport.js";
import type { StatusResult } from "../../src/daemon/protocol.js";
import { isForeignProcess } from "../../src/daemon/daemon-identity.js";
import { closeServer } from "../_helpers/frame-server.js";

vi.mock("../../src/daemon/daemon-identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/daemon/daemon-identity.js")>();
  return { ...actual, isForeignProcess: vi.fn(actual.isForeignProcess) };
});

const isWindows = process.platform === "win32";

describe.skipIf(isWindows)("ManagerDaemon waiting for the daemon it replaces", () => {
  let dir: string;
  let paths: { socketPath: string; pidPath: string; lockPath: string };
  let waitingReports: number;
  const managers: ManagerDaemon[] = [];
  const processes: ChildProcess[] = [];
  const squatters: Server[] = [];

  beforeEach(async () => {
    dir = await mkdtemp("/tmp/cbe-pred-");
    paths = { socketPath: join(dir, "m.sock"), pidPath: join(dir, "m.pid"), lockPath: join(dir, "m.lock") };
    waitingReports = 0;
  });

  afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.stop(0).catch(() => {});
    for (const child of processes.splice(0)) child.kill("SIGKILL");
    for (const squatter of squatters.splice(0)) await closeServer(squatter);
    await rm(dir, { recursive: true, force: true });
  });

  function manager(opts: Pick<ManagerOptions, "awaitPredecessorMs" | "pid"> = {}): ManagerDaemon {
    const created = new ManagerDaemon({
      ...paths,
      processTrackerPath: join(dir, "processes.json"),
      idleMs: 60_000,
      transport: netTransport,
      onWaitingForPredecessor: () => waitingReports++,
      ...opts,
    });
    managers.push(created);
    return created;
  }

  function daemonLikeProcess(): ChildProcess {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "daemon", "--internal-launch"]);
    processes.push(child);
    return child;
  }

  async function squatSocket(): Promise<Server> {
    const squatter = createServer((socket) => socket.end());
    squatters.push(squatter);
    await new Promise<void>((resolve) => squatter.listen(paths.socketPath, () => resolve()));
    return squatter;
  }

  async function servingPid(): Promise<number> {
    const client = new DaemonClient({ socketPath: paths.socketPath, transport: netTransport, rpcTimeoutMs: 1_000 });
    try {
      return ((await client.call("STATUS")) as StatusResult).pid;
    } finally {
      client.close();
    }
  }

  it("starts as soon as the daemon holding the lock and socket stops, reporting once that it is waiting", async () => {
    const predecessorPid = daemonLikeProcess().pid!;
    const predecessor = manager({ pid: predecessorPid });
    await predecessor.start();
    let started = false;

    const starting = manager({ awaitPredecessorMs: 10_000 }).start().then(() => (started = true));
    await delay(300);
    expect(started).toBe(false);
    expect(await servingPid()).toBe(predecessorPid);

    await predecessor.stop(0);
    const stoppedAt = Date.now();
    await starting;

    expect(Date.now() - stoppedAt).toBeLessThan(500);
    expect(await servingPid()).toBe(process.pid);
    expect(waitingReports).toBe(1);
  });

  it("does not report waiting when nothing is in its way", async () => {
    await manager({ awaitPredecessorMs: 10_000 }).start();

    expect(waitingReports).toBe(0);
  });

  it("checks who holds the lock about once a second while it waits, not on every poll", async () => {
    const predecessor = manager({ pid: daemonLikeProcess().pid! });
    await predecessor.start();
    vi.mocked(isForeignProcess).mockClear();

    const starting = manager({ awaitPredecessorMs: 10_000 }).start();
    await delay(3_800);
    const identityChecks = vi.mocked(isForeignProcess).mock.calls.length;
    await predecessor.stop(0);
    await starting;

    expect(identityChecks).toBeGreaterThanOrEqual(3);
    expect(identityChecks).toBeLessThanOrEqual(5);
    expect(await servingPid()).toBe(process.pid);
    expect(waitingReports).toBe(1);
  });

  it("fails at once on a start error that has nothing to do with another daemon, without reporting waiting", async () => {
    const blocked = join(dir, "not-a-dir");
    await writeFile(blocked, "");
    const successor = new ManagerDaemon({
      socketPath: join(blocked, "m.sock"),
      pidPath: join(blocked, "m.pid"),
      lockPath: join(blocked, "m.lock"),
      processTrackerPath: join(dir, "processes.json"),
      idleMs: 60_000,
      transport: netTransport,
      awaitPredecessorMs: 60_000,
      onWaitingForPredecessor: () => waitingReports++,
    });
    const startedAt = Date.now();

    await expect(successor.start()).rejects.toMatchObject({ code: expect.stringMatching(/^(EEXIST|ENOTDIR)$/) });

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(waitingReports).toBe(0);
  });

  it("starts within moments of a predecessor that dies without releasing the lock", async () => {
    const holder = daemonLikeProcess();
    await writeFile(paths.lockPath, `${holder.pid}\n${randomUUID()}\n`);
    const starting = manager({ awaitPredecessorMs: 10_000 }).start();
    await delay(300);

    holder.kill("SIGKILL");
    await new Promise((r) => holder.once("exit", r));
    const diedAt = Date.now();
    await starting;

    expect(Date.now() - diedAt).toBeLessThan(500);
    expect(await servingPid()).toBe(process.pid);
  });

  it("starts once a daemon that holds only the socket stops serving it", async () => {
    const squatter = await squatSocket();
    let started = false;

    const starting = manager({ awaitPredecessorMs: 10_000 }).start().then(() => (started = true));
    await delay(300);
    expect(started).toBe(false);

    await closeServer(squatter);
    await starting;

    expect(await servingPid()).toBe(process.pid);
  });

  it("retries a daemon that holds only the socket at the poll interval, not in a tight loop", async () => {
    const squatter = await squatSocket();
    let probes = 0;
    squatter.on("connection", () => probes++);

    const starting = manager({ awaitPredecessorMs: 10_000 }).start();
    await delay(500);
    const probesWhileWaiting = probes;
    await closeServer(squatter);
    await starting;

    expect(probesWhileWaiting).toBeGreaterThanOrEqual(5);
    expect(probesWhileWaiting).toBeLessThanOrEqual(25);
  });

  it("gives up when the predecessor is still there after the wait, without overrunning it", async () => {
    await manager({ pid: daemonLikeProcess().pid! }).start();
    const startedAt = Date.now();

    await expect(manager({ awaitPredecessorMs: 300 }).start()).rejects.toBeInstanceOf(LockBusyError);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(300);
    expect(Date.now() - startedAt).toBeLessThan(800);
  });

  it("does not wait without awaitPredecessorMs", async () => {
    await squatSocket();

    await expect(manager().start()).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
  });
});
