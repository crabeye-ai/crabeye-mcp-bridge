import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { bundleForSubprocess } from "../_helpers/subprocess-bundle.js";
import { until } from "../_helpers/daemon-fixtures.js";
import { STUB_STDIO_SERVER } from "../_helpers/stub-stdio-server.js";
import { exited, signalIfRunning } from "../_helpers/processes.js";
import { DaemonClient } from "../../src/daemon/client.js";
import { isServing, netTransport } from "../../src/daemon/net-transport.js";
import { getDaemonLogPath, getDaemonRunDir, getDaemonSocketPath } from "../../src/daemon/index.js";
import { DAEMON_LAUNCH_ARGS } from "../../src/daemon/daemon-identity.js";
import { AWAIT_PREDECESSOR_FLAG, successorReport } from "../../src/daemon/daemon-launch.js";
import { processExists } from "../../src/process/process-utils.js";
import { APP_VERSION, BRIDGE_CONFIG_FILENAME, CREDENTIALS_DIR } from "../../src/constants.js";

const execFileAsync = promisify(execFile);
const isWindows = process.platform === "win32";
const STAMP = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}`;
const LOG_LINE = new RegExp(String.raw`^${STAMP} \[(\d+)\] (DEBUG|INFO |WARN |ERROR) `);
const STAMP_ANYWHERE = new RegExp(String.raw`${STAMP} \[\d+\]`, "g");
const HOME_VARS = ["HOME", "USERPROFILE", "LOCALAPPDATA"] as const;
const SECRET = "marker-7d3a1f";
const QUICK_KILL = { daemon: { killGraceMs: 0 } };
const BRIDGE_PROTOCOL_VERSION = 2;

describe("the daemon's log file", { timeout: 60_000 }, () => {
  let cliScript: string;
  let home: string;
  let stub: string;
  const savedEnv: Partial<Record<(typeof HOME_VARS)[number], string>> = {};
  const clients: DaemonClient[] = [];
  const startedPids = new Set<number>();
  let nextSession = 1;
  let nextRpc = 1;

  beforeAll(async () => {
    if (isWindows && (await isServing(getDaemonSocketPath()))) {
      throw new Error("a crabeye daemon is already running for this user; stop it before running this test");
    }
    cliScript = await bundleForSubprocess("src/index.ts", "cli-daemon-log");
  });

  beforeEach(async () => {
    home = await mkdtemp(isWindows ? join(tmpdir(), "cbe-dl-") : "/tmp/cbe-dl-");
    for (const name of HOME_VARS) {
      savedEnv[name] = process.env[name];
      process.env[name] = name === "LOCALAPPDATA" ? join(home, "AppData", "Local") : home;
    }
    stub = join(home, "stub.cjs");
    await writeFile(stub, STUB_STDIO_SERVER);
    await writeBridgeConfig({ _bridge: QUICK_KILL });
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const pid of startedPids) signalIfRunning(pid, "SIGKILL");
    await until(() => [...startedPids].every((pid) => !processExists(pid)), 10_000).catch(() => {});
    startedPids.clear();
    for (const name of HOME_VARS) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }, 30_000);

  async function writeBridgeConfig(config: unknown): Promise<void> {
    await mkdir(join(home, CREDENTIALS_DIR), { recursive: true });
    await writeFile(join(home, CREDENTIALS_DIR, BRIDGE_CONFIG_FILENAME), typeof config === "string" ? config : JSON.stringify(config));
  }

  const expectedLogPath = () =>
    isWindows ? join(home, "AppData", "Local", "crabeye", "logs", "daemon.log") : join(home, ".crabeye", "logs", "daemon.log");
  const readLog = async () => readFile(getDaemonLogPath(), "utf8").catch(() => "");
  const logLines = async () => (await readLog()).split("\n").filter((line) => line.length > 0);
  const logged = async (text: string) => (await readLog()).includes(text);
  const lineWith = async (text: string) => (await logLines()).find((line) => line.includes(text));
  const lineFrom = async (pid: number | undefined, text: string) =>
    (await logLines()).find((line) => line.includes(`[${pid}]`) && line.includes(text));

  function expectWhole(line: string): void {
    expect(line).toMatch(LOG_LINE);
    expect(line.match(STAMP_ANYWHERE)).toHaveLength(1);
  }

  async function connect(): Promise<DaemonClient> {
    const client = new DaemonClient({ socketPath: getDaemonSocketPath(), transport: netTransport, rpcTimeoutMs: 5_000, connectTimeoutMs: 2_000 });
    await client.connect();
    clients.push(client);
    return client;
  }

  async function servingPid(): Promise<number | null> {
    try {
      const client = await connect();
      return ((await client.call("STATUS")) as { pid: number }).pid;
    } catch {
      return null;
    }
  }

  function launch(...flags: string[]): ChildProcess {
    return launchWith([], ...flags);
  }

  function launchWith(nodeArgs: string[], ...flags: string[]): ChildProcess {
    const child = spawn(process.execPath, [...nodeArgs, cliScript, ...DAEMON_LAUNCH_ARGS, ...flags], {
      env: { ...process.env },
      stdio: flags.includes(AWAIT_PREDECESSOR_FLAG) ? ["ignore", "ignore", "ignore", "ipc"] : "ignore",
      detached: true,
    });
    child.unref();
    if (child.pid !== undefined) startedPids.add(child.pid);
    return child;
  }

  async function waitUntilServedBy(pid: number): Promise<void> {
    await until(async () => (await servingPid()) === pid, 20_000);
  }

  async function startDaemon(): Promise<number> {
    const pid = launch().pid!;
    await waitUntilServedBy(pid);
    return pid;
  }

  function spec(overrides: { command?: string; args?: string[]; resolvedEnv?: Record<string, string> } = {}) {
    return {
      serverName: "stub",
      command: overrides.command ?? process.execPath,
      args: overrides.args ?? [stub],
      resolvedEnv: overrides.resolvedEnv ?? {},
      cwd: "",
      clientInfo: { name: "test-bridge", version: "0" },
      clientCapabilities: {},
      protocolVersion: "2025-06-18",
    };
  }

  function nextSessionId(): string {
    return `${String(nextSession++).padStart(8, "0")}-2222-2222-2222-222222222222`;
  }

  async function openStub(client: DaemonClient, overrides: Parameters<typeof spec>[0] = {}, sessionId = nextSessionId()): Promise<string> {
    await client.call("OPEN", { sessionId, bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION, spec: spec(overrides) });
    return sessionId;
  }

  function sendTool(client: DaemonClient, sessionId: string, name: string, args: Record<string, unknown>): number {
    const id = nextRpc++;
    client.sendNotification("RPC", { sessionId, payload: { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } } });
    return id;
  }

  async function callTool(client: DaemonClient, sessionId: string, name: string, args: Record<string, unknown>): Promise<void> {
    const answered = new Set<unknown>();
    client.setNotificationHandler((notif) => {
      const payload = (notif.params as { payload?: { id?: unknown } } | undefined)?.payload;
      if (notif.method === "RPC") answered.add(payload?.id);
    });
    const id = sendTool(client, sessionId, name, args);
    await until(() => answered.has(id), 10_000);
  }

  async function shutDown(pid: number): Promise<void> {
    await (await connect()).call("SHUTDOWN").catch(() => {});
    await until(() => !processExists(pid), 15_000);
  }

  interface StatusOutput {
    running: boolean;
    pid?: number;
    logFile?: string;
  }

  async function status(): Promise<StatusOutput> {
    const { stdout } = await execFileAsync(process.execPath, [cliScript, "daemon", "status"], { env: { ...process.env } });
    return JSON.parse(stdout) as StatusOutput;
  }

  async function waitForServingLineFrom(pid: number): Promise<void> {
    await until(async () => (await logLines()).some((line) => line.includes(`[${pid}]`) && line.endsWith("[daemon] serving")), 10_000);
  }

  it("records the daemon starting with its version and socket, a session opening and a child starting", async () => {
    const pid = await startDaemon();
    await openStub(await connect());

    await until(() => logged("child started"), 10_000);
    const start = await lineWith("daemon starting");
    expect(start).toContain(`[${pid}]`);
    expect(start).toContain(`version=${APP_VERSION}`);
    expect(start).toContain(`socket=${getDaemonSocketPath()}`);
    expect(await lineWith("session opened")).toMatch(new RegExp(`\\[daemon:stub\\] session opened .*bridgeProtocolVersion=${BRIDGE_PROTOCOL_VERSION}`));
    expect(await lineWith("child started")).toMatch(/\[daemon:stub\] child started pid=\d+/);
    for (const line of await logLines()) expectWhole(line);
  });

  it("records a child that exits on its own with its exit code", async () => {
    await startDaemon();
    const client = await connect();
    const sessionId = await openStub(client);

    sendTool(client, sessionId, "crash", { lines: [], code: 7 });

    await until(() => logged("child exited"), 10_000);
    expect(await lineWith("child exited")).toMatch(/\[daemon:stub\] child exited .*code=7/);
  });

  it("records a refused session with the reason", async () => {
    await startDaemon();

    await expect((await connect()).call("OPEN", {})).rejects.toThrow();

    await until(() => logged("session refused"), 10_000);
    expect(await lineWith("session refused")).toContain("reason=OPEN params malformed");
  });

  it("records child stderr with the server name at debug level", async () => {
    await writeBridgeConfig({ _bridge: { logLevel: "debug", ...QUICK_KILL } });
    await startDaemon();
    const client = await connect();
    const sessionId = await openStub(client);

    await callTool(client, sessionId, "stderr", { text: "warming the cache" });

    await until(() => logged("warming the cache"), 10_000);
    expect(await lineWith("warming the cache")).toMatch(/DEBUG \[stderr:stub\] warming the cache$/);
  });

  it("leaves child stderr out at the default level", async () => {
    const pid = await startDaemon();
    const client = await connect();
    const sessionId = await openStub(client);
    let forwarded = false;
    client.setNotificationHandler((notif) => {
      if (notif.method === "STDERR" && (notif.params as { line?: string }).line === "cache ready") forwarded = true;
    });
    sendTool(client, sessionId, "stderr", { text: "cache ready" });

    await until(() => forwarded, 10_000);
    await shutDown(pid);
    expect(await logged("cache ready")).toBe(false);
  });

  it("warns that it uses the defaults when its config can't be loaded, and still serves", async () => {
    await writeBridgeConfig("{ not json");

    await startDaemon();
    await openStub(await connect());

    await until(() => logged("child started"), 10_000);
    expect(await lineWith("could not load")).toMatch(/WARN {2}\[daemon\] could not load .*using defaults/);
  });

  it("keeps both daemons' lines whole and apart while a successor waits for its predecessor", async () => {
    const predecessor = await startDaemon();
    await openStub(await connect());
    const successor = launch(AWAIT_PREDECESSOR_FLAG, "20000");
    expect(await successorReport(successor)).toBe("waiting");

    await shutDown(predecessor);
    await until(() => logged("previous daemon gone; serving"), 20_000);

    const lines = await logLines();
    for (const line of lines) expectWhole(line);
    expect(new Set(lines.map((line) => Number(LOG_LINE.exec(line)![1])))).toEqual(new Set([predecessor, successor.pid]));
    expect(await lineFrom(successor.pid, "waiting for the previous daemon to exit")).toContain(`previousPid=${predecessor}`);
    expect(await lineFrom(predecessor, "daemon exited")).toBeDefined();
  });

  it("records taking over from a daemon that died", async () => {
    const dead = await startDaemon();
    signalIfRunning(dead, "SIGKILL");
    await until(() => !processExists(dead), 10_000);

    const successor = await startDaemon();

    const takeover = await lineWith("took over");
    expect(takeover).toContain(`[${successor}]`);
    expect(takeover).toContain(`took over from a previous daemon that is no longer running previousPid=${dead}`);
  });

  it("records deferring to a daemon that is already serving", async () => {
    await startDaemon();
    const second = launch();

    expect(await exited(second, 20_000)).toBe(0);
    expect(await lineFrom(second.pid, "deferring to existing daemon")).toBeDefined();
  });

  it("records a failed start and exits with code 1", async () => {
    await mkdir(dirname(getDaemonRunDir()), { recursive: true });
    await writeFile(getDaemonRunDir(), "not a directory");

    const daemon = launch();

    expect(await exited(daemon, 20_000)).toBe(1);
    expect(await lineWith("daemon failed to start")).toMatch(/ERROR \[daemon\] daemon failed to start: /);
  });

  it("still starts and serves when the log directory can't be created", async () => {
    await mkdir(dirname(dirname(getDaemonLogPath())), { recursive: true });
    await writeFile(dirname(getDaemonLogPath()), "not a directory");

    await startDaemon();
    const client = await connect();
    await openStub(client);

    expect(((await client.call("STATUS")) as { children: unknown[] }).children).toHaveLength(1);
  });

  it("names the log file in `daemon status`, running or not", async () => {
    expect(await status()).toEqual({ running: false, logFile: expectedLogPath() });

    const pid = await startDaemon();
    expect(await status()).toMatchObject({ running: true, pid, logFile: expectedLogPath() });
  });

  it("records the daemon stopping and why", async () => {
    const pid = await startDaemon();

    await shutDown(pid);

    expect(await lineWith("daemon stopping")).toContain("reason=shutdown requested");
    expect(await lineWith("daemon exited")).toContain("exitCode=0");
  });

  it.skipIf(isWindows)("records a signal as the reason it stopped", async () => {
    const pid = await startDaemon();
    await waitForServingLineFrom(pid);

    process.kill(pid, "SIGTERM");
    await until(() => !processExists(pid), 15_000);

    expect(await lineWith("daemon stopping")).toContain("reason=signal SIGTERM");
    expect(await lineWith("daemon exited")).toContain("exitCode=0");
  });

  it.skipIf(isWindows)("exits cleanly when signalled while waiting for its predecessor", async () => {
    const predecessor = await startDaemon();
    const successor = launch(AWAIT_PREDECESSOR_FLAG, "20000");
    expect(await successorReport(successor)).toBe("waiting");

    process.kill(successor.pid!, "SIGTERM");

    expect(await exited(successor, 15_000)).toBe(0);
    expect(await lineFrom(successor.pid, "daemon stopping")).toContain("reason=signal SIGTERM");
    expect(await lineFrom(successor.pid, "daemon exited")).toContain("exitCode=0");
    expect(await lineFrom(successor.pid, "failed to start")).toBeUndefined();
    expect(await servingPid()).toBe(predecessor);
  });

  it.skipIf(isWindows)("records a crash, stops the daemon because of it and exits with code 1", async () => {
    const crasher = join(home, "crash-on-usr2.cjs");
    await writeFile(crasher, `process.on("SIGUSR2", () => { throw new Error("injected crash"); });`);
    const daemon = launchWith(["--require", crasher]);
    await waitUntilServedBy(daemon.pid!);
    await waitForServingLineFrom(daemon.pid!);

    process.kill(daemon.pid!, "SIGUSR2");

    expect(await exited(daemon, 15_000)).toBe(1);
    expect(await lineWith("uncaughtException")).toMatch(/ERROR \[daemon\] uncaughtException: Error: injected crash/);
    expect(await lineWith("daemon stopping")).toContain("reason=crashed: injected crash");
    expect(await lineWith("daemon exited")).toContain("exitCode=1");
  });

  it("never writes a child's environment values or arguments, even at debug level", async () => {
    await writeBridgeConfig({ _bridge: { logLevel: "debug", ...QUICK_KILL } });
    await startDaemon();
    const client = await connect();
    const secretSpec = { resolvedEnv: { API_TOKEN: SECRET }, args: [stub, `--token=${SECRET}`] };
    const sessionId = await openStub(client, secretSpec);
    await callTool(client, sessionId, "plain", {});
    await expect(openStub(client, secretSpec, sessionId)).rejects.toThrow();
    await expect(openStub(client, { resolvedEnv: { API_TOKEN: `${SECRET}\0` } })).rejects.toThrow();
    await openStub(client, { command: join(home, "missing-command"), args: [`--token=${SECRET}`], resolvedEnv: { API_TOKEN: SECRET } }).catch(() => {});
    sendTool(client, sessionId, "crash", { lines: [], code: 2 });

    await until(async () => (await logLines()).some((line) => line.includes("child exited") && line.includes("code=2")), 10_000);
    expect(await logged("session refused")).toBe(true);
    expect(await readLog()).not.toContain(SECRET);
    expect(await readLog()).not.toMatch(/[0-9a-f]{64}|upstreamHash|groupId/);
  });
});
