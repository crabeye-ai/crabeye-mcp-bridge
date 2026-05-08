import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DaemonLivenessSupervisor } from "../../src/daemon/liveness-supervisor.js";
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
    await fx.kill(); // socket close + lockfile becomes stale
    // Wait for the supervisor to detect socket_close and run force-respawn.
    await new Promise((r) => setTimeout(r, 400));
    const stats = sup._statsForTest();
    expect(stats.daemonRespawns).toBe(1);
    expect(stats.sigkillsIssued).toBe(0);
    expect(ensureCalls).toBe(1);
    await sup.close();
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

  it("two-bridge race: respawnLockWaitMs bounds acquireLockBounded; loser surfaces respawnFailed", async () => {
    // The loser sees the OLD lockfile held by an unrelated alive pid (the
    // test runner) for the duration of the test. acquireLockBounded never
    // wins, so respawnFailed fires after respawnLockWaitMs.
    //
    // In-process daemon makes this awkward: daemon.pid === process.pid,
    // so we can't grab the lock until daemon.stop() unlinks it. Spin a
    // second fixture as the supervisor's target so it can connect briefly
    // before we trip socket_close, while the lock continues to point at fx.
    await fx.kill();
    const { acquireLock } = await import("../../src/daemon/lockfile.js");
    const competingHolder = await acquireLock(fx.lockPath, {
      pid: process.pid,
      stealStale: true,
    });
    const fx2 = await spawnTestManager();
    const sup = new DaemonLivenessSupervisor({
      socketPath: fx2.socketPath,
      rpcTimeoutMs: 1_000,
      heartbeatMs: 5_000,
      respawnLockWaitMs: 200,
      lockPath: fx.lockPath,
      pidPath: fx.pidPath,
      _ensureDaemonRunning: async () => { /* unreached */ },
    });
    try {
      const respawnFailed = new Promise<unknown>((resolve) => {
        sup.once("respawnFailed", (err) => resolve(err));
      });
      await sup.connect();
      await fx2.kill();
      const err = await Promise.race([
        respawnFailed,
        new Promise<unknown>((resolve) => setTimeout(() => resolve(null), 1_500)),
      ]);
      expect(err).not.toBeNull();
      expect(sup._statsForTest().daemonRespawns).toBe(0);
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
