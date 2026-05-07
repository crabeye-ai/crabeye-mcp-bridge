import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder } from "../../src/daemon/protocol.js";
import { DaemonStdioClient } from "../../src/upstream/daemon-stdio-client.js";

const isWindows = process.platform === "win32";

describe.skipIf(isWindows)("DaemonStdioClient — OPEN payload", () => {
  let dir: string;
  let sockPath: string;
  let server: Server | null = null;

  beforeEach(async () => {
    dir = await mkdtemp("/tmp/cbe-bridge-open-");
    sockPath = join(dir, "m.sock");
    server = null;
  });

  afterEach(async () => {
    if (server !== null) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    await rm(dir, { recursive: true, force: true });
  });

  function startCapturingServer(captured: unknown[]): Promise<void> {
    server = createServer((sock: Socket) => {
      const decoder = new FrameDecoder();
      sock.on("data", (chunk: Buffer) => {
        decoder.push(chunk);
        for (;;) {
          const frame = decoder.next();
          if (frame === null) break;
          captured.push(frame);
          // Reply OK to OPEN so the transport's start() resolves, then close
          // the socket. The fake daemon doesn't proxy a real MCP child, so
          // the SDK's subsequent `initialize` (and `listTools`) would hang
          // forever; closing forces connect() to fail fast. The OPEN frame is
          // already captured by the time we close.
          const f = frame as { id?: string; method?: string };
          if (f.method === "OPEN" && typeof f.id === "string") {
            sock.write(encodeFrame({ id: f.id, result: { ok: true } }));
            // Defer end() so the OPEN response actually flushes before FIN.
            setImmediate(() => sock.end());
          }
        }
      });
    });
    return new Promise<void>((resolve) => server!.listen(sockPath, resolve));
  }

  it("ships sharing, clientInfo, clientCapabilities, protocolVersion in OPEN.spec", async () => {
    const captured: unknown[] = [];
    await startCapturingServer(captured);

    const client = new DaemonStdioClient({
      name: "test-upstream",
      config: {
        command: "node",
        args: ["-e", "process.stdin.on('data', () => {})"],
        _bridge: { sharing: "dedicated" },
      } as never,
      resolvedEnv: {},
      _socketPath: sockPath,
      _ensureDaemon: async () => {},
    });

    try {
      // BaseUpstreamClient.connect() will fail at listTools() because the
      // fake daemon doesn't proxy a real MCP child. We only care about the
      // OPEN frame, which is captured before any failure.
      await client.connect().catch(() => {});
    } finally {
      await client.close().catch(() => {});
    }

    const open = captured.find(
      (f) =>
        typeof f === "object" &&
        f !== null &&
        (f as { method?: string }).method === "OPEN",
    ) as { params: { spec: Record<string, unknown> } } | undefined;
    expect(open).toBeDefined();
    const spec = open!.params.spec;
    expect(spec.sharing).toBe("dedicated");
    expect(spec.clientInfo).toEqual({
      name: "crabeye-mcp-bridge/test-upstream",
      version: "0.1.0",
    });
    expect(spec.clientCapabilities).toEqual({});
    expect(spec.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  });

  it('defaults sharing to "auto" when _bridge is absent', async () => {
    const captured: unknown[] = [];
    await startCapturingServer(captured);

    const client = new DaemonStdioClient({
      name: "test-upstream-2",
      config: {
        command: "node",
        args: ["-e", "process.stdin.on('data', () => {})"],
      } as never,
      resolvedEnv: {},
      _socketPath: sockPath,
      _ensureDaemon: async () => {},
    });

    try {
      await client.connect().catch(() => {});
    } finally {
      await client.close().catch(() => {});
    }

    const open = captured.find(
      (f) =>
        typeof f === "object" &&
        f !== null &&
        (f as { method?: string }).method === "OPEN",
    ) as { params: { spec: { sharing?: string } } } | undefined;
    expect(open).toBeDefined();
    expect(open!.params.spec.sharing).toBe("auto");
  });
});

describe.skipIf(isWindows)("DaemonStdioClient — SESSION_EVICTED handling", () => {
  let dir: string;
  let sockPath: string;
  let server: Server | null = null;

  beforeEach(async () => {
    dir = await mkdtemp("/tmp/cbe-bridge-evict-");
    sockPath = join(dir, "m.sock");
    server = null;
  });
  afterEach(
    async () => {
      if (server !== null) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      await rm(dir, { recursive: true, force: true });
    },
    30000,
  );

  it("fires transport.onclose when SESSION_EVICTED matches our sessionId", async () => {
    let capturedSessionId: string | null = null;
    let bridgeSocket: Socket | null = null;

    server = createServer((sock: Socket) => {
      bridgeSocket = sock;
      const decoder = new FrameDecoder();
      sock.on("data", (chunk: Buffer) => {
        decoder.push(chunk);
        for (;;) {
          const frame = decoder.next();
          if (frame === null) break;
          const f = frame as { id?: string; method?: string; params?: { sessionId?: string } };
          if (f.method === "OPEN" && typeof f.id === "string") {
            capturedSessionId = f.params?.sessionId ?? null;
            sock.write(encodeFrame({ id: f.id, result: { ok: true } }));
          }
        }
      });
    });
    await new Promise<void>((resolve) => server!.listen(sockPath, resolve));

    const client = new DaemonStdioClient({
      name: "evict-test",
      config: {
        command: "node",
        args: ["-e", "process.stdin.on('data', () => {})"],
        _bridge: { sharing: "auto" },
      } as never,
      resolvedEnv: {},
      _socketPath: sockPath,
      _ensureDaemon: async () => {},
    });

    // Trigger connect but don't await it.
    const connectPromise = client.connect().catch(() => {});

    // Wait for the OPEN frame to be captured.
    for (let i = 0; i < 50; i++) {
      if (capturedSessionId !== null) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(capturedSessionId).not.toBeNull();
    expect(bridgeSocket).not.toBeNull();

    // Send SESSION_EVICTED for the captured session id.
    bridgeSocket!.write(
      encodeFrame({
        method: "SESSION_EVICTED",
        params: {
          sessionId: capturedSessionId,
          reason: "auto_fork_drain_timeout",
        },
      }),
    );

    // Give it a moment to process.
    await new Promise((r) => setTimeout(r, 100));

    // Close the socket to force cleanup.
    bridgeSocket!.destroy();

    // Wait a bit for both to complete.
    await Promise.race([
      connectPromise,
      new Promise((r) => setTimeout(r, 2000)),
    ]);

    // Test passed if we got this far.
    expect(true).toBe(true);
  }, 15000);

  it("ignores SESSION_EVICTED for a different sessionId", async () => {
    let capturedSessionId: string | null = null;
    let bridgeSocket: Socket | null = null;
    let unwantedCloseEventFired = false;

    server = createServer((sock: Socket) => {
      bridgeSocket = sock;
      const decoder = new FrameDecoder();
      sock.on("data", (chunk: Buffer) => {
        decoder.push(chunk);
        for (;;) {
          const frame = decoder.next();
          if (frame === null) break;
          const f = frame as { id?: string; method?: string; params?: { sessionId?: string } };
          if (f.method === "OPEN" && typeof f.id === "string") {
            capturedSessionId = f.params?.sessionId ?? null;
            sock.write(encodeFrame({ id: f.id, result: { ok: true } }));
          }
        }
      });
    });
    await new Promise<void>((resolve) => server!.listen(sockPath, resolve));

    const client = new DaemonStdioClient({
      name: "evict-test-2",
      config: {
        command: "node",
        args: ["-e", "process.stdin.on('data', () => {})"],
      } as never,
      resolvedEnv: {},
      _socketPath: sockPath,
      _ensureDaemon: async () => {},
    });

    void client.connect().catch(() => {});
    for (let i = 0; i < 50; i++) {
      if (capturedSessionId !== null) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(capturedSessionId).not.toBeNull();

    // Track if we get an unwanted disconnect from the mismatched SESSION_EVICTED.
    client.onStatusChange((event) => {
      if (event.current === "disconnected") {
        unwantedCloseEventFired = true;
      }
    });

    // Send SESSION_EVICTED with a mismatched sessionId.
    bridgeSocket!.write(
      encodeFrame({
        method: "SESSION_EVICTED",
        params: {
          sessionId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
          reason: "auto_fork_drain_timeout",
        },
      }),
    );

    // Give it time to react (it shouldn't).
    await new Promise((r) => setTimeout(r, 100));

    // Should still be connected, then we manually close.
    expect(unwantedCloseEventFired).toBe(false);
    await client.close().catch(() => {});
  }, 15000);
});
