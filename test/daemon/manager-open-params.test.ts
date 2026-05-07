import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createConnection } from "node:net";
import { ManagerDaemon } from "../../src/daemon/manager.js";
import { DaemonClient } from "../../src/daemon/client.js";
import { netTransport } from "../../src/daemon/net-transport.js";
import { encodeFrame, FrameDecoder } from "../../src/daemon/protocol.js";

const isWindows = process.platform === "win32";

async function tempPaths() {
  const dir = await mkdtemp("/tmp/cbe-mgr-open-params-");
  return {
    dir,
    sock: join(dir, "m.sock"),
    pid: join(dir, "m.pid"),
    lock: join(dir, "m.lock"),
    proc: join(dir, "processes.json"),
  };
}

describe.skipIf(isWindows)("OPEN params — Phase D fields", () => {
  let paths: Awaited<ReturnType<typeof tempPaths>>;
  let manager: ManagerDaemon | null = null;

  beforeEach(async () => {
    paths = await tempPaths();
    await mkdir(paths.dir, { recursive: true });
    manager = null;
  });
  afterEach(async () => {
    if (manager !== null) await manager.stop(0).catch(() => {});
    await rm(paths.dir, { recursive: true, force: true });
  });

  function freshManager(): ManagerDaemon {
    return new ManagerDaemon({
      socketPath: paths.sock,
      pidPath: paths.pid,
      lockPath: paths.lock,
      idleMs: 60_000,
      transport: netTransport,
      processTrackerPath: paths.proc,
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
  }

  it("rejects OPEN missing sharing field", async () => {
    manager = freshManager();
    await manager.start();
    const c = new DaemonClient({
      socketPath: paths.sock,
      transport: netTransport,
      rpcTimeoutMs: 1_000,
      connectTimeoutMs: 1_000,
    });
    try {
      await expect(
        c.call("OPEN", {
          sessionId: "11111111-1111-1111-1111-111111111111",
          spec: {
            serverName: "x",
            command: "node",
            args: [],
            resolvedEnv: {},
            cwd: "",
            // sharing missing
            clientInfo: { name: "b", version: "1" },
            clientCapabilities: {},
            protocolVersion: "2025-06-18",
          },
        }),
      ).rejects.toMatchObject({ code: "invalid_params" });
    } finally {
      c.close();
    }
  });

  it("rejects OPEN with bogus sharing value", async () => {
    manager = freshManager();
    await manager.start();
    const c = new DaemonClient({
      socketPath: paths.sock,
      transport: netTransport,
      rpcTimeoutMs: 1_000,
      connectTimeoutMs: 1_000,
    });
    try {
      await expect(
        c.call("OPEN", {
          sessionId: "11111111-1111-1111-1111-111111111111",
          spec: {
            serverName: "x",
            command: "node",
            args: [],
            resolvedEnv: {},
            cwd: "",
            sharing: "bogus",
            clientInfo: { name: "b", version: "1" },
            clientCapabilities: {},
            protocolVersion: "2025-06-18",
          },
        }),
      ).rejects.toMatchObject({ code: "invalid_params" });
    } finally {
      c.close();
    }
  });

  it("rejects OPEN with clientCapabilities exceeding 64KB", async () => {
    manager = freshManager();
    await manager.start();
    // The 64KB+ frame exceeds Node's default writableHighWaterMark (16KB), so
    // socket.write() returns false even though the data is queued and the
    // kernel send-buffer accommodates it. DaemonClient short-circuits on that
    // signal with `backpressure`, so we exercise the validation path via a
    // raw socket that awaits `drain` before reading the response.
    const big = "x".repeat(64 * 1024 + 1);
    const req = {
      id: "test-id-cap-1",
      method: "OPEN",
      params: {
        sessionId: "11111111-1111-1111-1111-111111111111",
        spec: {
          serverName: "x",
          command: "node",
          args: [],
          resolvedEnv: {},
          cwd: "",
          sharing: "auto",
          clientInfo: { name: "b", version: "1" },
          clientCapabilities: { huge: big },
          protocolVersion: "2025-06-18",
        },
      },
    };

    const sock = createConnection(paths.sock);
    try {
      await new Promise<void>((resolve, reject) => {
        sock.once("connect", resolve);
        sock.once("error", reject);
      });

      const frame = encodeFrame(req);
      const drained = sock.write(frame);
      if (!drained) {
        await new Promise<void>((resolve) => sock.once("drain", resolve));
      }

      const decoder = new FrameDecoder();
      const response = await new Promise<unknown>((resolve, reject) => {
        const onData = (chunk: Buffer): void => {
          try {
            decoder.push(chunk);
            const f = decoder.next();
            if (f !== null) {
              sock.off("data", onData);
              resolve(f);
            }
          } catch (err) {
            reject(err);
          }
        };
        sock.on("data", onData);
        sock.once("error", reject);
        const timer = setTimeout(() => reject(new Error("response timeout")), 5_000);
        if (typeof timer.unref === "function") timer.unref();
      });

      expect(response).toMatchObject({
        id: "test-id-cap-1",
        error: { code: "invalid_params" },
      });
    } finally {
      sock.destroy();
    }
  });
});
