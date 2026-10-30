import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { tellManagerAuthChanged } from "../../src/daemon/auth-changed.js";
import { ERROR_CODE_UNKNOWN_METHOD } from "../../src/daemon/protocol.js";
import { closeServer, ErrorReply, NO_REPLY, serveFrames, type FrameRequest } from "../_helpers/frame-server.js";
import { settledWithin } from "../_helpers/processes.js";
import { bundleForSubprocess } from "../_helpers/subprocess-bundle.js";

const run = promisify(execFile);
const constructed = vi.hoisted(() => [] as Array<{ connectTimeoutMs?: number; rpcTimeoutMs?: number }>);

vi.mock("../../src/daemon/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/daemon/client.js")>();
  class RecordingClient extends actual.DaemonClient {
    constructor(opts: ConstructorParameters<typeof actual.DaemonClient>[0]) {
      super(opts);
      constructed.push({ connectTimeoutMs: opts.connectTimeoutMs, rpcTimeoutMs: opts.rpcTimeoutMs });
    }
  }
  return { ...actual, DaemonClient: RecordingClient };
});

describe.skipIf(process.platform === "win32")("telling a running manager that a server's credentials changed", () => {
  let script: string;
  let dir: string;
  let socketPath: string;
  let server: Server | undefined;

  beforeAll(async () => {
    script = await bundleForSubprocess("test/_helpers/subprocess/tell-manager.ts", "tell-manager");
  }, 60_000);

  beforeEach(async () => {
    dir = await mkdtemp("/tmp/cbe-authchg-");
    socketPath = join(dir, "m.sock");
  });

  afterEach(async () => {
    if (server) await closeServer(server);
    server = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it("sends the server name to the manager and returns once the manager answers", async () => {
    const requests: FrameRequest[] = [];
    let answer!: (result: unknown) => void;
    server = await serveFrames(socketPath, (request) => {
      requests.push(request);
      return new Promise((resolve) => (answer = resolve));
    });
    const telling = tellManagerAuthChanged("svc", { socketPath });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(await settledWithin(telling, 100)).toBe(false);
    answer({ connections: 1 });
    await telling;

    expect(requests).toEqual([{ id: expect.any(String), method: "AUTH_CHANGED", params: { upstream: "svc" } }]);
  });

  it("returns at once, leaving nothing behind, when no manager is running", async () => {
    const startedAt = Date.now();

    await tellManagerAuthChanged("svc", { socketPath });

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(await readdir(dir)).toEqual([]);
  });

  it("returns quietly when the manager is too old to know the request", async () => {
    server = await serveFrames(socketPath, (request) => new ErrorReply(ERROR_CODE_UNKNOWN_METHOD, `unknown method "${request.method}"`));
    const startedAt = Date.now();

    await expect(tellManagerAuthChanged("svc", { socketPath })).resolves.toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("gives a manager 1.5 seconds to accept the connection and 3.5 more to answer by default", async () => {
    constructed.length = 0;

    await tellManagerAuthChanged("svc", { socketPath });

    expect(constructed).toEqual([{ connectTimeoutMs: 1_500, rpcTimeoutMs: 3_500 }]);
  });

  it("doesn't contact the manager when it is aborted before it starts", async () => {
    const requests: FrameRequest[] = [];
    server = await serveFrames(socketPath, (request) => void requests.push(request));
    const controller = new AbortController();
    controller.abort();

    await tellManagerAuthChanged("svc", { socketPath, signal: controller.signal });

    expect(requests).toEqual([]);
  });

  it("gives up after its timeout when the manager doesn't answer", async () => {
    server = await serveFrames(socketPath, () => NO_REPLY);
    const startedAt = Date.now();

    await tellManagerAuthChanged("svc", { socketPath, rpcTimeoutMs: 200 });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(190);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("stops waiting as soon as it is aborted", async () => {
    server = await serveFrames(socketPath, () => NO_REPLY);
    const controller = new AbortController();
    const startedAt = Date.now();
    setTimeout(() => controller.abort(), 100);

    await tellManagerAuthChanged("svc", { socketPath, signal: controller.signal });

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("lets the process exit after giving up, even when the manager never closes its side of the connection", async () => {
    const held: Socket[] = [];
    server = createServer({ allowHalfOpen: true }, (socket) => void held.push(socket));
    await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
    const startedAt = Date.now();

    try {
      const { stdout } = await run(process.execPath, [script, socketPath], { timeout: 10_000 });
      expect(stdout).toBe("returned\n");
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(held).toHaveLength(1);
    } finally {
      for (const socket of held) socket.destroy();
    }
  });
});
