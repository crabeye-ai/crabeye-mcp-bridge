import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { ManagerDaemon, LockBusyError } from "../../src/daemon/manager.js";
import { DaemonClient, DaemonRpcError } from "../../src/daemon/client.js";
import { netTransport } from "../../src/daemon/net-transport.js";

// macOS UDS sun_path is 104 bytes. Tests under $TMPDIR overflow that, so we
// stage sockets directly in /tmp where the path is short.
async function tempPaths(): Promise<{ dir: string; sock: string; pid: string; lock: string }> {
  const dir = await mkdtemp("/tmp/cbe-mgr-");
  return {
    dir,
    sock: join(dir, "m.sock"),
    pid: join(dir, "m.pid"),
    lock: join(dir, "m.lock"),
  };
}

const isWindows = process.platform === "win32";

describe.skipIf(isWindows)("ManagerDaemon (UDS)", () => {
  let paths: Awaited<ReturnType<typeof tempPaths>>;
  let manager: ManagerDaemon | null;

  beforeEach(async () => {
    paths = await tempPaths();
    await mkdir(paths.dir, { recursive: true });
    manager = null;
  });

  afterEach(async () => {
    if (manager !== null) {
      await manager.stop(0).catch(() => {
        /* ignore */
      });
    }
    await rm(paths.dir, { recursive: true, force: true });
  });

  it("STATUS returns version, pid, and empty children/sessions", async () => {
    manager = new ManagerDaemon({
      socketPath: paths.sock,
      pidPath: paths.pid,
      lockPath: paths.lock,
      idleMs: 60_000,
      transport: netTransport,
    });
    await manager.start();

    const client = new DaemonClient({
      socketPath: paths.sock,
      transport: netTransport,
      rpcTimeoutMs: 1_000,
      connectTimeoutMs: 1_000,
    });
    try {
      const result = (await client.call("STATUS")) as {
        uptime: number;
        pid: number;
        version: number;
        children: never[];
        sessions: never[];
      };
      expect(result.version).toBeGreaterThan(0);
      expect(result.pid).toBe(process.pid);
      expect(result.children).toEqual([]);
      expect(result.sessions).toEqual([]);
      expect(result.uptime).toBeGreaterThanOrEqual(0);
    } finally {
      client.close();
    }
  });

  it("OPEN with malformed params returns invalid_params", async () => {
    manager = new ManagerDaemon({
      socketPath: paths.sock,
      pidPath: paths.pid,
      lockPath: paths.lock,
      idleMs: 60_000,
      transport: netTransport,
      processTrackerPath: join(paths.dir, "processes.json"),
    });
    await manager.start();

    const client = new DaemonClient({
      socketPath: paths.sock,
      transport: netTransport,
      rpcTimeoutMs: 1_000,
      connectTimeoutMs: 1_000,
    });
    try {
      await expect(client.call("OPEN", { hash: "x" })).rejects.toMatchObject({
        code: "invalid_params",
      });
    } finally {
      client.close();
    }
  });

  it("RESTART still returns not_implemented in phase B", async () => {
    manager = new ManagerDaemon({
      socketPath: paths.sock,
      pidPath: paths.pid,
      lockPath: paths.lock,
      idleMs: 60_000,
      transport: netTransport,
      processTrackerPath: join(paths.dir, "processes.json"),
    });
    await manager.start();

    const client = new DaemonClient({
      socketPath: paths.sock,
      transport: netTransport,
      rpcTimeoutMs: 1_000,
      connectTimeoutMs: 1_000,
    });
    try {
      await expect(client.call("RESTART", {})).rejects.toMatchObject({
        code: "not_implemented",
      });
    } finally {
      client.close();
    }
  });

  it("two managers on the same lock — only one starts", async () => {
    manager = new ManagerDaemon({
      socketPath: paths.sock,
      pidPath: paths.pid,
      lockPath: paths.lock,
      idleMs: 60_000,
      transport: netTransport,
    });
    await manager.start();

    const second = new ManagerDaemon({
      socketPath: paths.sock + ".2",
      pidPath: paths.pid + ".2",
      lockPath: paths.lock, // same lock
      idleMs: 60_000,
      transport: netTransport,
    });
    await expect(second.start()).rejects.toBeInstanceOf(LockBusyError);
  });

  it("idle exit fires after idleMs with no active connections", async () => {
    manager = new ManagerDaemon({
      socketPath: paths.sock,
      pidPath: paths.pid,
      lockPath: paths.lock,
      idleMs: 100,
      transport: netTransport,
    });
    await manager.start();
    const exitCode = await manager.waitForExit();
    expect(exitCode).toBe(0);
    // Pidfile cleaned up.
    await expect(stat(paths.pid)).rejects.toMatchObject({ code: "ENOENT" });
    manager = null;
  });

  it("active connection blocks idle exit until it disconnects", async () => {
    manager = new ManagerDaemon({
      socketPath: paths.sock,
      pidPath: paths.pid,
      lockPath: paths.lock,
      idleMs: 100,
      transport: netTransport,
    });
    await manager.start();

    const client = new DaemonClient({
      socketPath: paths.sock,
      transport: netTransport,
      rpcTimeoutMs: 1_000,
      connectTimeoutMs: 1_000,
    });
    await client.connect();
    // Hold the connection open longer than idleMs and confirm the daemon
    // is still serving STATUS.
    await new Promise((r) => setTimeout(r, 300));
    const result = (await client.call("STATUS")) as { version: number };
    expect(result.version).toBeGreaterThan(0);
    client.close();

    // After close, idle timer should fire and the daemon should exit.
    const exitCode = await manager.waitForExit();
    expect(exitCode).toBe(0);
    manager = null;
  });

  it("SHUTDOWN RPC stops the daemon", async () => {
    manager = new ManagerDaemon({
      socketPath: paths.sock,
      pidPath: paths.pid,
      lockPath: paths.lock,
      idleMs: 60_000,
      transport: netTransport,
    });
    await manager.start();

    const client = new DaemonClient({
      socketPath: paths.sock,
      transport: netTransport,
      rpcTimeoutMs: 1_000,
      connectTimeoutMs: 1_000,
    });
    try {
      const ack = (await client.call("SHUTDOWN")) as { ok: boolean };
      expect(ack.ok).toBe(true);
    } finally {
      client.close();
    }

    const code = await manager.waitForExit();
    expect(code).toBe(0);
    manager = null;
  });

  it("invalid request shape produces invalid_request error", async () => {
    manager = new ManagerDaemon({
      socketPath: paths.sock,
      pidPath: paths.pid,
      lockPath: paths.lock,
      idleMs: 60_000,
      transport: netTransport,
    });
    await manager.start();

    const res = (await manager.handleRequest({} as never)) as { error?: { code?: string } };
    expect(res.error?.code).toBe("invalid_request");
  });

  it("unknown method produces unknown_method error", async () => {
    manager = new ManagerDaemon({
      socketPath: paths.sock,
      pidPath: paths.pid,
      lockPath: paths.lock,
      idleMs: 60_000,
      transport: netTransport,
    });
    await manager.start();

    const client = new DaemonClient({
      socketPath: paths.sock,
      transport: netTransport,
      rpcTimeoutMs: 1_000,
      connectTimeoutMs: 1_000,
    });
    try {
      const err = await client.call("WAT").catch((e) => e);
      expect(err).toBeInstanceOf(DaemonRpcError);
      expect((err as DaemonRpcError).code).toBe("unknown_method");
    } finally {
      client.close();
    }
  });

  it("idle exit is cancelled by reconnecting before the timeout", async () => {
    manager = new ManagerDaemon({
      socketPath: paths.sock,
      pidPath: paths.pid,
      lockPath: paths.lock,
      idleMs: 200,
      transport: netTransport,
    });
    await manager.start();

    // Reconnect repeatedly inside the idle window. The daemon must stay
    // alive across the whole loop.
    for (let i = 0; i < 4; i++) {
      const c = new DaemonClient({
        socketPath: paths.sock,
        transport: netTransport,
        rpcTimeoutMs: 500,
        connectTimeoutMs: 500,
      });
      await c.connect();
      await c.call("STATUS");
      c.close();
      await new Promise((r) => setTimeout(r, 100));
    }

    // We've spent >300 ms with multiple connect/disconnect cycles; daemon
    // should still be reachable.
    const c = new DaemonClient({
      socketPath: paths.sock,
      transport: netTransport,
      rpcTimeoutMs: 500,
      connectTimeoutMs: 500,
    });
    try {
      const status = (await c.call("STATUS")) as { version: number };
      expect(status.version).toBeGreaterThan(0);
    } finally {
      c.close();
    }
  });

  it("starts cleanly when a stale socket file already exists", async () => {
    // Simulate a crashed previous run that left the socket file behind.
    const { createServer } = await import("node:net");
    const stale = createServer();
    await new Promise<void>((r) => stale.listen(paths.sock, () => r()));
    await new Promise<void>((r) => stale.close(() => r()));
    // Re-create the file as a regular socket file by re-listening, then
    // unbinding without unlinking via destroy. To get a guaranteed leftover,
    // just `listen` again and close without unlink — node's `close()` does
    // unlink automatically. So instead, bind, get the path, and *don't*
    // close: kill the server's internal handle by force.
    // Simpler: assert the file is gone, then create an empty placeholder
    // socket file by listening + close() and re-creating quickly.
    const second = createServer();
    await new Promise<void>((r) => second.listen(paths.sock, () => r()));
    // Force-leave the socket file by destroying without close.
    second.unref();
    // Directly close the underlying handle without calling .close() so the
    // socket file is left on disk.
    (second as unknown as { _handle: { close: (cb: () => void) => void } })._handle?.close(() => {});

    manager = new ManagerDaemon({
      socketPath: paths.sock,
      pidPath: paths.pid,
      lockPath: paths.lock,
      idleMs: 60_000,
      transport: netTransport,
    });
    await manager.start();

    const client = new DaemonClient({
      socketPath: paths.sock,
      transport: netTransport,
      rpcTimeoutMs: 1_000,
      connectTimeoutMs: 1_000,
    });
    try {
      const r = (await client.call("STATUS")) as { version: number };
      expect(r.version).toBeGreaterThan(0);
    } finally {
      client.close();
    }
  });

  it("rejects a socket-path symlink (refuses to bind)", async () => {
    const { symlink } = await import("node:fs/promises");
    await symlink("/tmp/some-target-that-doesnt-matter", paths.sock);

    manager = new ManagerDaemon({
      socketPath: paths.sock,
      pidPath: paths.pid,
      lockPath: paths.lock,
      idleMs: 60_000,
      transport: netTransport,
    });
    await expect(manager.start()).rejects.toThrow(/symlink/);
    manager = null;
  });

  it("rejects a pidfile-path symlink (refuses to write)", async () => {
    const { symlink, writeFile } = await import("node:fs/promises");
    const target = `${paths.dir}/decoy`;
    await writeFile(target, "x");
    await symlink(target, paths.pid);

    manager = new ManagerDaemon({
      socketPath: paths.sock,
      pidPath: paths.pid,
      lockPath: paths.lock,
      idleMs: 60_000,
      transport: netTransport,
    });
    await expect(manager.start()).rejects.toThrow();
    // The decoy was not clobbered.
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(target, "utf-8")).toBe("x");
    manager = null;
  });
});

describe.skipIf(isWindows)("DaemonClient lifecycle", () => {
  let paths: Awaited<ReturnType<typeof tempPaths>>;
  let manager: ManagerDaemon | null;

  beforeEach(async () => {
    paths = await tempPaths();
    await mkdir(paths.dir, { recursive: true });
    manager = null;
  });

  afterEach(async () => {
    if (manager !== null) {
      await manager.stop(0).catch(() => {
        /* ignore */
      });
    }
    await rm(paths.dir, { recursive: true, force: true });
  });

  it("call() after close() rejects", async () => {
    manager = new ManagerDaemon({
      socketPath: paths.sock,
      pidPath: paths.pid,
      lockPath: paths.lock,
      idleMs: 60_000,
      transport: netTransport,
    });
    await manager.start();

    const client = new DaemonClient({
      socketPath: paths.sock,
      transport: netTransport,
      rpcTimeoutMs: 1_000,
      connectTimeoutMs: 1_000,
    });
    await client.connect();
    await client.call("STATUS");
    client.close();

    await expect(client.call("STATUS")).rejects.toThrow(/closed/);
  });
});
