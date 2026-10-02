import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFrame, FrameDecoder } from "../../src/daemon/protocol.js";
import { DaemonStdioClient } from "../../src/upstream/daemon-stdio-client.js";

const DAEMON_DOWN_ATTEMPTS = 6;

describe.skipIf(process.platform === "win32")("DaemonStdioClient during a daemon outage", () => {
  let dir: string;
  let sockPath: string;
  let server: Server | undefined;
  let client: DaemonStdioClient | undefined;
  const sockets = new Set<Socket>();

  beforeEach(async () => {
    dir = await mkdtemp("/tmp/cbe-daemon-outage-");
    sockPath = join(dir, "m.sock");
  });

  afterEach(async () => {
    for (const sock of sockets) sock.destroy();
    sockets.clear();
    await client?.close().catch(() => {});
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    client = undefined;
    server = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  function startDaemonStub(opens: unknown[]): Promise<void> {
    server = createServer((sock: Socket) => {
      sockets.add(sock);
      const decoder = new FrameDecoder();
      sock.on("data", (chunk: Buffer) => {
        decoder.push(chunk);
        for (let frame = decoder.next(); frame !== null; frame = decoder.next()) {
          const request = frame as { id?: string; method?: string };
          if (request.method !== "OPEN" || typeof request.id !== "string") continue;
          opens.push(frame);
          sock.write(encodeFrame({ id: request.id, result: { ok: true } }));
        }
      });
    });
    return new Promise<void>((resolve) => server!.listen(sockPath, resolve));
  }

  it("keeps asking for a daemon past the old five-attempt budget and opens a session once one answers", async () => {
    const opens: unknown[] = [];
    let ensureCalls = 0;
    client = new DaemonStdioClient({
      name: "local",
      config: { command: "node", args: ["-e", "0"] } as never,
      resolvedEnv: {},
      reconnectBaseDelay: 50,
      reconnectMaxDelay: 200,
      _socketPath: sockPath,
      _ensureDaemon: async () => {
        ensureCalls++;
        if (ensureCalls <= DAEMON_DOWN_ATTEMPTS) throw new Error("daemon did not become reachable");
        if (!server) await startDaemonStub(opens);
      },
    });

    void client.connect().catch(() => {});

    await vi.waitFor(() => expect(opens).toHaveLength(1), { timeout: 10_000 });
    expect(ensureCalls).toBe(DAEMON_DOWN_ATTEMPTS + 1);
  });
});
