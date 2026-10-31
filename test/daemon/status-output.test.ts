import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagerDaemon } from "../../src/daemon/manager.js";
import { DaemonClient } from "../../src/daemon/client.js";
import { netTransport } from "../../src/daemon/net-transport.js";
import { PROTOCOL_VERSION, type StatusResult } from "../../src/daemon/protocol.js";
import { APP_VERSION } from "../../src/constants.js";
import { AttachedBridge, fixtureSource, servingConfigs, spawnTestManager } from "../_helpers/daemon-fixtures.js";
import { STUB_STDIO_SERVER } from "../_helpers/stub-stdio-server.js";

const isWindows = process.platform === "win32";

async function tempPaths() {
  const dir = await mkdtemp("/tmp/cbe-mgr-status-");
  return { dir, sock: join(dir, "m.sock"), pid: join(dir, "m.pid"), lock: join(dir, "m.lock"), proc: join(dir, "processes.json") };
}

describe.skipIf(isWindows)("ManagerDaemon — STATUS shape", () => {
  let paths: Awaited<ReturnType<typeof tempPaths>>;
  let manager: ManagerDaemon | null = null;
  beforeEach(async () => { paths = await tempPaths(); await mkdir(paths.dir, { recursive: true }); manager = null; });
  afterEach(async () => { if (manager !== null) await manager.stop(0).catch(() => {}); await rm(paths.dir, { recursive: true, force: true }); });

  it("returns per-child and per-upstream entries with exactly their fields, and the telemetry counters", async () => {
    const stubDir = await mkdtemp(join(tmpdir(), "cbe-status-stub-"));
    const stub = join(stubDir, "stub.cjs");
    await writeFile(stub, STUB_STDIO_SERVER);
    const fx = await spawnTestManager({ manager: servingConfigs({ [fixtureSource.path]: { x: { command: process.execPath, args: [stub] } } }) });
    try {
      const bridge = await AttachedBridge.attach(fx);
      await bridge.connected("x");

      const status = (await fx.client.call("STATUS")) as StatusResult;
      expect(status.appVersion).toBe(APP_VERSION);
      expect(status.version).toBe(PROTOCOL_VERSION);
      expect(status.minBridgeProtocolVersion).toBe(PROTOCOL_VERSION);
      expect(Object.keys(status).sort()).toEqual(["appVersion", "children", "instances", "minBridgeProtocolVersion", "pid", "telemetry", "upstreams", "uptime", "version"]);
      expect(status.children).toHaveLength(1);
      expect(Object.keys(status.children[0]!).sort()).toEqual(["era", "instances", "pid", "serverName", "startedAt", "upstreamHash"]);
      expect(status.upstreams).toEqual([{ serverName: "x", type: "stdio", status: "connected", instances: 1, upstreamHash: status.children[0]!.upstreamHash }]);
      expect(status.telemetry.children).toEqual({ total: 1, spawnedTotal: 1, killedTotal: { grace: 0, restart: 0, crash: 0, wedged: 0 } });
      expect(Object.keys(status.telemetry).sort()).toEqual(["children", "rpc"]);
      // STATUS itself is in-flight at the moment its snapshot is computed, so
      // this gauge reads 1 — the request that produced this snapshot.
      expect(status.telemetry.rpc.inFlight).toBe(1);
      bridge.close();
    } finally {
      await fx.stop();
      await rm(stubDir, { recursive: true, force: true });
    }
  });

  it("records rpc errors and unknown-method counters by code", async () => {
    manager = new ManagerDaemon({
      socketPath: paths.sock, pidPath: paths.pid, lockPath: paths.lock,
      idleMs: 60_000, transport: netTransport, processTrackerPath: paths.proc,
    });
    await manager.start();
    const c = new DaemonClient({ socketPath: paths.sock, transport: netTransport, rpcTimeoutMs: 1_000, connectTimeoutMs: 1_000 });
    try {
      await c.connect();
      // Trigger two distinct error codes.
      await c.call("BOGUS_METHOD").catch(() => {});
      await c.call("OPEN", { sessionId: "from-an-old-bridge" }).catch(() => {});

      const status = (await c.call("STATUS")) as StatusResult;
      expect(status.telemetry.rpc.errorsTotal).toEqual({ unknown_method: 1, bridge_unsupported: 1 });
    } finally {
      c.close();
    }
  });
});
