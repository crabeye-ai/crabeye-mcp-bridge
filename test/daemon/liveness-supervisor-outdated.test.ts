import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import type { Server } from "node:net";
import { DaemonLivenessSupervisor } from "../../src/daemon/liveness-supervisor.js";
import type { EnsureAttemptOptions } from "../../src/daemon/bootstrap.js";
import { PROTOCOL_VERSION } from "../../src/daemon/protocol.js";
import { APP_VERSION } from "../../src/constants.js";
import { spawnTestManager, until, type DaemonFixture } from "../_helpers/daemon-fixtures.js";
import { closeServer, serveFrames } from "../_helpers/frame-server.js";

const isWindows = process.platform === "win32";

interface FakeDaemon {
  server: Server;
  connections: () => number;
}

async function serveDaemon(path: string, status: Record<string, unknown>): Promise<FakeDaemon> {
  let connections = 0;
  const server = await serveFrames(path, ({ method, params }) =>
    method === "PING" ? { seq: (params as { seq?: number } | undefined)?.seq, pid: process.pid } : { pid: process.pid, ...status },
  );
  server.on("connection", () => connections++);
  return { server, connections: () => connections };
}

describe.skipIf(isWindows)("DaemonLivenessSupervisor reconnecting to a daemon of another version", () => {
  let fx: DaemonFixture;
  let fake: FakeDaemon | undefined;
  let sup: DaemonLivenessSupervisor | undefined;
  let events: string[];

  beforeEach(async () => {
    fx = await spawnTestManager();
    events = [];
  });

  afterEach(async () => {
    await sup?.close();
    sup = undefined;
    if (fake !== undefined) await closeServer(fake.server);
    fake = undefined;
    await fx.stop();
  });

  async function dropConnectionTo(status: Record<string, unknown>, ensure: (opts?: EnsureAttemptOptions) => Promise<void>) {
    sup = new DaemonLivenessSupervisor({
      socketPath: fx.socketPath,
      rpcTimeoutMs: 1_000,
      heartbeatMs: 5_000,
      respawnLockWaitMs: 1_000,
      lockPath: fx.lockPath,
      pidPath: fx.pidPath,
      _ensureDaemonRunning: ensure,
    });
    await sup.connect();
    sup.on("respawned", () => events.push("reconnected"));
    sup.on("respawnFailed", (err: Error) => events.push(`failed: ${err.message}`));
    await rm(fx.lockPath);
    await rm(fx.pidPath);
    await rm(fx.socketPath);
    fake = await serveDaemon(fx.socketPath, status);
    await fx.kill();
  }

  it("goes through ensure before reconnecting to an older daemon, so the bridge can replace it or warn", async () => {
    await dropConnectionTo({}, async (opts) => void events.push(`ensure ${JSON.stringify(opts)}`));
    await until(() => events.length >= 2);

    expect(events).toEqual(['ensure {"freshAttempt":true}', "reconnected"]);
    expect(sup!._statsForTest()).toMatchObject({ sigkillsIssued: 0, daemonRespawns: 0 });
  });

  it.each([
    ["no longer accepts this bridge", { appVersion: "99.0.0", minBridgeProtocolVersion: PROTOCOL_VERSION + 1 }],
    ["speaks a protocol too old for this bridge", { appVersion: APP_VERSION, version: 0 }],
  ])("goes through ensure, and does not reconnect, when the daemon %s", async (_situation, status) => {
    await dropConnectionTo(status, async () => {
      events.push("ensure");
      throw new Error("refused");
    });
    await until(() => events.length >= 2);

    expect(events).toEqual(["ensure", "failed: refused"]);
    expect(fake!.connections()).toBe(1);
  });

  it("reconnects to a current daemon without going through ensure", async () => {
    await dropConnectionTo({ appVersion: APP_VERSION }, async () => void events.push("ensure"));
    await until(() => events.length >= 1);

    expect(events).toEqual(["reconnected"]);
  });

  it("stays closed when it is closed while ensuring", async () => {
    let closing: Promise<void> | undefined;
    await dropConnectionTo({}, async () => {
      events.push("ensure");
      closing = sup!.close();
    });
    await until(() => closing !== undefined);
    await closing;

    expect(events).toEqual(["ensure"]);
    expect(fake!.connections()).toBe(1);
  });
});
