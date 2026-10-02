import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DaemonLivenessSupervisor } from "../../src/daemon/liveness-supervisor.js";
import { ManagerDaemon } from "../../src/daemon/manager.js";
import { netTransport } from "../../src/daemon/net-transport.js";
import { spawnTestManager, type DaemonFixture } from "../_helpers/daemon-fixtures.js";

const isWindows = process.platform === "win32";

describe.skipIf(isWindows)("DaemonLivenessSupervisor — heartbeat", () => {
  let fx: DaemonFixture;
  beforeEach(async () => {
    fx = await spawnTestManager();
  });
  afterEach(async () => {
    await fx.stop();
  });

  it("sends PING on the configured cadence and receives PONG", async () => {
    const sup = new DaemonLivenessSupervisor({
      socketPath: fx.socketPath,
      rpcTimeoutMs: 1_000,
      heartbeatMs: 50,
      respawnLockWaitMs: 500,
      lockPath: fx.lockPath,
      pidPath: fx.pidPath,
      _disableForceRespawnForTest: true,
    });
    await sup.connect();
    await new Promise((r) => setTimeout(r, 220));
    const stats = sup._statsForTest();
    expect(stats.pingsSent).toBeGreaterThan(2);
    expect(stats.pongsReceived).toBeGreaterThan(2);
    await sup.close();
  });

  it("emits 'livenessFailure' when heartbeats are not answered for heartbeatMs * 3", async () => {
    const sup = new DaemonLivenessSupervisor({
      socketPath: fx.socketPath,
      rpcTimeoutMs: 1_000,
      heartbeatMs: 30,
      respawnLockWaitMs: 500,
      lockPath: fx.lockPath,
      pidPath: fx.pidPath,
      _disableForceRespawnForTest: true,
    });
    const onFail = vi.fn();
    sup.on("livenessFailure", onFail);
    await sup.connect();
    fx.severIncomingFrames();
    await new Promise((r) => setTimeout(r, 300));
    expect(onFail).toHaveBeenCalled();
    expect(onFail.mock.calls[0]![0]).toMatchObject({ kind: "heartbeat_miss" });
    await sup.close();
  });

  it("does NOT trip livenessFailure when an arbitrary user call times out (per-RPC errors propagate to caller)", async () => {
    const sup = new DaemonLivenessSupervisor({
      socketPath: fx.socketPath,
      rpcTimeoutMs: 50,
      heartbeatMs: 10_000,
      respawnLockWaitMs: 500,
      lockPath: fx.lockPath,
      pidPath: fx.pidPath,
      _disableForceRespawnForTest: true,
    });
    const onFail = vi.fn();
    sup.on("livenessFailure", onFail);
    await sup.connect();
    fx.severIncomingFrames();
    await expect(sup.call("STATUS")).rejects.toMatchObject({ code: "rpc_timeout" });
    expect(onFail).not.toHaveBeenCalled();
    await sup.close();
  });

  it("emits 'livenessFailure' with kind=socket_close when the daemon socket dies", async () => {
    const sup = new DaemonLivenessSupervisor({
      socketPath: fx.socketPath,
      rpcTimeoutMs: 1_000,
      heartbeatMs: 5_000,
      respawnLockWaitMs: 500,
      lockPath: fx.lockPath,
      pidPath: fx.pidPath,
      _disableForceRespawnForTest: true,
    });
    const onFail = vi.fn();
    sup.on("livenessFailure", onFail);
    await sup.connect();
    await fx.kill();
    await new Promise((r) => setTimeout(r, 200));
    expect(onFail).toHaveBeenCalled();
    expect(onFail.mock.calls[0]![0]).toMatchObject({ kind: "socket_close" });
    await sup.close();
  });
});

describe.skipIf(isWindows)("DaemonLivenessSupervisor — force-respawn", () => {
  let fx: DaemonFixture;
  beforeEach(async () => {
    fx = await spawnTestManager();
  });
  afterEach(async () => {
    await fx.stop();
  });

  it("force-respawn: lock acquired immediately → daemon already dead → spawn without SIGKILL", async () => {
    let ensureCalls = 0;
    const ensureOptions: unknown[] = [];
    const sup = new DaemonLivenessSupervisor({
      socketPath: fx.socketPath,
      rpcTimeoutMs: 1_000,
      heartbeatMs: 5_000,
      respawnLockWaitMs: 1_000,
      lockPath: fx.lockPath,
      pidPath: fx.pidPath,
      _ensureDaemonRunning: async (opts) => {
        ensureCalls++;
        ensureOptions.push(opts);
      },
    });
    await sup.connect();
    await fx.kill(); // socket close + lockfile becomes stale
    // Wait for the supervisor to detect socket_close and run force-respawn.
    await new Promise((r) => setTimeout(r, 400));
    const stats = sup._statsForTest();
    expect(stats.daemonRespawns).toBe(1);
    expect(stats.sigkillsIssued).toBe(0);
    expect(ensureCalls).toBe(1);
    expect(ensureOptions).toEqual([{ freshAttempt: true }]);
    await sup.close();
  });

  it("reconnects without killing or spawning when another daemon already answers on the socket", async () => {
    let ensureCalls = 0;
    const sup = new DaemonLivenessSupervisor({
      socketPath: fx.socketPath,
      rpcTimeoutMs: 1_000,
      heartbeatMs: 5_000,
      respawnLockWaitMs: 1_000,
      lockPath: fx.lockPath,
      pidPath: fx.pidPath,
      _ensureDaemonRunning: async () => {
        ensureCalls++;
      },
    });
    await sup.connect();
    const outcomes: string[] = [];
    sup.on("respawned", () => outcomes.push("reconnected"));
    sup.on("respawnFailed", () => outcomes.push("failed"));
    await rm(fx.lockPath);
    await rm(fx.pidPath);
    await rm(fx.socketPath);
    const successor = new ManagerDaemon({
      socketPath: fx.socketPath,
      pidPath: fx.pidPath,
      lockPath: fx.lockPath,
      idleMs: 60_000,
      transport: netTransport,
      processTrackerPath: join(fx.dir, "successor-processes.json"),
    });
    await successor.start();

    await fx.kill();
    await new Promise((r) => setTimeout(r, 400));

    const stats = sup._statsForTest();
    expect(outcomes).toEqual(["reconnected"]);
    expect(ensureCalls).toBe(0);
    expect(stats.sigkillsIssued).toBe(0);
    expect(stats.daemonRespawns).toBe(0);
    await sup.close();
    await successor.stop(0);
  });

  it("a stalled connection is not treated as a dropped one: no reconnect shortcut", async () => {
    let ensureCalls = 0;
    const sup = new DaemonLivenessSupervisor({
      socketPath: fx.socketPath,
      rpcTimeoutMs: 300,
      heartbeatMs: 100,
      respawnLockWaitMs: 100,
      lockPath: fx.lockPath,
      pidPath: fx.pidPath,
      _ensureDaemonRunning: async () => {
        ensureCalls++;
      },
    });
    const failures: string[] = [];
    sup.on("livenessFailure", (ev: { kind: string }) => failures.push(ev.kind));
    await sup.connect();

    fx.severIncomingFrames();
    await new Promise((r) => setTimeout(r, 1_500));

    expect(failures[0]).not.toBe("socket_close");
    expect(ensureCalls).toBeGreaterThanOrEqual(1);
    await sup.close();
  });

  it("never kills a successor daemon that took over the pidfile and lock", async () => {
    const successor = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "daemon", "--internal-launch"]);
    let ensureCalls = 0;
    const sup = new DaemonLivenessSupervisor({
      socketPath: fx.socketPath,
      rpcTimeoutMs: 300,
      heartbeatMs: 100,
      respawnLockWaitMs: 200,
      lockPath: fx.lockPath,
      pidPath: fx.pidPath,
      _ensureDaemonRunning: async () => {
        ensureCalls++;
      },
    });
    try {
      await sup.connect();
      await writeFile(fx.pidPath, `${successor.pid}\n`);
      await writeFile(fx.lockPath, `${successor.pid}\nsuccessor\n`);

      fx.severIncomingFrames();
      await new Promise((r) => setTimeout(r, 1_500));

      expect(successor.exitCode).toBeNull();
      expect(successor.signalCode).toBeNull();
      expect(sup._statsForTest().sigkillsIssued).toBe(0);
      expect(ensureCalls).toBeGreaterThanOrEqual(1);
    } finally {
      successor.kill();
      await sup.close();
    }
  });

  it("a supervisor closed during a respawn neither ensures nor reconnects", async () => {
    const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    let ensureCalls = 0;
    const sup = new DaemonLivenessSupervisor({
      socketPath: fx.socketPath,
      rpcTimeoutMs: 300,
      heartbeatMs: 100,
      respawnLockWaitMs: 2_000,
      lockPath: fx.lockPath,
      pidPath: fx.pidPath,
      _ensureDaemonRunning: async () => {
        ensureCalls++;
      },
    });
    try {
      await sup.connect();
      await writeFile(fx.lockPath, `${holder.pid}\nholder\n`);
      await fx.kill();
      await new Promise((r) => setTimeout(r, 700));

      await sup.close();
      await new Promise((r) => setTimeout(r, 300));

      expect(ensureCalls).toBe(0);
    } finally {
      holder.kill();
    }
  });

  it("force-respawn flow is single-flight per supervisor", async () => {
    let ensureCalls = 0;
    const sup = new DaemonLivenessSupervisor({
      socketPath: fx.socketPath,
      rpcTimeoutMs: 1_000,
      heartbeatMs: 5_000,
      respawnLockWaitMs: 1_000,
      lockPath: fx.lockPath,
      pidPath: fx.pidPath,
      _ensureDaemonRunning: async () => {
        ensureCalls++;
      },
    });
    await sup.connect();
    await fx.kill();
    await new Promise((r) => setTimeout(r, 400));
    expect(sup._statsForTest().daemonRespawns).toBe(1);
    expect(ensureCalls).toBe(1);
    await sup.close();
  });

  it("two-bridge race: after respawnLockWaitMs the loser still ensures a daemon instead of giving up", async () => {
    await fx.kill();
    const { acquireLock } = await import("../../src/daemon/lockfile.js");
    const competingHolder = await acquireLock(fx.lockPath, {
      pid: process.pid,
      stealStale: true,
    });
    const fx2 = await spawnTestManager();
    let ensureCalls = 0;
    const sup = new DaemonLivenessSupervisor({
      socketPath: fx2.socketPath,
      rpcTimeoutMs: 1_000,
      heartbeatMs: 5_000,
      respawnLockWaitMs: 200,
      lockPath: fx.lockPath,
      pidPath: fx.pidPath,
      _ensureDaemonRunning: async () => {
        ensureCalls++;
      },
    });
    try {
      await sup.connect();
      await fx2.kill();
      await new Promise((r) => setTimeout(r, 1_000));
      expect(ensureCalls).toBe(1);
      expect(sup._statsForTest().sigkillsIssued).toBe(0);
    } finally {
      await competingHolder.release();
      await sup.close();
      await fx2.stop();
    }
  });

  it("recycled-pid safety: manager.pid points at an unrelated process — no SIGKILL is sent", async () => {
    let ensureCalls = 0;
    const sup = new DaemonLivenessSupervisor({
      socketPath: fx.socketPath,
      rpcTimeoutMs: 1_000,
      heartbeatMs: 5_000,
      respawnLockWaitMs: 1_000,
      lockPath: fx.lockPath,
      pidPath: fx.pidPath,
      _ensureDaemonRunning: async () => {
        ensureCalls++;
      },
    });
    await sup.connect();

    // Kill the daemon hard. Then overwrite the pidfile with a known-alive pid
    // that is NOT the daemon (process.pid — i.e., this test runner). Lock-first
    // path should acquire the now-stale lock without ever consulting the
    // pidfile, so no SIGKILL is sent.
    await fx.kill();
    await fx.writePidfile(process.pid);
    await new Promise((r) => setTimeout(r, 400));

    expect(sup._statsForTest().sigkillsIssued).toBe(0);
    expect(sup._statsForTest().daemonRespawns).toBe(1);
    expect(ensureCalls).toBe(1);
    await sup.close();
  });
});

describe.skipIf(isWindows)("DaemonLivenessSupervisor — kill scope and lock wait", () => {
  let dir: string;
  const children: ChildProcess[] = [];
  const managers: ManagerDaemon[] = [];

  beforeEach(async () => {
    dir = await mkdtemp("/tmp/cbe-scope-");
  });

  afterEach(async () => {
    for (const m of managers.splice(0)) await m.stop(0).catch(() => {});
    for (const c of children.splice(0)) c.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function child(...args: string[]): ChildProcess {
    const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", ...args]);
    children.push(c);
    return c;
  }

  async function daemonReportingPid(pid: number, name = "m"): Promise<{ sock: string; lock: string; pidPath: string }> {
    const paths = { sock: join(dir, `${name}.sock`), lock: join(dir, `${name}.lock`), pidPath: join(dir, `${name}.pid`) };
    const m = new ManagerDaemon({
      socketPath: paths.sock,
      pidPath: paths.pidPath,
      lockPath: paths.lock,
      idleMs: 60_000,
      transport: netTransport,
      processTrackerPath: join(dir, `${name}-processes.json`),
      pid,
    });
    await m.start();
    managers.push(m);
    return paths;
  }

  function supervisorFor(paths: { sock: string; lock: string; pidPath: string }, respawnLockWaitMs: number, onEnsure = () => {}) {
    return new DaemonLivenessSupervisor({
      socketPath: paths.sock,
      rpcTimeoutMs: 300,
      heartbeatMs: 100,
      respawnLockWaitMs,
      lockPath: paths.lock,
      pidPath: paths.pidPath,
      _ensureDaemonRunning: async () => onEnsure(),
    });
  }

  it("does not kill the connected pid when it no longer belongs to a daemon", async () => {
    const unrelated = child();
    const paths = await daemonReportingPid(unrelated.pid!);
    const sup = supervisorFor(paths, 200);
    await sup.connect();
    await new Promise((r) => setTimeout(r, 300));

    managers[0]!.severFramesForTest();
    await new Promise((r) => setTimeout(r, 1_200));

    expect(unrelated.signalCode).toBeNull();
    expect(sup._statsForTest().sigkillsIssued).toBe(0);
    await sup.close();
  });

  it("kills the daemon it talked to even when the pidfile names a successor", async () => {
    const ours = child("daemon", "--internal-launch");
    const successor = child("daemon", "--internal-launch");
    const paths = await daemonReportingPid(ours.pid!);
    await writeFile(paths.pidPath, `${successor.pid}\n`);
    const sup = supervisorFor(paths, 200);
    await sup.connect();
    await new Promise((r) => setTimeout(r, 300));

    managers[0]!.severFramesForTest();
    await new Promise((r) => setTimeout(r, 1_200));

    expect(ours.signalCode).toBe("SIGKILL");
    expect(successor.signalCode).toBeNull();
    await sup.close();
  });

  it("closes promptly while waiting for the lock", async () => {
    const holder = child("daemon", "--internal-launch");
    const paths = await daemonReportingPid(process.pid);
    const sup = supervisorFor(paths, 5_000);
    await sup.connect();
    await writeFile(paths.lock, `${holder.pid}\nholder\n`);
    await managers.pop()!.stop(0);
    await new Promise((r) => setTimeout(r, 400));

    const started = Date.now();
    await sup.close();

    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("stops waiting for the lock as soon as a daemon answers", async () => {
    const holder = child("daemon", "--internal-launch");
    const paths = await daemonReportingPid(process.pid);
    let ensureCalls = 0;
    const sup = supervisorFor(paths, 5_000, () => {
      ensureCalls++;
    });
    await sup.connect();
    await writeFile(paths.lock, `${holder.pid}\nholder\n`);
    await managers.pop()!.stop(0);
    await new Promise((r) => setTimeout(r, 300));

    const successor = new ManagerDaemon({
      socketPath: paths.sock,
      pidPath: join(dir, "successor.pid"),
      lockPath: join(dir, "successor.lock"),
      idleMs: 60_000,
      transport: netTransport,
      processTrackerPath: join(dir, "successor-processes.json"),
    });
    await successor.start();
    managers.push(successor);
    await new Promise((r) => setTimeout(r, 1_200));

    expect(ensureCalls).toBe(1);
    await sup.close();
  });
});
