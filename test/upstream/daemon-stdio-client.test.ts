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
