import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnTestManager, OpenSessionFixture, type DaemonFixture } from "../_helpers/daemon-fixtures.js";
import {
  INNER_ERROR_CODE_UPSTREAM_RESTARTED,
  type RestartParams,
  type RestartResult,
} from "../../src/daemon/protocol.js";

const isWindows = process.platform === "win32";

describe.skipIf(isWindows)("ManagerDaemon — RESTART handler", () => {
  let fx: DaemonFixture;

  beforeEach(async () => {
    fx = await spawnTestManager();
  });

  afterEach(async () => {
    await fx.stop();
  });

  it("kills the matching group, surfaces ERR_UPSTREAM_RESTARTED to attached sessions, returns killed count", async () => {
    const session = await OpenSessionFixture.open(fx);
    const status = (await fx.client.call("STATUS")) as { children: { upstreamHash: string }[] };
    expect(status.children.length).toBeGreaterThan(0);
    const hash = status.children[0]!.upstreamHash;

    const params: RestartParams = { upstreamHash: hash };
    const res = (await fx.client.call("RESTART", params)) as RestartResult;
    expect(res).toEqual({ ok: true, killed: 1 });

    // STATUS should now show no children (the killed group is gone).
    // unregisterGroup() is awaited synchronously with the response chain so
    // give the kill a tick to propagate.
    await new Promise((r) => setTimeout(r, 100));
    const after = (await fx.client.call("STATUS")) as import("../../src/daemon/protocol.js").StatusResult;
    expect(after.children).toEqual([]);
    // Telemetry: admin RESTART increments killedTotal.restart.
    expect(after.telemetry.children.killedTotal.restart).toBe(1);
    expect(after.telemetry.children.killedTotal.grace).toBe(0);
    expect(after.telemetry.children.killedTotal.fork).toBe(0);
    expect(after.telemetry.children.killedTotal.crash).toBe(0);
    await session.close();
  });

  it("returns ok with killed=0 for an unknown hash", async () => {
    const res = (await fx.client.call("RESTART", { upstreamHash: "0".repeat(64) })) as RestartResult;
    expect(res).toEqual({ ok: true, killed: 0 });
  });

  it("rejects malformed params with invalid_params", async () => {
    await expect(fx.client.call("RESTART", { upstreamHash: 123 })).rejects.toMatchObject({
      code: "invalid_params",
    });
  });

  it("emits an upstream_restarted error for in-flight requests on the killed group", async () => {
    // OPEN a session and prime it with an in-flight RPC. We don't have a real
    // upstream child here, but the daemon's RPC pipeline allocates outer ids
    // on outbound bridge→child notifications, so we send one.
    const session = await OpenSessionFixture.open(fx);
    const evictionFrames: unknown[] = [];
    session.onRpcNotification((p) => evictionFrames.push(p));

    // Send a bridge→daemon RPC notification carrying a request payload to
    // create an inflight outer id. Must go through the session's OWNING
    // channel so the synthetic response lands back on the same socket.
    session.sendNotification("RPC", {
      sessionId: session.sessionId,
      payload: { jsonrpc: "2.0", id: 42, method: "tools/list" },
    });
    // Give the daemon a tick to allocate the outer id.
    await new Promise((r) => setTimeout(r, 50));

    const status = (await fx.client.call("STATUS")) as { children: { upstreamHash: string }[] };
    const hash = status.children[0]!.upstreamHash;
    await fx.client.call("RESTART", { upstreamHash: hash });

    // Look for the synthetic JSON-RPC error frame.
    await session.waitForFrame((p) => {
      const r = p as { error?: { code?: number; data?: { reason?: string } }; id?: unknown };
      return (
        r?.error?.code === INNER_ERROR_CODE_UPSTREAM_RESTARTED &&
        r?.error?.data?.reason === "admin_restart"
      );
    }, 1_000);
    await session.close();
  });
});
