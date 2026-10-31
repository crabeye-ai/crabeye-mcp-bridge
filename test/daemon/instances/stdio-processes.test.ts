import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { daemonStatus } from "../../../src/daemon/bootstrap.js";
import type { StatusResult } from "../../../src/daemon/protocol.js";
import { BRIDGE_CONFIG_FILENAME, CREDENTIALS_DIR, CREDENTIALS_FILENAME, DAEMON_DIR, DAEMON_RUN_SUBDIR, DAEMON_SOCKET_FILENAME } from "../../../src/constants.js";
import { CredentialStore } from "../../../src/credentials/credential-store.js";
import { createKeychainAdapter } from "../../../src/credentials/keychain.js";
import { processExists } from "../../../src/process/process-utils.js";
import { connectBridgeProcess, type BridgeProcess } from "../../_helpers/bridge-process.js";
import { until } from "../../_helpers/daemon-fixtures.js";
import { FAST_RECONNECT } from "../../_helpers/stdio-manager.js";
import { errorResult, viaRunTool } from "../../_helpers/run-tool.js";
import {
  MODERN_STUB_DISCOVER_LOG_ENV,
  MODERN_STUB_START_DELAY_ENV,
  readMethodLog,
  STUB_METHOD_LOG_ENV,
  STUB_STDIO_SERVER,
  STUB_STRICT_ENV,
} from "../../_helpers/stub-stdio-server.js";
import { bundleForSubprocess } from "../../_helpers/subprocess-bundle.js";

const MASTER_KEY = randomBytes(32).toString("hex");
const isWindows = process.platform === "win32";
const run = promisify(execFile);

describe("STDIO upstreams the manager runs for bridges", { timeout: 90_000 }, () => {
  let cliScript: string;
  let dir: string;
  let stub: string;
  let methodLog: string;
  let socketPath: string;
  const bridges: BridgeProcess[] = [];
  const stopped: number[] = [];
  let modernServer: string;

  beforeAll(async () => {
    [cliScript, modernServer] = await Promise.all([
      bundleForSubprocess("src/index.ts", "cli-stdio-instances"),
      bundleForSubprocess("test/_helpers/subprocess/modern-stdio-server.ts", "modern-stdio-server"),
    ]);
  }, 120_000);

  afterEach(async () => {
    for (const pid of stopped.splice(0)) if (processExists(pid)) process.kill(pid, "SIGKILL");
    await Promise.all(bridges.splice(0).map((bridge) => bridge.client.close().catch(() => {})));
    await run(process.execPath, [cliScript, "daemon", "stop"], { env: env() }).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }, 30_000);

  function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
    const inherited = { ...process.env };
    delete inherited.MCP_BRIDGE_CONFIG;
    return { ...inherited, HOME: dir, USERPROFILE: dir, LOCALAPPDATA: join(dir, "AppData", "Local"), MCP_BRIDGE_MASTER_KEY: MASTER_KEY, ...overrides };
  }

  async function workspace(daemon: Record<string, unknown> = {}): Promise<void> {
    dir = await mkdtemp(join(tmpdir(), "cbe-stdio-home-"));
    stub = join(dir, "stub.cjs");
    methodLog = join(dir, "methods.log");
    await writeFile(stub, STUB_STDIO_SERVER);
    socketPath = join(dir, DAEMON_DIR, DAEMON_RUN_SUBDIR, DAEMON_SOCKET_FILENAME);
    await mkdir(join(dir, CREDENTIALS_DIR));
    await writeFile(join(dir, CREDENTIALS_DIR, BRIDGE_CONFIG_FILENAME), JSON.stringify({ _bridge: { daemon: { killGraceMs: 0, ...daemon } } }));
  }

  function stubServer(extra: { args?: string[]; env?: Record<string, string> } = {}): Record<string, unknown> {
    return { command: process.execPath, args: [stub, ...(extra.args ?? [])], env: { [STUB_METHOD_LOG_ENV]: methodLog, ...extra.env }, _bridge: FAST_RECONNECT };
  }

  async function configFile(name: string, servers: Record<string, unknown>, bridge: Record<string, unknown> = {}): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, JSON.stringify({ mcpServers: servers, _bridge: bridge }));
    return path;
  }

  async function connect(configPath: string | null, overrides: Record<string, string> = {}): Promise<BridgeProcess> {
    const bridge = await connectBridgeProcess(cliScript, configPath, env(overrides));
    bridges.push(bridge);
    return bridge;
  }

  async function call(bridge: BridgeProcess, tool: string, args: Record<string, unknown> = {}, server = "stub") {
    return bridge.client.callTool(viaRunTool(`${server}__${tool}`, args));
  }

  async function text(bridge: BridgeProcess, tool: string, args: Record<string, unknown> = {}, server = "stub"): Promise<string> {
    const result = await call(bridge, tool, args, server);
    if (result.isError) throw new Error(JSON.stringify(result.content));
    return (result.content as Array<{ text: string }>)[0]!.text;
  }

  async function childEnv(bridge: BridgeProcess, server = "stub"): Promise<Record<string, string>> {
    return JSON.parse(await text(bridge, "env", {}, server)) as Record<string, string>;
  }

  async function status(): Promise<StatusResult> {
    const running = await daemonStatus(socketPath);
    if (running === null) throw new Error("no daemon answering");
    return running as StatusResult;
  }

  function methodsBy(pid: number): Promise<string[]> {
    return readMethodLog(methodLog, pid);
  }

  async function managerOtherThan(pid: number): Promise<StatusResult | null> {
    const running = await daemonStatus(socketPath).catch(() => null);
    return running !== null && (running as StatusResult).pid !== pid ? (running as StatusResult) : null;
  }

  describe("environment", () => {
    it("starts a child with the environment of the client, not the manager's, and the server's env, never the master key", async () => {
      await workspace();
      const config = await configFile("client.json", { stub: stubServer({ env: { FROM_SERVER: "s", MIXED_MARKER: "server" } }) });
      await run(process.execPath, [cliScript, "daemon", "start"], { env: env({ FROM_MANAGER: "m" }) });
      const managerPid = async () => JSON.parse((await run(process.execPath, [cliScript, "daemon", "status"], { env: env() })).stdout).pid as number;
      const started = await managerPid();
      const bridge = await connect(config, { FROM_CLIENT: "c", MiXeD_MARKER: "client" });

      const seen = await childEnv(bridge);

      expect(await managerPid()).toBe(started);
      expect(seen).toMatchObject({ FROM_CLIENT: "c", FROM_SERVER: "s" });
      expect(seen.FROM_MANAGER).toBeUndefined();
      expect(Object.keys(seen).filter((name) => name.toUpperCase() === "MCP_BRIDGE_MASTER_KEY")).toEqual([]);
      const markers = Object.entries(seen).filter(([name]) => name.toUpperCase() === "MIXED_MARKER");
      expect(markers).toEqual(isWindows ? [["MIXED_MARKER", "server"]] : [["MiXeD_MARKER", "client"], ["MIXED_MARKER", "server"]]);
    });

    it("resolves a stored credential in the server's env in the manager", async () => {
      await workspace();
      const store = new CredentialStore({ keychain: createKeychainAdapter({ env: { MCP_BRIDGE_MASTER_KEY: MASTER_KEY } }), filePath: join(dir, CREDENTIALS_DIR, CREDENTIALS_FILENAME) });
      await store.set("token", { type: "secret", value: "s3cret" });
      const config = await configFile("client.json", { stub: stubServer({ env: { TOKEN: "${credential:token}" } }) });
      const bridge = await connect(config);

      expect((await childEnv(bridge)).TOKEN).toBe("s3cret");
    });
  });

  describe.skipIf(isWindows)("sharing", () => {
    it("starts one child for two clients on one config, which initializes it and lists its tools once", async () => {
      await workspace();
      const config = await configFile("client.json", { stub: stubServer() });
      const first = await connect(config, { MARKER: "first" });
      expect(await text(first, "plain")).toBe("called plain");
      const second = await connect(config, { MARKER: "second" });
      expect(await text(second, "plain")).toBe("called plain");

      const { children } = await status();
      expect(children).toHaveLength(1);
      const methods = await methodsBy(children[0]!.pid);
      expect(methods.filter((method) => method === "initialize")).toHaveLength(1);
      expect(methods.filter((method) => method === "tools/list")).toHaveLength(1);
      expect((await childEnv(second)).MARKER).toBe("first");
    });

    it("shares one child between instances with the same server, and gives each instance's own server its client's environment", async () => {
      await workspace();
      const shared = stubServer();
      const a = await connect(await configFile("a.json", { stub: shared, own: stubServer({ args: ["--a"] }) }), { MARKER: "a" });
      expect(await text(a, "plain")).toBe("called plain");
      const b = await connect(await configFile("b.json", { stub: shared, own: stubServer({ args: ["--b"] }) }), { MARKER: "b" });
      expect(await text(b, "plain")).toBe("called plain");

      const { children, instances } = await status();
      expect(instances).toHaveLength(2);
      expect(children.filter((child) => child.serverName === "stub")).toEqual([expect.objectContaining({ instances: 2 })]);
      expect((await childEnv(a, "own")).MARKER).toBe("a");
      expect((await childEnv(b, "own")).MARKER).toBe("b");
      expect((await childEnv(b)).MARKER).toBe("a");
    });

    it("sends a line the child writes to stderr to each client's log at debug level", async () => {
      await workspace();
      const config = await configFile("client.json", { stub: stubServer() }, { logLevel: "debug" });
      const first = await connect(config);
      const second = await connect(config);
      await text(second, "plain");

      await text(first, "stderr", { text: "seen-by-every-client" });

      for (const bridge of [first, second]) await until(() => /DEBUG +\[upstream:stub\] seen-by-every-client/.test(bridge.stderr()), 10_000);
    });

    it("shares one child between clients on the default config", async () => {
      await workspace();
      const clientFile = await configFile("client.json", { stub: stubServer() });
      await writeFile(join(dir, CREDENTIALS_DIR, BRIDGE_CONFIG_FILENAME), JSON.stringify({ configPaths: [clientFile], _bridge: { daemon: { killGraceMs: 0 } } }));
      const first = await connect(null);
      expect(await text(first, "plain")).toBe("called plain");
      const second = await connect(null);
      expect(await text(second, "plain")).toBe("called plain");

      const { children, instances } = await status();
      expect(instances).toEqual([expect.objectContaining({ source: expect.objectContaining({ kind: "merged" }), bridges: 2 })]);
      expect(children).toHaveLength(1);
      const methods = await methodsBy(children[0]!.pid);
      expect(methods.filter((method) => method === "initialize")).toHaveLength(1);
      expect(methods.filter((method) => method === "tools/list")).toHaveLength(1);
    });

    it("lists the STDIO upstream with its type and state in daemon status", async () => {
      await workspace();
      const bridge = await connect(await configFile("client.json", { stub: stubServer() }));
      await text(bridge, "plain");

      const { stdout } = await run(process.execPath, [cliScript, "daemon", "status"], { env: env() });

      expect(JSON.parse(stdout).upstreams).toEqual([{ server: "stub", type: "stdio", state: "connected", instances: 1, upstreamHash: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    });

    it("restarts a child for daemon restart-upstream, and every client reconnects", async () => {
      await workspace();
      const config = await configFile("client.json", { stub: stubServer() });
      const first = await connect(config);
      const second = await connect(config);
      await text(first, "plain");
      const [before] = (await status()).children;

      await run(process.execPath, [cliScript, "daemon", "restart-upstream", before!.upstreamHash], { env: env() });

      await until(async () => (await status()).children[0]?.pid !== before!.pid, 10_000);
      expect(processExists(before!.pid)).toBe(false);
      await until(async () => (await call(first, "plain")).isError !== true, 10_000);
      await until(async () => (await call(second, "plain")).isError !== true, 10_000);
    });

    it("starts a child again in its new directory when the config changes its cwd", async () => {
      await workspace();
      const other = await mkdtemp(join(tmpdir(), "cbe-stdio-cwd-"));
      try {
        const config = await configFile("client.json", { stub: stubServer() });
        const bridge = await connect(config);
        await text(bridge, "plain");

        await writeFile(config, JSON.stringify({ mcpServers: { stub: { ...stubServer(), cwd: other } } }));

        await until(async () => (await call(bridge, "cwd")).isError !== true && (await text(bridge, "cwd")).endsWith(other.split("/").at(-1)!), 20_000);
      } finally {
        await rm(other, { recursive: true, force: true });
      }
    });
  });

  describe.skipIf(isWindows)("when the manager is replaced", () => {
    async function strictWorkspace(): Promise<{ first: BridgeProcess; second: BridgeProcess; oldChild: number }> {
      await workspace();
      const config = await configFile("client.json", { stub: stubServer({ env: { [STUB_STRICT_ENV]: "1" } }) }, { daemon: { heartbeatMs: 200, rpcTimeoutMs: 1_000 } });
      const first = await connect(config);
      const second = await connect(config);
      expect(await text(first, "plain")).toBe("called plain");
      expect(await text(second, "plain")).toBe("called plain");
      return { first, second, oldChild: (await status()).children[0]!.pid };
    }

    async function initializesTheNewChild(oldManager: number, oldChild: number, first: BridgeProcess, second: BridgeProcess): Promise<void> {
      await until(async () => (await managerOtherThan(oldManager)) !== null, 30_000);
      await until(async () => (await call(first, "plain")).isError !== true, 30_000);
      expect(await text(second, "plain")).toBe("called plain");
      const { children } = await status();
      expect(children).toHaveLength(1);
      await until(() => !processExists(oldChild), 10_000);
      const [child] = children;
      const methods = await methodsBy(child!.pid);
      const initialize = methods.indexOf("initialize");
      expect(methods.slice(0, initialize).every((method) => method === "server/discover")).toBe(true);
      expect(methods.filter((method) => method === "initialize")).toHaveLength(1);
      expect(methods[initialize + 1]).toBe("notifications/initialized");
    }

    it("initializes the new child once after the manager is killed, and both clients' calls succeed", async () => {
      const { first, second, oldChild } = await strictWorkspace();
      const { pid } = await status();

      process.kill(pid, "SIGKILL");

      await initializesTheNewChild(pid, oldChild, first, second);
    });

    it("does the same after the manager stalls", async () => {
      const { first, second, oldChild } = await strictWorkspace();
      const { pid } = await status();

      stopped.push(pid);
      process.kill(pid, "SIGSTOP");

      await initializesTheNewChild(pid, oldChild, first, second);
      expect(processExists(pid)).toBe(false);
    });

    it("does the same after the manager is shut down with clients attached", async () => {
      const { first, second, oldChild } = await strictWorkspace();
      const { pid } = await status();

      await run(process.execPath, [cliScript, "daemon", "stop"], { env: env() });

      await initializesTheNewChild(pid, oldChild, first, second);
    });

    it("fails a call in flight when the manager dies, and runs a later call once on the new manager", async () => {
      const { first } = await strictWorkspace();
      const { pid } = await status();
      const inFlight = call(first, "slow", { ms: 10_000 });
      await until(async () => (await methodsBy((await status()).children[0]!.pid)).includes("tools/call"), 10_000);

      process.kill(pid, "SIGKILL");

      expect(await inFlight).toMatchObject(errorResult('Upstream server "stub" error: daemon connection closed'));
      expect(await text(first, "stderr", { text: "once" })).toBe("written");
      const [child] = (await status()).children;
      expect((await methodsBy(child!.pid)).filter((method) => method === "tools/call")).toHaveLength(1);
    });
  });

  describe.skipIf(isWindows)("a server on the 2026-07-28 protocol", () => {
    let discoverLog: string;

    async function modernWorkspace(startDelayMs = 0): Promise<{ first: BridgeProcess; second: BridgeProcess }> {
      await workspace();
      discoverLog = join(dir, "discovers.log");
      const modern = {
        command: process.execPath,
        args: [modernServer],
        env: { [MODERN_STUB_DISCOVER_LOG_ENV]: discoverLog, [MODERN_STUB_START_DELAY_ENV]: String(startDelayMs) },
        _bridge: FAST_RECONNECT,
      };
      const config = await configFile("client.json", { modern }, { daemon: { heartbeatMs: 200, rpcTimeoutMs: 1_000 } });
      const first = await connect(config);
      const second = await connect(config);
      return { first, second };
    }

    const echoes = async (bridge: BridgeProcess) => (await call(bridge, "echo", {}, "modern").catch(() => ({ isError: true }))).isError !== true;
    const discoversBy = async (pid: number) => (await readFile(discoverLog, "utf-8").catch(() => "")).split("\n").filter((line) => line === String(pid)).length;

    it("shares one child, asking it once which protocol versions it speaks, and does so again for the new child after the manager is killed", async () => {
      const { first, second } = await modernWorkspace();
      await until(() => echoes(first), 20_000);
      await until(() => echoes(second), 20_000);
      const before = await status();
      expect(before.children).toEqual([expect.objectContaining({ serverName: "modern", era: "modern" })]);
      expect(await discoversBy(before.children[0]!.pid)).toBe(1);

      process.kill(before.pid, "SIGKILL");

      await until(async () => (await managerOtherThan(before.pid)) !== null, 30_000);
      await until(() => echoes(first), 30_000);
      expect(await echoes(second)).toBe(true);
      const after = await status();
      expect(after.children).toEqual([expect.objectContaining({ era: "modern" })]);
      expect(await discoversBy(after.children[0]!.pid)).toBe(1);
    });

    it("drops a tool the old child added once a new manager starts the server again", async () => {
      const { first } = await modernWorkspace();
      await until(() => echoes(first), 20_000);
      await call(first, "add-tool", {}, "modern");
      await until(async () => (await call(first, "added", {}, "modern")).isError !== true, 10_000);
      const { pid } = await status();

      process.kill(pid, "SIGKILL");

      await until(async () => (await managerOtherThan(pid)) !== null, 30_000);
      await until(() => echoes(first), 30_000);
      expect(await call(first, "added", {}, "modern")).toEqual(errorResult(`Upstream server "modern" error: Tool added not found`));
    });

    it("recovers from a second manager restart while the new child is still starting", async () => {
      const { first, second } = await modernWorkspace(3_000);
      await until(() => echoes(first), 20_000);
      const { pid } = await status();

      process.kill(pid, "SIGKILL");
      let next: StatusResult | null = null;
      await until(async () => ((next = await managerOtherThan(pid))?.children.length ?? 0) > 0, 30_000);
      const starting = next!.children[0]!.pid;
      expect(await discoversBy(starting)).toBe(0);
      process.kill(next!.pid, "SIGKILL");

      await until(async () => (await managerOtherThan(next!.pid)) !== null && (await managerOtherThan(pid)) !== null, 30_000);
      await until(() => echoes(first), 30_000);
      expect(await echoes(second)).toBe(true);
      expect((await status()).children).toHaveLength(1);
      await until(() => !processExists(starting), 10_000);
    });
  });
});
