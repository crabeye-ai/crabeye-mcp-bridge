import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { daemonStatus } from "../../../src/daemon/bootstrap.js";
import type { StatusResult } from "../../../src/daemon/protocol.js";
import {
  APP_VERSION,
  BRIDGE_CONFIG_FILENAME,
  CREDENTIALS_DIR,
  DAEMON_DIR,
  DAEMON_LOCK_FILENAME,
  DAEMON_RUN_SUBDIR,
  DAEMON_SOCKET_FILENAME,
} from "../../../src/constants.js";
import { processExists } from "../../../src/process/process-utils.js";
import { connectBridgeProcess, type BridgeProcess } from "../../_helpers/bridge-process.js";
import { ECHOED, startCountingUpstream, type CountingUpstream } from "../../_helpers/counting-http-upstream.js";
import { until } from "../../_helpers/daemon-fixtures.js";
import { installReleasedBridge, releasedBridgeAt } from "../../_helpers/released-bridge.js";
import { errorResult, viaRunTool } from "../../_helpers/run-tool.js";
import { STUB_STDIO_SERVER } from "../../_helpers/stub-stdio-server.js";
import { bundleForSubprocess } from "../../_helpers/subprocess-bundle.js";

const MASTER_KEY = randomBytes(32).toString("hex");
const run = promisify(execFile);

describe.skipIf(process.platform === "win32")("bridges sharing HTTP upstreams through the daemon", { timeout: 90_000 }, () => {
  let cliScript: string;
  let dir: string;
  let socketPath: string;
  const scripts = new Set<string>();
  const bridges: BridgeProcess[] = [];
  const upstreams: CountingUpstream[] = [];

  beforeAll(async () => {
    [cliScript] = await Promise.all([bundleForSubprocess("src/index.ts", "cli-http-instances"), installReleasedBridge("1.3.0")]);
  }, 180_000);

  afterEach(async () => {
    await Promise.all(bridges.splice(0).map((bridge) => bridge.client.close().catch(() => {})));
    for (const script of scripts) await run(process.execPath, [script, "daemon", "stop"], { env: env() }).catch(() => {});
    scripts.clear();
    await Promise.all(upstreams.splice(0).map((upstream) => upstream.close()));
    await rm(dir, { recursive: true, force: true });
  }, 30_000);

  function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
    const inherited = { ...process.env };
    delete inherited.MCP_BRIDGE_CONFIG;
    return { ...inherited, HOME: dir, MCP_BRIDGE_MASTER_KEY: MASTER_KEY, ...overrides };
  }

  async function workspace(servers: Record<string, unknown>): Promise<string> {
    dir = await mkdtemp("/tmp/cbe-home-");
    socketPath = join(dir, DAEMON_DIR, DAEMON_RUN_SUBDIR, DAEMON_SOCKET_FILENAME);
    await mkdir(join(dir, CREDENTIALS_DIR));
    await writeFile(join(dir, CREDENTIALS_DIR, BRIDGE_CONFIG_FILENAME), JSON.stringify({ _bridge: { daemon: { killGraceMs: 0 } } }));
    const configPath = join(dir, "client.json");
    await writeFile(configPath, JSON.stringify({ mcpServers: servers }));
    return configPath;
  }

  async function upstream(options: Parameters<typeof startCountingUpstream>[0] = {}): Promise<CountingUpstream> {
    const started = await startCountingUpstream(options);
    upstreams.push(started);
    return started;
  }

  async function connect(configPath: string | null, script = cliScript, overrides: Record<string, string> = {}): Promise<BridgeProcess> {
    scripts.add(script);
    const bridge = await connectBridgeProcess(script, configPath, env(overrides));
    bridges.push(bridge);
    return bridge;
  }

  async function runTool(bridge: BridgeProcess, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return bridge.client.callTool(viaRunTool(name, args));
  }

  async function status(): Promise<StatusResult> {
    const running = await daemonStatus(socketPath);
    if (running === null) throw new Error("no daemon answering");
    return running as StatusResult;
  }

  async function cliStatus(): Promise<{ instances: unknown; httpUpstreams: unknown }> {
    const { stdout } = await run(process.execPath, [cliScript, "daemon", "status"], { env: env() });
    return JSON.parse(stdout);
  }

  async function searchedTools(bridge: BridgeProcess, provider: string): Promise<string[]> {
    const result = (await bridge.client.callTool({ name: "search_tools", arguments: { queries: [{ provider, expand_tools: true }] } })) as {
      content: Array<{ text: string }>;
    };
    const { results } = JSON.parse(result.content[0]!.text) as { results: Array<{ providers: Array<{ tools: Array<{ tool_name: string }> }> }> };
    return results.flatMap((r) => r.providers.flatMap((p) => p.tools.map((tool) => tool.tool_name))).sort();
  }

  it.each(["modern", "legacy"] as const)("starts the daemon for an HTTP-only config and gives two clients one %s connection, shown by daemon status", async (era) => {
    const server = await upstream({ era });
    const configPath = await workspace({ svc: { url: server.url } });
    const [a, b] = [await connect(configPath), await connect(configPath)];

    expect(await runTool(a, "svc__echo")).toMatchObject({ content: ECHOED });
    expect(await runTool(b, "svc__echo")).toMatchObject({ content: ECHOED });
    expect(await searchedTools(a, "svc")).toEqual(["svc__echo", "svc__slow"]);
    expect(await searchedTools(b, "svc")).toEqual(["svc__echo", "svc__slow"]);

    expect(server.count("tools/list")).toBe(1);
    if (era === "legacy") expect(server.sessions()).toBe(1);
    await until(async () => (await status()).instances[0]?.bridges === 2, 10_000);
    expect(await cliStatus()).toMatchObject({
      instances: [{ config: configPath, kind: "file", bridges: 2, servers: ["svc"] }],
      httpUpstreams: [{ server: "svc", state: "connected", instances: 1 }],
    });
  });

  it("gives two clients on the default config, which lists their client file, one connection", async () => {
    const server = await upstream();
    const clientFile = await workspace({ svc: { url: server.url } });
    const bridgeConfigPath = join(dir, CREDENTIALS_DIR, BRIDGE_CONFIG_FILENAME);
    await writeFile(bridgeConfigPath, JSON.stringify({ configPaths: [clientFile], _bridge: { daemon: { killGraceMs: 0 } } }));
    const [a, b] = [await connect(null), await connect(null)];

    expect(await runTool(a, "svc__echo")).toMatchObject({ content: ECHOED });
    expect(await runTool(b, "svc__echo")).toMatchObject({ content: ECHOED });

    expect(server.count("tools/list")).toBe(1);
    await until(async () => (await status()).instances[0]?.bridges === 2, 10_000);
    expect(await cliStatus()).toMatchObject({
      instances: [{ config: bridgeConfigPath, kind: "merged", bridges: 2, servers: ["svc"] }],
      httpUpstreams: [{ server: "svc", state: "connected", instances: 1 }],
    });
  });

  it("starts the daemon without the NODE_OPTIONS of the bridge that started it", async () => {
    const server = await upstream();
    const configPath = await workspace({ svc: { url: server.url } });
    const marker = join(dir, "marker.cjs");
    const ran = join(dir, "ran.txt");
    await writeFile(marker, `require("node:fs").appendFileSync(${JSON.stringify(ran)}, process.pid + "\\n");`);
    const bridge = await connect(configPath, cliScript, { NODE_OPTIONS: `--require ${marker}` });

    expect(await runTool(bridge, "svc__echo")).toMatchObject({ content: ECHOED });

    const { pid } = await status();
    const pids = (await readFile(ran, "utf8")).trim().split("\n").map(Number);
    expect(pids.length).toBeGreaterThan(0);
    expect(pids).not.toContain(pid);
    expect(bridge.stderr()).toContain("the manager doesn't apply --require to the HTTP and SSE upstreams it connects");
    expect(bridge.stderr()).not.toContain(marker);
  });

  it("gives a client whose entry sets another master key its own instance and connection", async () => {
    const server = await upstream();
    const configPath = await workspace({ svc: { url: server.url } });
    const a = await connect(configPath);
    const b = await connect(configPath, cliScript, { MCP_BRIDGE_MASTER_KEY: randomBytes(32).toString("hex") });

    expect(await runTool(a, "svc__echo")).toMatchObject({ content: ECHOED });
    expect(await runTool(b, "svc__echo")).toMatchObject({ content: ECHOED });

    expect(server.count("tools/list")).toBe(2);
    expect((await status()).instances).toHaveLength(2);
  });

  it("reports a daemon that can't start for an HTTP upstream the way it does for a STDIO one", async () => {
    const server = await upstream();
    const configPath = await workspace({ svc: { url: server.url } });
    const stub = join(dir, "stub.cjs");
    await writeFile(stub, STUB_STDIO_SERVER);
    await writeFile(configPath, JSON.stringify({ mcpServers: { svc: { url: server.url }, stub: { command: process.execPath, args: [stub] } } }));
    await mkdir(join(dir, DAEMON_DIR, DAEMON_RUN_SUBDIR, DAEMON_LOCK_FILENAME), { recursive: true });
    const bridge = await connect(configPath);
    const failure = (name: string) => new RegExp(`\\[upstream:${name}\\] failed to connect: (.+)`).exec(bridge.stderr())?.[1];
    await until(() => failure("svc") !== undefined && failure("stub") !== undefined, 20_000);

    expect(failure("svc")).toBe("daemon did not become reachable within timeout");
    expect(failure("svc")).toBe(failure("stub"));
    expect(await searchedTools(bridge, "svc")).toEqual([]);
    expect(await searchedTools(bridge, "stub")).toEqual([]);
    const [http, stdio] = await Promise.all([runTool(bridge, "svc__echo"), runTool(bridge, "stub__plain")]);
    expect(http).toEqual(errorResult('Upstream server "svc" is unavailable; reconnecting in the background. Please retry shortly.'));
    expect(stdio).toEqual(errorResult('Upstream server "stub" is unavailable; reconnecting in the background. Please retry shortly.'));
    expect(server.count("tools/list")).toBe(0);
  });

  it("fails a call in flight with the daemon error when the daemon is killed, and serves the next call from a new daemon", async () => {
    const server = await upstream();
    const configPath = await workspace({ svc: { url: server.url } });
    const bridge = await connect(configPath);
    expect(await runTool(bridge, "svc__echo")).toMatchObject({ content: ECHOED });
    const killed = (await status()).pid;
    const inFlight = runTool(bridge, "svc__slow");
    await until(() => server.count("tools/call") === 2, 10_000);

    process.kill(killed, "SIGKILL");

    expect(await inFlight).toEqual(errorResult('Upstream server "svc" error: daemon connection closed'));
    expect(await runTool(bridge, "svc__echo")).toMatchObject({ content: ECHOED });
    expect((await status()).pid).not.toBe(killed);
  });

  it("works beside a bridge from crabeye 1.3.0, which keeps its own connection", async () => {
    const server = await upstream();
    const configPath = await workspace({ svc: { url: server.url } });
    const released = await releasedBridgeAt("1.3.0", join(dir, "crabeye-1.3.0"));
    const current = await connect(configPath);
    const old = await connect(configPath, released);

    expect(await runTool(current, "svc__echo")).toMatchObject({ content: ECHOED });
    expect(await runTool(old, "svc__echo")).toMatchObject({ content: ECHOED });

    expect(server.count("tools/list")).toBe(2);
    expect((await status()).instances).toEqual([{ source: { kind: "file", path: configPath }, bridges: 1, upstreams: ["svc"] }]);
  });

  it("replaces a daemon from crabeye 1.3.0 when an HTTP-only config needs one", async () => {
    const server = await upstream();
    const configPath = await workspace({ svc: { url: server.url } });
    const released = await releasedBridgeAt("1.3.0", join(dir, "crabeye-1.3.0"));
    scripts.add(released);
    execFileSync(process.execPath, [released, "daemon", "start"], { env: env(), stdio: "ignore" });
    const old = await status();
    expect(old.appVersion).toBeUndefined();

    const bridge = await connect(configPath);

    expect(await runTool(bridge, "svc__echo")).toMatchObject({ content: ECHOED });
    expect(await status()).toMatchObject({ appVersion: APP_VERSION });
    expect(processExists(old.pid)).toBe(false);
  });
});
