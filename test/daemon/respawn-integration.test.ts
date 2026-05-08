/**
 * Integration tests for AIT-249: real `ManagerDaemon` spawned in a temp dir,
 * `DaemonLivenessSupervisor` driven by failure modes the bridge sees in
 * production (kill, stall, two-bridge race, capability re-init).
 *
 * Notes on flake-resistance: per the plan, these tests use generous timeouts
 * (300-500ms for liveness-failure to fire) and prefer event-based awaits over
 * fixed delays. If a case becomes flaky, document it in a comment rather than
 * tightening into a brittle race.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DaemonLivenessSupervisor } from "../../src/daemon/liveness-supervisor.js";
import {
  spawnTestManager,
  OpenSessionFixture,
  type DaemonFixture,
} from "../_helpers/daemon-fixtures.js";

const isWindows = process.platform === "win32";

describe.skipIf(isWindows)("AIT-249 integration — daemon kill / stall / race", () => {
  let fx: DaemonFixture;
  beforeEach(async () => {
    fx = await spawnTestManager();
  });
  afterEach(async () => {
    await fx.stop();
  });

  it("crash test: SIGKILL daemon → supervisor detects socket_close (force-respawn disabled in-process)", async () => {
    // NB: ManagerDaemon runs IN-PROCESS in these tests, so pidPath contains
    // process.pid. If we let force-respawn issue SIGKILL on that pid, we
    // kill the test runner. So we disable force-respawn here and assert on
    // detection only. The full respawn flow is exercised in
    // test/daemon/liveness-supervisor.test.ts with a stubbed
    // `_ensureDaemonRunning`.
    const sup = new DaemonLivenessSupervisor({
      socketPath: fx.socketPath,
      rpcTimeoutMs: 1_000,
      heartbeatMs: 5_000,
      respawnLockWaitMs: 1_000,
      lockPath: fx.lockPath,
      pidPath: fx.pidPath,
      _disableForceRespawnForTest: true,
    });
    const onFail = vi.fn();
    sup.on("livenessFailure", onFail);
    await sup.connect();
    await fx.kill();
    await new Promise((r) => setTimeout(r, 300));
    expect(onFail).toHaveBeenCalled();
    expect(onFail.mock.calls[0]![0]).toMatchObject({ kind: "socket_close" });
    await sup.close();
  });

  it("stalled-daemon test: severed inbound frames → heartbeat watchdog fires", async () => {
    const sup = new DaemonLivenessSupervisor({
      socketPath: fx.socketPath,
      rpcTimeoutMs: 1_000,
      heartbeatMs: 30,
      respawnLockWaitMs: 200,
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

  it("admin-restart test: RESTART RPC kills the group and surfaces upstream_restarted to attached sessions", async () => {
    const session = await OpenSessionFixture.open(fx);
    // Stage an in-flight bridge→daemon RPC so the daemon allocates an outer id.
    session.sendNotification("RPC", {
      sessionId: session.sessionId,
      payload: { jsonrpc: "2.0", id: 99, method: "tools/list" },
    });
    await new Promise((r) => setTimeout(r, 50));

    const status = (await fx.client.call("STATUS")) as {
      children: { upstreamHash: string }[];
    };
    expect(status.children.length).toBeGreaterThan(0);
    const hash = status.children[0]!.upstreamHash;

    const restartResult = (await fx.client.call("RESTART", { upstreamHash: hash })) as {
      ok: true;
      killed: number;
    };
    expect(restartResult).toEqual({ ok: true, killed: 1 });

    // Bridge sees the upstream-restarted inner error frame.
    const frame = await session.waitForFrame((p) => {
      const r = p as {
        error?: { code?: number; data?: { reason?: string } };
      };
      return (
        r?.error?.code === -32004 &&
        r?.error?.data?.reason === "admin_restart"
      );
    }, 1_000);
    expect(frame).toBeDefined();

    await session.close();
  });

  it("PING/PONG round-trip exercises the heartbeat protocol against a real daemon", async () => {
    const sup = new DaemonLivenessSupervisor({
      socketPath: fx.socketPath,
      rpcTimeoutMs: 1_000,
      heartbeatMs: 50,
      respawnLockWaitMs: 1_000,
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
});
