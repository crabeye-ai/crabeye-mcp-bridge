import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Server } from "node:net";
import { DAEMON_CONNECTION_CLOSED, DaemonClient, DaemonRpcError } from "../../src/daemon/client.js";
import { ERROR_CODE_RPC_TIMEOUT } from "../../src/daemon/protocol.js";
import { netTransport } from "../../src/daemon/net-transport.js";
import { DROP_CONNECTION, NO_REPLY, closeServer, serveFrames } from "../_helpers/frame-server.js";
import { settledWithin } from "../_helpers/processes.js";

describe.skipIf(process.platform === "win32")("DaemonClient per-call timeout", () => {
  let dir: string;
  let server: Server;
  let client: DaemonClient;

  beforeEach(async () => {
    dir = await mkdtemp("/tmp/cbe-call-");
    const socketPath = join(dir, "d.sock");
    server = await serveFrames(socketPath, (request) => {
      if (request.method === "HANG") return NO_REPLY;
      if (request.method === "DROP") return DROP_CONNECTION;
      return { ok: true };
    });
    client = new DaemonClient({ socketPath, transport: netTransport, rpcTimeoutMs: 50, connectTimeoutMs: 1_000 });
    await client.connect();
  });

  afterEach(async () => {
    client.close();
    await closeServer(server);
    await rm(dir, { recursive: true, force: true });
  });

  it("waits past the client's RPC timeout when the call passes timeoutMs 0, until the connection closes", async () => {
    const call = client.call("HANG", undefined, { timeoutMs: 0 });
    call.catch(() => {});

    expect(await settledWithin(call, 200)).toBe(false);
    void client.call("DROP").catch(() => {});
    await expect(call).rejects.toThrow(DAEMON_CONNECTION_CLOSED);
  });

  it("uses the call's own timeout instead of the client's", async () => {
    const slowClientFastCall = new DaemonClient({
      socketPath: join(dir, "d.sock"),
      transport: netTransport,
      rpcTimeoutMs: 60_000,
      connectTimeoutMs: 1_000,
    });
    try {
      const startedAt = Date.now();
      const failure = await slowClientFastCall.call("HANG", undefined, { timeoutMs: 30 }).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(DaemonRpcError);
      expect((failure as DaemonRpcError).code).toBe(ERROR_CODE_RPC_TIMEOUT);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      slowClientFastCall.close();
    }
  });

  it("fails a call waiting with no timeout when the client is closed", async () => {
    const call = client.call("HANG", undefined, { timeoutMs: 0 });

    client.close();

    await expect(call).rejects.toThrow(DAEMON_CONNECTION_CLOSED);
  });

  it("still applies the client's RPC timeout to calls that don't set one", async () => {
    await expect(client.call("HANG")).rejects.toThrow(/timed out after 50ms/);
  });
});
