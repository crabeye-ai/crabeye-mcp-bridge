import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ManagerDaemon } from "../../src/daemon/manager.js";
import { DaemonClient } from "../../src/daemon/client.js";
import { netTransport } from "../../src/daemon/net-transport.js";
import { APP_NAME } from "../../src/constants.js";

const minimum = vi.hoisted(() => ({ version: 1 }));

vi.mock("../../src/daemon/protocol.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/daemon/protocol.js")>();
  return {
    ...actual,
    get MIN_BRIDGE_PROTOCOL_VERSION() {
      return minimum.version;
    },
  };
});

const isWindows = process.platform === "win32";

const SPEC = {
  serverName: "x",
  command: "node",
  args: [],
  resolvedEnv: {},
  cwd: "",
  clientInfo: { name: "test-bridge", version: "0.0.0" },
  clientCapabilities: {},
  protocolVersion: "2025-06-18",
};

describe.skipIf(isWindows)("ManagerDaemon checking the protocol version a bridge opens with", () => {
  let dir: string;
  let manager: ManagerDaemon;
  let client: DaemonClient;

  beforeEach(async () => {
    dir = await mkdtemp("/tmp/cbe-bridge-protocol-");
    minimum.version = 1;
    manager = new ManagerDaemon({
      socketPath: join(dir, "m.sock"),
      pidPath: join(dir, "m.pid"),
      lockPath: join(dir, "m.lock"),
      idleMs: 60_000,
      transport: netTransport,
      processTrackerPath: join(dir, "processes.json"),
      _spawnChild: () =>
        ({
          startedAt: Date.now(),
          pid: 99999,
          alive: true,
          cachedInit: null,
          setCachedInit() {},
          send() {},
          async kill() {},
        }) as never,
    });
    await manager.start();
    client = new DaemonClient({ socketPath: join(dir, "m.sock"), transport: netTransport, rpcTimeoutMs: 1_000 });
  });

  afterEach(async () => {
    client.close();
    await manager.stop(0).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  function open(params: Record<string, unknown>): Promise<unknown> {
    return client.call("OPEN", { sessionId: randomUUID(), spec: SPEC, ...params });
  }

  it("opens for a bridge that reports a supported protocol version, or none", async () => {
    await expect(open({})).resolves.toEqual({ ok: true });
    await expect(open({ bridgeProtocolVersion: 1 })).resolves.toEqual({ ok: true });
    await expect(open({ bridgeProtocolVersion: 7 })).resolves.toEqual({ ok: true });
  });

  it.each([0, -1, 1.5, "1", null])("refuses a malformed protocol version %j as invalid params", async (bridgeProtocolVersion) => {
    await expect(open({ bridgeProtocolVersion })).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("refuses a bridge older than the oldest protocol version it supports, counting a bridge that reports none as version 1", async () => {
    minimum.version = 2;

    const refusal = {
      code: "bridge_unsupported",
      message: `this daemon needs a bridge using protocol version 2 or newer, not 1; restart the assistant to use the current ${APP_NAME}`,
    };
    await expect(open({})).rejects.toMatchObject(refusal);
    await expect(open({ bridgeProtocolVersion: 1 })).rejects.toMatchObject(refusal);
    await expect(open({ bridgeProtocolVersion: 2 })).resolves.toEqual({ ok: true });
    expect(((await client.call("STATUS")) as { sessions: unknown[] }).sessions).toHaveLength(1);
  });
});
