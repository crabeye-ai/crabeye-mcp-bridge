import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { lstat, mkdtemp, readFile, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDaemonRunning } from "../../src/daemon/bootstrap.js";
import { DaemonClient } from "../../src/daemon/client.js";
import { encodeFrame } from "../../src/daemon/protocol.js";
import { DaemonAlreadyRunningError, ManagerDaemon } from "../../src/daemon/manager.js";
import type { ProcessTracker } from "../../src/daemon/process-tracker.js";
import { isServing, netTransport } from "../../src/daemon/net-transport.js";
import type { DaemonServer } from "../../src/daemon/transport.js";

const isWindows = process.platform === "win32";

interface RunPaths {
  dir: string;
  sock: string;
  pid: string;
  lock: string;
  proc: string;
}

async function runPaths(): Promise<RunPaths> {
  const dir = await mkdtemp("/tmp/cbe-single-");
  return {
    dir,
    sock: join(dir, "m.sock"),
    pid: join(dir, "m.pid"),
    lock: join(dir, "m.lock"),
    proc: join(dir, "processes.json"),
  };
}

function manager(paths: RunPaths, publicationCheckMs?: number): ManagerDaemon {
  return new ManagerDaemon({
    socketPath: paths.sock,
    pidPath: paths.pid,
    lockPath: paths.lock,
    idleMs: 60_000,
    publicationCheckMs,
    transport: netTransport,
    processTrackerPath: paths.proc,
  });
}

async function answersStatus(socketPath: string): Promise<boolean> {
  const client = new DaemonClient({
    socketPath,
    transport: netTransport,
    rpcTimeoutMs: 1_000,
    connectTimeoutMs: 1_000,
  });
  try {
    await client.connect();
    await client.call("STATUS");
    return true;
  } catch {
    return false;
  } finally {
    client.close();
  }
}

describe.skipIf(isWindows)("daemon singleton (#205)", () => {
  let paths: RunPaths;
  const started: ManagerDaemon[] = [];
  const servers: DaemonServer[] = [];

  beforeEach(async () => {
    paths = await runPaths();
  });

  afterEach(async () => {
    for (const m of started.splice(0)) await m.stop(0).catch(() => {});
    for (const s of servers.splice(0)) await s.stop().catch(() => {});
    await rm(paths.dir, { recursive: true, force: true });
  });

  it("only one of several managers started at once on the same paths runs", async () => {
    const managers = Array.from({ length: 5 }, () => manager(paths));
    const outcomes = await Promise.allSettled(managers.map((m) => m.start()));
    managers.forEach((m, i) => {
      if (outcomes[i]!.status === "fulfilled") started.push(m);
    });

    expect(started).toHaveLength(1);
    expect(await answersStatus(paths.sock)).toBe(true);
  });

  it("refuses to bind over a live socket and leaves the live server reachable", async () => {
    let firstConnections = 0;
    const first = netTransport.createServer({
      path: paths.sock,
      onConnection: () => {
        firstConnections++;
      },
    });
    await first.start();
    servers.push(first);

    const second = netTransport.createServer({ path: paths.sock, onConnection: () => {} });
    await expect(second.start()).rejects.toThrow(/already listening/);
    await new Promise((r) => setTimeout(r, 20));
    const beforeConnect = firstConnections;

    const channel = await netTransport.connect({ path: paths.sock });
    await new Promise((r) => setTimeout(r, 20));
    channel.close();
    expect(firstConnections).toBe(beforeConnect + 1);
  });

  it("a daemon stopping after its run paths were taken over leaves the new owner's files", async () => {
    const original = manager(paths);
    await original.start();

    await unlink(paths.lock);
    await unlink(paths.pid);
    await unlink(paths.sock);
    const replacement = manager(paths);
    await replacement.start();
    started.push(replacement);
    const replacementLock = await readFile(paths.lock, "utf-8");

    await original.stop(0);

    expect(await readFile(paths.lock, "utf-8")).toBe(replacementLock);
    expect(await readFile(paths.pid, "utf-8")).toContain(String(process.pid));
    expect(await answersStatus(paths.sock)).toBe(true);
  });

  it("concurrent ensureDaemonRunning calls in one process launch one daemon", async () => {
    let launches = 0;
    const launch = (): void => {
      launches++;
      const m = manager(paths);
      started.push(m);
      void m.start();
    };

    await Promise.all(
      Array.from({ length: 6 }, () => ensureDaemonRunning({ socketPath: paths.sock, launch })),
    );

    expect(launches).toBe(1);
    expect(await answersStatus(paths.sock)).toBe(true);
  });

  it("starts a new attempt once the previous one has settled", async () => {
    let launches = 0;
    const launch = (): void => {
      launches++;
      const m = manager(paths);
      started.push(m);
      void m.start();
    };

    await ensureDaemonRunning({ socketPath: paths.sock, launch });
    await started.pop()!.stop(0);
    await ensureDaemonRunning({ socketPath: paths.sock, launch });

    expect(launches).toBe(2);
  });

  it("a fresh attempt waits for one already in flight and re-probes instead of launching twice", async () => {
    let launches = 0;
    const launch = (): void => {
      launches++;
      const m = manager(paths);
      started.push(m);
      void m.start();
    };

    await Promise.all([
      ensureDaemonRunning({ socketPath: paths.sock, launch }),
      ensureDaemonRunning({ socketPath: paths.sock, launch, freshAttempt: true }),
    ]);

    expect(launches).toBe(1);
  });

  it("a fresh attempt launches again when the attempt it waited for failed", async () => {
    let launches = 0;
    const launch = (): void => {
      launches++;
      if (launches === 1) return;
      const m = manager(paths);
      started.push(m);
      void m.start();
    };

    const [first, fresh] = await Promise.allSettled([
      ensureDaemonRunning({ socketPath: paths.sock, launch }),
      ensureDaemonRunning({ socketPath: paths.sock, launch, freshAttempt: true }),
    ]);

    expect(first.status).toBe("rejected");
    expect(fresh.status).toBe("fulfilled");
    expect(launches).toBe(2);
  }, 10_000);

  it("concurrent fresh attempts share one launch", async () => {
    let launches = 0;
    const launch = (): void => {
      launches++;
      const m = manager(paths);
      started.push(m);
      void m.start();
    };

    await Promise.all(
      Array.from({ length: 4 }, () =>
        ensureDaemonRunning({ socketPath: paths.sock, launch, freshAttempt: true }),
      ),
    );

    expect(launches).toBe(1);
  });

  it("a daemon that finds another already serving defers before touching shared files", async () => {
    const live = manager(paths);
    await live.start();
    started.push(live);
    const pidBefore = await readFile(paths.pid, "utf-8");
    await unlink(paths.lock);

    await expect(manager(paths).start()).rejects.toThrow(DaemonAlreadyRunningError);

    expect(await readFile(paths.pid, "utf-8")).toBe(pidBefore);
    expect(await answersStatus(paths.sock)).toBe(true);
  });

  it("a daemon whose socket now belongs to another daemon shuts itself down", async () => {
    const orphaned = manager(paths, 25);
    await orphaned.start();
    await unlink(paths.lock);
    await unlink(paths.pid);
    await unlink(paths.sock);
    const owner = manager(paths, 25);
    await owner.start();
    started.push(owner);

    const exit = await Promise.race([
      orphaned.waitForExit(),
      new Promise<string>((r) => setTimeout(() => r("still running"), 2_000)),
    ]);
    if (exit === "still running") await orphaned.stop(0);

    expect(exit).toBe(0);
    await new Promise((r) => setTimeout(r, 100));
    expect(await answersStatus(paths.sock)).toBe(true);
  });

  it("a sole daemon keeps serving and removes its socket when it stops", async () => {
    const sole = manager(paths, 25);
    await sole.start();

    await new Promise((r) => setTimeout(r, 100));
    expect(await answersStatus(paths.sock)).toBe(true);

    await sole.stop(0);
    await expect(lstat(paths.sock)).rejects.toThrow();
    await expect(lstat(paths.pid)).rejects.toThrow();
    await expect(lstat(paths.lock)).rejects.toThrow();
  });

  it("takes over a lock whose recorded pid now belongs to an unrelated process", async () => {
    await writeFile(paths.lock, `${process.pid}\n`);

    const m = manager(paths);
    await m.start();
    started.push(m);

    expect(await answersStatus(paths.sock)).toBe(true);
  });

  it("removes files abandoned by a crashed daemon but keeps a live staging socket", async () => {
    const busy = join(paths.dir, ".sbeef");
    const live = netTransport.createServer({ path: busy, onConnection: () => {} });
    await live.start();
    servers.push(live);
    const abandoned = join(paths.dir, ".sdead");
    const crashed = spawn(process.execPath, [
      "-e",
      `require("net").createServer().listen(${JSON.stringify(abandoned)}, () => process.kill(process.pid, "SIGKILL"))`,
    ]);
    await new Promise((r) => crashed.once("exit", r));
    expect((await lstat(abandoned)).isSocket()).toBe(true);
    const abandonedLockStaging = `${paths.lock}.dead-token.tmp`;
    await writeFile(abandonedLockStaging, "1\ndead-token\n");
    const past = new Date(Date.now() - 60_000);
    await utimes(abandonedLockStaging, past, past);

    const m = manager(paths);
    await m.start();
    started.push(m);

    await expect(lstat(abandoned)).rejects.toThrow();
    await expect(lstat(abandonedLockStaging)).rejects.toThrow();
    expect(await isServing(busy)).toBe(true);
  });

  function managerWithSlowReap(
    reapUntil: Promise<void>,
    { pidPath = paths.pid, idleMs = 60_000 }: { pidPath?: string; idleMs?: number } = {},
  ): ManagerDaemon {
    const tracker = {
      reapStale: async () => {
        await reapUntil;
        return { total: 0, killed: 0, skipped: 0 };
      },
      register: async () => {},
      unregister: async () => {},
    } as unknown as ProcessTracker;
    return new ManagerDaemon({
      socketPath: paths.sock,
      pidPath,
      lockPath: paths.lock,
      idleMs,
      transport: netTransport,
      processTracker: tracker,
    });
  }

  async function socketAppears(): Promise<void> {
    for (let i = 0; i < 100 && !(await isServing(paths.sock)); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it("survives a corrupt frame from a client that connects while it is still starting", async () => {
    let finishReap!: () => void;
    const m = managerWithSlowReap(new Promise<void>((r) => (finishReap = r)));
    started.push(m);
    const starting = m.start();
    await socketAppears();

    const rogue = createConnection(paths.sock);
    await new Promise((r) => rogue.once("connect", r));
    rogue.write(Buffer.from([0x7f, 0xff, 0xff, 0xff]));
    await new Promise((r) => setTimeout(r, 50));
    rogue.destroy();
    expect(await lstat(paths.pid).catch(() => null)).toBeNull();

    finishReap();
    await starting;
    expect(await answersStatus(paths.sock)).toBe(true);
  });

  it("a start that fails after claiming the socket releases everything even with a client waiting", async () => {
    const blocker = join(paths.dir, "not-a-dir");
    await writeFile(blocker, "");
    let finishReap!: () => void;
    const m = managerWithSlowReap(new Promise<void>((r) => (finishReap = r)), {
      pidPath: join(blocker, "m.pid"),
    });
    const settled = m.start().then(
      () => "started",
      () => "rejected",
    );
    await socketAppears();
    const waiting = createConnection(paths.sock);
    await new Promise((r) => waiting.once("connect", r));

    finishReap();
    const outcome = await Promise.race([
      settled,
      new Promise<string>((r) => setTimeout(() => r("hung"), 2_000)),
    ]);
    waiting.destroy();

    expect(outcome).toBe("rejected");
    await expect(lstat(paths.lock)).rejects.toThrow();
    await expect(lstat(paths.sock)).rejects.toThrow();
  });

  it("answers requests sent while it was still starting", async () => {
    let finishReap!: () => void;
    const m = managerWithSlowReap(new Promise<void>((r) => (finishReap = r)));
    started.push(m);
    const starting = m.start();
    await socketAppears();
    const early = new DaemonClient({
      socketPath: paths.sock,
      transport: netTransport,
      rpcTimeoutMs: 2_000,
      connectTimeoutMs: 1_000,
    });
    await early.connect();

    const status = early.call("STATUS");
    await new Promise((r) => setTimeout(r, 50));
    finishReap();
    await starting;

    await expect(status).resolves.toBeDefined();
    early.close();
  });

  it("forgets a client that left before it was ready, so it can still go idle", async () => {
    let finishReap!: () => void;
    const m = managerWithSlowReap(new Promise<void>((r) => (finishReap = r)), { idleMs: 100 });
    started.push(m);
    const starting = m.start();
    await socketAppears();
    const leaver = createConnection(paths.sock);
    await new Promise((r) => leaver.once("connect", r));
    leaver.destroy();
    await new Promise((r) => setTimeout(r, 50));

    finishReap();
    await starting;

    const exit = await Promise.race([
      m.waitForExit(),
      new Promise<string>((r) => setTimeout(() => r("still running"), 2_000)),
    ]);
    expect(exit).toBe(0);
  });

  it("steps down when its socket file is deleted", async () => {
    const m = manager(paths, 25);
    await m.start();
    started.push(m);

    await unlink(paths.sock);

    const exit = await Promise.race([
      m.waitForExit(),
      new Promise<string>((r) => setTimeout(() => r("still running"), 2_000)),
    ]);
    expect(exit).toBe(0);
  });

  it("drops a client that floods it while starting, so it can still go idle", async () => {
    let finishReap!: () => void;
    const m = managerWithSlowReap(new Promise<void>((r) => (finishReap = r)), { idleMs: 100 });
    started.push(m);
    const starting = m.start();
    await socketAppears();
    const flooder = createConnection(paths.sock);
    await new Promise((r) => flooder.once("connect", r));
    const droppedByDaemon = new Promise<void>((r) => flooder.once("end", () => r()));
    for (let i = 0; i < 70; i++) flooder.write(encodeFrame({ id: String(i), method: "STATUS" }));
    await expect(
      Promise.race([droppedByDaemon, new Promise((_, reject) => setTimeout(() => reject(new Error("not dropped")), 1_000))]),
    ).resolves.toBeUndefined();
    flooder.destroy();

    finishReap();
    await starting;

    const exit = await Promise.race([
      m.waitForExit(),
      new Promise<string>((r) => setTimeout(() => r("still running"), 2_000)),
    ]);
    expect(exit).toBe(0);
  });

  it("keeps waiting for a launched daemon that is still reaping leaked children", async () => {
    let launches = 0;
    const launch = (): void => {
      launches++;
      const m = managerWithSlowReap(new Promise<void>((r) => setTimeout(r, 10_000)));
      started.push(m);
      void m.start();
    };

    await ensureDaemonRunning({ socketPath: paths.sock, launch });

    expect(launches).toBe(1);
    expect(await answersStatus(paths.sock)).toBe(true);
  }, 20_000);
});
