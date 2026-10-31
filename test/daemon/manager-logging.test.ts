import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonStoppedWhileStartingError, ManagerDaemon, type ManagerOptions } from "../../src/daemon/manager.js";
import { isServing, netTransport } from "../../src/daemon/net-transport.js";
import { DaemonClient } from "../../src/daemon/client.js";
import type { ProcessTracker } from "../../src/daemon/process-tracker.js";
import { deadPid } from "../_helpers/processes.js";
import { AttachedBridge, fixtureSource, servingConfigs, spawnTestManager, until, type DaemonFixture } from "../_helpers/daemon-fixtures.js";
import { STUB_STDIO_SERVER } from "../_helpers/stub-stdio-server.js";
import { recordingLogger, type LoggedLine } from "../_helpers/spy-logger.js";

const isWindows = process.platform === "win32";
const SECRET = "marker-5f1c9e";
const FAST_RECONNECT = { reconnect: { reconnectBaseDelay: 100, reconnectMaxDelay: 1000 } };
const TAKEOVER = "took over from a previous daemon that is no longer running";

describe.skipIf(isWindows)("what the daemon logs", { timeout: 20_000 }, () => {
  let fx: DaemonFixture | undefined;
  let stubDir: string | undefined;
  let stub: string;
  let entries: LoggedLine[];
  const bridges: AttachedBridge[] = [];

  const extraManagers: ManagerDaemon[] = [];

  afterEach(async () => {
    for (const bridge of bridges.splice(0)) bridge.close();
    for (const manager of extraManagers.splice(0)) await manager.stop(0, "test cleanup");
    await fx?.stop();
    fx = undefined;
    if (stubDir !== undefined) await rm(stubDir, { recursive: true, force: true });
    stubDir = undefined;
    expect(JSON.stringify(entries ?? [])).not.toMatch(/[0-9a-f]{64}|"upstreamHash"|"groupId"/);
  });

  function managerBeside(fixture: DaemonFixture, log: LoggedLine[], opts: Partial<ManagerOptions> = {}): ManagerDaemon {
    const manager = new ManagerDaemon({
      socketPath: fixture.socketPath,
      pidPath: fixture.pidPath,
      lockPath: fixture.lockPath,
      idleMs: 60_000,
      transport: netTransport,
      processTrackerPath: join(fixture.dir, "processes.json"),
      logger: recordingLogger(log),
      ...opts,
    });
    extraManagers.push(manager);
    return manager;
  }

  async function startManager(manager: Partial<ManagerOptions> = {}, server: (stub: string) => Record<string, unknown> = stubServer): Promise<DaemonFixture> {
    entries = [];
    stubDir = await mkdtemp(join(tmpdir(), "cbe-log-stub-"));
    stub = join(stubDir, "stub.cjs");
    await writeFile(stub, STUB_STDIO_SERVER);
    fx = await spawnTestManager({ manager: { logger: recordingLogger(entries), ...servingConfigs({ [fixtureSource.path]: { stub: server(stub) } }), ...manager } });
    return fx;
  }

  function stubServer(path: string): Record<string, unknown> {
    return { command: process.execPath, args: [path], _bridge: FAST_RECONNECT };
  }

  async function attachStub(): Promise<AttachedBridge> {
    const bridge = await AttachedBridge.attach(fx!);
    bridges.push(bridge);
    await bridge.connected("stub");
    return bridge;
  }

  const find = (message: string, from: LoggedLine[] = entries) => from.filter((e) => e.message === message);
  const appears = (message: string) => until(() => find(message).length > 0);

  it("logs each session a bridge from crabeye-mcp-bridge 1.3.0 or earlier asks for as refused, saying to restart the AI client", async () => {
    await startManager();

    await expect(fx!.client.call("OPEN", { sessionId: "old", spec: {} })).rejects.toThrow("restart the AI client");

    expect(find("session refused")).toEqual([
      expect.objectContaining({ level: "warn", context: expect.objectContaining({ errorCode: "bridge_unsupported", reason: expect.stringContaining("restart the AI client") }) }),
    ]);
  });

  it("logs a child starting with its pid, and exiting on its own with its exit code", async () => {
    await startManager();
    const bridge = await attachStub();
    const pid = find("child started")[0].context.pid;
    expect(pid).toEqual(expect.any(Number));

    await bridge.callTool("stub", "crash", { lines: [], code: 3 }).catch(() => {});
    await appears("child exited");

    expect(find("child exited")[0].context).toMatchObject({ server: "stub", pid, cause: "exited", code: 3, signal: null });
    expect(find("child stopped")).toEqual([]);
  });

  it("logs a command that can't be started, and why", async () => {
    await startManager({}, () => ({ command: "/nonexistent/cbe-missing", _bridge: FAST_RECONNECT }));
    bridges.push(await AttachedBridge.attach(fx!));

    await appears("child exited");

    expect(find("child exited")[0].context).toMatchObject({ server: "stub", cause: "failed_to_start" });
    expect(entries.find((e) => e.message.startsWith("child error: "))?.message).toContain("ENOENT");
  });

  it("logs a child stopped for failing its pings, with the reason and how it ended", async () => {
    await startManager({ childPingMs: 50, childPingTimeoutMs: 50, childPingMaxConsecutiveFailures: 1 });
    const bridge = await attachStub();
    await bridge.callTool("stub", "ignore-pings");

    await appears("child stopped");

    expect(find("child stopped")[0].context).toMatchObject({ server: "stub", reason: "not answering pings", signal: "SIGTERM" });
  });

  it("logs an idle child being stopped once its last instance closes", async () => {
    await startManager({ graceMs: 0, idleMs: 50 });
    const bridge = await attachStub();

    bridge.close();
    await appears("child stopped");

    expect(find("child stopped")[0].context).toMatchObject({ server: "stub", reason: "idle" });
  });

  it("logs a restart as the reason a child was stopped", async () => {
    await startManager();
    await attachStub();
    const hash = ((await fx!.client.call("STATUS")) as { children: { upstreamHash: string }[] }).children[0].upstreamHash;

    await fx!.client.call("RESTART", { upstreamHash: hash });
    await appears("child stopped");

    expect(find("child stopped")[0].context).toMatchObject({ server: "stub", reason: "restart" });
  });

  it("logs the daemon shutting down as the reason its children stopped", async () => {
    await startManager();
    await attachStub();

    await fx!.client.call("SHUTDOWN");
    await fx!.manager.waitForExit();

    expect(find("child stopped")[0].context).toMatchObject({ server: "stub", reason: "shutdown" });
  });

  it("logs child stderr at debug level with the server name", async () => {
    await startManager();
    const bridge = await attachStub();

    await bridge.callTool("stub", "stderr", { text: "cache warmed" });
    await appears("cache warmed");

    expect(find("cache warmed")[0]).toEqual({
      level: "debug",
      message: "cache warmed",
      context: expect.objectContaining({ component: "stderr", server: "stub" }),
    });
  });

  it("logs why the daemon stopped and its exit code, when asked to shut down", async () => {
    await startManager();

    await fx!.client.call("SHUTDOWN");
    await fx!.manager.waitForExit();

    expect(find("daemon stopping")[0].context).toMatchObject({ reason: "shutdown requested" });
    expect(find("daemon exited")[0].context).toMatchObject({ exitCode: 0 });
  });

  it("logs idle as the reason when the daemon stops for lack of work", async () => {
    await startManager({ idleMs: 50 });
    fx!.client.close();

    await fx!.manager.waitForExit();

    expect(find("daemon stopping")[0].context).toMatchObject({ reason: "idle" });
  });

  it("logs that it is serving once started", async () => {
    await startManager();
    expect(find("serving")).toHaveLength(1);
  });

  it("logs the stop reason when another daemon takes its socket", async () => {
    await startManager({ publicationCheckMs: 20 });

    await unlink(fx!.socketPath);
    await fx!.manager.waitForExit();

    expect(find("daemon stopping")[0].context).toMatchObject({ reason: "another daemon owns the socket" });
  });

  it("logs taking over from a previous daemon whose recorded pid is gone", async () => {
    await startManager();
    await fx!.manager.stop(0, "test");
    const gone = deadPid();
    await fx!.writePidfile(gone);
    const log: LoggedLine[] = [];

    await managerBeside(fx!, log).start();

    expect(find(TAKEOVER, log)[0]?.context).toMatchObject({ previousPid: gone });
  });

  it("logs taking over the lock of a previous daemon that died before writing its pidfile", async () => {
    await startManager();
    await fx!.manager.stop(0, "test");
    const gone = deadPid();
    await writeFile(fx!.lockPath, `${gone}\n00000000-0000-0000-0000-000000000000\n`);
    const log: LoggedLine[] = [];

    await managerBeside(fx!, log).start();

    expect(find(TAKEOVER, log)[0]?.context).toMatchObject({ previousPid: gone });
  });

  it("doesn't log a takeover when the recorded daemon is still running", async () => {
    await startManager();
    await fx!.manager.stop(0, "test");
    await fx!.writePidfile(process.ppid);
    const log: LoggedLine[] = [];

    await managerBeside(fx!, log).start();

    expect(find(TAKEOVER, log)).toEqual([]);
  });

  it("logs a connection refused while starting at the connection cap", async () => {
    await startManager();
    await fx!.manager.stop(0, "test");
    const log: LoggedLine[] = [];
    const processTracker = {
      reapStale: async () => {
        const client = new DaemonClient({ socketPath: fx!.socketPath, transport: netTransport, rpcTimeoutMs: 1_000, connectTimeoutMs: 1_000 });
        await client.connect().catch(() => {});
        client.close();
        await until(() => find("connection refused", log).length > 0);
        return { total: 0, killed: 0, skipped: 0 };
      },
    } as unknown as ProcessTracker;

    await managerBeside(fx!, log, { processTracker, maxConnections: 0 }).start();

    expect(find("connection refused", log)[0].context).toMatchObject({ reason: "too many connections while starting" });
  });

  it("logs waiting for the previous daemon, then serving once it is gone", async () => {
    await startManager();
    const log: LoggedLine[] = [];
    const successor = managerBeside(fx!, log, { awaitPredecessorMs: 10_000 });

    const started = successor.start();
    await until(() => find("waiting for the previous daemon to exit", log).length > 0);
    await fx!.manager.stop(0, "test");
    await started;

    expect(log.map((e) => e.message)).toEqual(expect.arrayContaining(["waiting for the previous daemon to exit", "previous daemon gone; serving"]));
  });

  it("gives up starting when stopped while waiting for the previous daemon", async () => {
    await startManager();
    const log: LoggedLine[] = [];
    const successor = managerBeside(fx!, log, { awaitPredecessorMs: 10_000 });
    const started = successor.start();
    await until(() => find("waiting for the previous daemon to exit", log).length > 0);

    await successor.stop(0, "signal SIGTERM");

    await expect(started).rejects.toBeInstanceOf(DaemonStoppedWhileStartingError);
    expect(await successor.waitForExit()).toBe(0);
    expect(((await fx!.client.call("STATUS")) as { pid: number }).pid).toBe(process.pid);
    expect(log.map((e) => e.message)).not.toContain("lock was lost; leaving the pidfile in place");
  });

  it("stops reaping leaked children when stopped mid-start", async () => {
    await startManager();
    await fx!.manager.stop(0, "test");
    let stopSeenByReaper: boolean | undefined;
    const processTracker = {
      reapStale: async (shouldStop: () => boolean) => {
        void successor.stop(0, "signal SIGTERM");
        stopSeenByReaper = shouldStop();
        return { total: 0, killed: 0, skipped: 0 };
      },
    } as unknown as ProcessTracker;
    const successor = managerBeside(fx!, [], { processTracker });

    await expect(successor.start()).rejects.toBeInstanceOf(DaemonStoppedWhileStartingError);
    expect(stopSeenByReaper).toBe(true);
  });

  it("finishes giving up before stop resolves when stopped mid-start", async () => {
    await startManager();
    await fx!.manager.stop(0, "test");
    const log: LoggedLine[] = [];
    let releaseServer!: () => void;
    const serverHeld = new Promise<void>((resolve) => (releaseServer = resolve));
    const successor = managerBeside(fx!, log, {
      transport: {
        ...netTransport,
        createServer: (opts) => {
          const server = netTransport.createServer(opts);
          return {
            address: server.address,
            start: async () => {
              await serverHeld;
              await server.start();
            },
            stop: () => server.stop(),
            isPublished: () => server.isPublished(),
          };
        },
      },
    });

    let settledWhenStopped = false;
    const outcome = successor.start().catch((err: unknown) => {
      settledWhenStopped = true;
      return err;
    });
    setTimeout(releaseServer, 100);
    await successor.stop(0, "signal SIGTERM");
    expect(settledWhenStopped).toBe(true);
    expect(await outcome).toBeInstanceOf(DaemonStoppedWhileStartingError);
    expect(await isServing(fx!.socketPath)).toBe(false);
    await expect(stat(fx!.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(log.map((e) => e.message)).not.toContain("serving");
  });

  it("keeps a crash's exit code when a later stop asks for 0", async () => {
    await startManager();

    const stopping = fx!.manager.stop(1, "crashed: boom");
    await fx!.manager.stop(0, "signal SIGTERM");
    await stopping;

    expect(await fx!.manager.waitForExit()).toBe(1);
  });

  it("exits with the highest exit code asked for while stopping", async () => {
    await startManager();

    const stopping = fx!.manager.stop(0, "shutdown requested");
    await fx!.manager.stop(1, "crashed: boom");
    await stopping;

    expect(await fx!.manager.waitForExit()).toBe(1);
    expect(find("daemon exited")[0].context).toMatchObject({ exitCode: 1 });
  });

  it("logs output that isn't JSON by its size, never its content", async () => {
    await startManager({}, () => ({ command: process.execPath, args: ["-e", `process.stdout.write("ghp_${SECRET}\\n"); setInterval(() => {}, 1e6)`] }));
    bridges.push(await AttachedBridge.attach(fx!));

    await until(() => entries.some((e) => e.message.startsWith("child error: ") && e.message.includes("isn't JSON")));

    expect(entries.find((e) => e.message.startsWith("child error: ") && e.message.includes("isn't JSON"))).toMatchObject({
      level: "warn",
      message: `child error: child stdout produced a line that isn't JSON (${4 + SECRET.length} bytes)`,
      context: expect.objectContaining({ server: "stub" }),
    });
    expect(JSON.stringify(entries)).not.toContain(SECRET);
  });

  it("logs a connection refused at the connection cap", async () => {
    await startManager({ maxConnections: 1 });
    const extra = new DaemonClient({ socketPath: fx!.socketPath, transport: netTransport, rpcTimeoutMs: 1_000, connectTimeoutMs: 1_000 });
    await extra.connect().catch(() => {});
    extra.close();

    await appears("connection refused");

    expect(find("connection refused")[0]).toMatchObject({ level: "warn", context: expect.objectContaining({ reason: "manager at connection cap" }) });
  });

  it("logs that its lock was lost when it stops without it, and leaves the pidfile", async () => {
    await startManager();
    await unlink(fx!.lockPath);

    await fx!.manager.stop(0, "test");

    expect(find("lock was lost; leaving the pidfile in place")).toHaveLength(1);
    await expect(stat(fx!.pidPath)).resolves.toBeDefined();
  });

  it("never logs a child's environment or its arguments", async () => {
    await startManager({ graceMs: 0, idleMs: 50 }, (path) => ({ command: process.execPath, args: [path, `--token=${SECRET}`], env: { API_TOKEN: SECRET } }));
    const bridge = await AttachedBridge.attach(fx!, { childEnv: { ...(process.env as Record<string, string>), OTHER_TOKEN: SECRET } });
    await bridge.connected("stub");
    await bridge.callTool("stub", "plain");
    bridge.close();
    await appears("child stopped");

    expect(entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(entries)).not.toContain(SECRET);
  });
});
