import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { ManagerDaemon } from "../../src/daemon/manager.js";
import { ChildHandle, BackpressureError } from "../../src/daemon/child-handle.js";
import { netTransport } from "../../src/daemon/net-transport.js";
import { DaemonClient } from "../../src/daemon/client.js";
import {
  INNER_ERROR_CODE_BACKPRESSURE,
  type DaemonNotification,
} from "../../src/daemon/protocol.js";

const isWindows = process.platform === "win32";
const STUB = resolve(fileURLToPath(import.meta.url), "..", "..", "fixtures", "stub-mcp-child.mjs");

describe.skipIf(isWindows)("ChildHandle backpressure", () => {
  it("throws BackpressureError when one frame exceeds queueMaxBytes", async () => {
    let exited = false;
    const child = new ChildHandle({
      command: process.execPath,
      args: [STUB],
      env: { ...process.env, STUB_HANG_ON_INIT: "1" },
      queueMaxBytes: 50,
      onMessage: () => {},
      onClose: () => {
        exited = true;
      },
      onError: () => {},
    });

    // First call: payload ≈ 200+ bytes, far above the 50-byte cap.
    expect(() =>
      child.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "x", version: "1" } },
      }),
    ).toThrow(BackpressureError);

    // Child still alive (we threw before writing anything).
    expect(exited).toBe(false);

    await child.kill(500);
  });
});

describe.skipIf(isWindows)("daemon emits -32001 inner error on stdin backpressure", () => {
  let dir: string;
  let manager: ManagerDaemon;

  beforeEach(async () => {
    dir = await mkdtemp("/tmp/cbe-bp-mgr-");
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await manager?.stop(0).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  it(
    "an oversized RPC frame is bounced as a synthetic -32001 inner JSON-RPC error",
    async () => {
      const sock = join(dir, "m.sock");
      manager = new ManagerDaemon({
        socketPath: sock,
        pidPath: join(dir, "m.pid"),
        lockPath: join(dir, "m.lock"),
        idleMs: 60_000,
        transport: netTransport,
        processTrackerPath: join(dir, "processes.json"),
        // Tight cap: any tool/call frame is bigger than 100 bytes.
        _spawnChild: (spec, callbacks) =>
          new ChildHandle({
            command: spec.command,
            args: spec.args,
            env: { ...process.env, ...spec.resolvedEnv } as Record<string, string>,
            cwd: spec.cwd === "" ? undefined : spec.cwd,
            queueMaxBytes: 100,
            ...callbacks,
          }),
      });
      await manager.start();

      // Drive the protocol manually so we see the synthetic error frame land.
      const client = new DaemonClient({
        socketPath: sock,
        transport: netTransport,
        rpcTimeoutMs: 2_000,
        connectTimeoutMs: 1_000,
      });

      const inboundFrames: DaemonNotification[] = [];
      client.setNotificationHandler((notif) => {
        inboundFrames.push(notif);
      });

      await client.connect();

      const sessionId = randomUUID();
      const opened = await client.call("OPEN", {
        sessionId,
        spec: {
          serverName: "stub",
          command: process.execPath,
          args: [STUB],
          resolvedEnv: { STUB_HANG_ON_INIT: "1" },
          cwd: "",
          sharing: "auto" as const,
          clientInfo: { name: "test-bridge", version: "0.0.0" },
          clientCapabilities: {},
          protocolVersion: "2025-06-18",
        },
      });
      expect(opened).toMatchObject({ ok: true });

      // Send a tool/call frame that is comfortably larger than 100 bytes.
      const innerId = 42;
      const payload = {
        jsonrpc: "2.0",
        id: innerId,
        method: "tools/call",
        params: {
          name: "echo",
          arguments: {
            blob: "x".repeat(500),
          },
        },
      };
      client.sendNotification("RPC", { sessionId, payload });

      // Wait for the synthetic error to come back.
      const deadline = Date.now() + 2_000;
      let errorFrame: { params?: { payload?: { id?: number; error?: { code?: number } } } } | undefined;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
        const found = inboundFrames.find((f) => {
          const inner = (f.params as { payload?: { id?: number; error?: { code?: number } } } | undefined)?.payload;
          return inner?.id === innerId && inner?.error?.code === INNER_ERROR_CODE_BACKPRESSURE;
        });
        if (found) {
          errorFrame = found as typeof errorFrame;
          break;
        }
      }

      expect(errorFrame, "expected synthetic -32001 backpressure error frame").toBeDefined();
      expect(errorFrame!.params!.payload!.id).toBe(innerId);
      expect(errorFrame!.params!.payload!.error!.code).toBe(INNER_ERROR_CODE_BACKPRESSURE);

      await client.call("CLOSE", { sessionId }).catch(() => {});
      client.close();
    },
  );
});
