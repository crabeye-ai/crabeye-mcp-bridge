import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { daemonStatus } from "../../../src/daemon/bootstrap.js";
import type { StatusResult } from "../../../src/daemon/protocol.js";
import { BRIDGE_CONFIG_FILENAME, CREDENTIALS_DIR, DAEMON_DIR, DAEMON_RUN_SUBDIR, DAEMON_SOCKET_FILENAME } from "../../../src/constants.js";
import { connectBridgeProcess, type BridgeProcess } from "../../_helpers/bridge-process.js";
import { until } from "../../_helpers/daemon-fixtures.js";
import { viaRunTool } from "../../_helpers/run-tool.js";
import { FAST_RECONNECT } from "../../_helpers/stdio-manager.js";
import { readMethodLog, STUB_METHOD_LOG_ENV, STUB_STDIO_SERVER } from "../../_helpers/stub-stdio-server.js";
import { bundleForSubprocess } from "../../_helpers/subprocess-bundle.js";

const MASTER_KEY = randomBytes(32).toString("hex");
const isWindows = process.platform === "win32";
const run = promisify(execFile);

type CallResult = { isError?: boolean; content: Array<{ text: string }> };

const limit = (maxCalls: number, windowSeconds: number) => ({ rateLimit: { maxCalls, windowSeconds } });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(isWindows)("search and rate limits shared by every client of the manager", { timeout: 90_000 }, () => {
  let cliScript: string;
  let dir: string;
  let stub: string;
  let methodLog: string;
  let socketPath: string;
  const bridges: BridgeProcess[] = [];

  beforeAll(async () => {
    cliScript = await bundleForSubprocess("src/index.ts", "cli-search-and-limits");
  }, 120_000);

  afterEach(async () => {
    await Promise.all(bridges.splice(0).map((bridge) => bridge.client.close().catch(() => {})));
    await run(process.execPath, [cliScript, "daemon", "stop"], { env: env(), timeout: 20_000, killSignal: "SIGKILL" }).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }, 30_000);

  function env(): NodeJS.ProcessEnv {
    const inherited = { ...process.env };
    delete inherited.MCP_BRIDGE_CONFIG;
    return { ...inherited, HOME: dir, USERPROFILE: dir, LOCALAPPDATA: join(dir, "AppData", "Local"), MCP_BRIDGE_MASTER_KEY: MASTER_KEY };
  }

  async function workspace(): Promise<void> {
    dir = await mkdtemp(join(tmpdir(), "cbe-limits-home-"));
    stub = join(dir, "stub.cjs");
    methodLog = join(dir, "methods.log");
    await writeFile(stub, STUB_STDIO_SERVER);
    socketPath = join(dir, DAEMON_DIR, DAEMON_RUN_SUBDIR, DAEMON_SOCKET_FILENAME);
    await mkdir(join(dir, CREDENTIALS_DIR));
    await writeFile(join(dir, CREDENTIALS_DIR, BRIDGE_CONFIG_FILENAME), JSON.stringify({ _bridge: { daemon: { killGraceMs: 0 } } }));
  }

  function stubServer(bridge: Record<string, unknown> = {}): Record<string, unknown> {
    return { command: process.execPath, args: [stub], env: { [STUB_METHOD_LOG_ENV]: methodLog }, _bridge: { ...FAST_RECONNECT, ...bridge } };
  }

  async function configFile(name: string, server: Record<string, unknown>): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, JSON.stringify({ mcpServers: { stub: server } }));
    return path;
  }

  async function connect(configPath: string): Promise<BridgeProcess> {
    const bridge = await connectBridgeProcess(cliScript, configPath, env());
    bridges.push(bridge);
    await until(async () => JSON.stringify(await search(bridge, [{ provider: "stub", expand_tools: true }])).includes("stub__plain"), 20_000);
    return bridge;
  }

  function call(bridge: BridgeProcess, tool = "plain", signal?: AbortSignal): Promise<CallResult> {
    return bridge.client.callTool(viaRunTool(`stub__${tool}`), signal && { signal }) as Promise<CallResult>;
  }

  async function calls(): Promise<number> {
    return (await readMethodLog(methodLog)).filter((method) => method === "tools/call").length;
  }

  function tracked<T>(promise: Promise<T>): { promise: Promise<T>; done: () => boolean } {
    let done = false;
    void promise.then(
      () => (done = true),
      () => (done = true),
    );
    return { promise, done: () => done };
  }

  async function status(): Promise<StatusResult> {
    return (await daemonStatus(socketPath)) as StatusResult;
  }

  async function search(bridge: BridgeProcess, queries: unknown[]): Promise<unknown> {
    const result = (await bridge.client.callTool({ name: "search_tools", arguments: { queries } })) as CallResult;
    return JSON.parse(result.content[0]!.text);
  }

  it("lets at most the limit through per window across two clients, holding the rest until the window opens", async () => {
    await workspace();
    const config = await configFile("client.json", stubServer(limit(2, 2)));
    const [a, b] = [await connect(config), await connect(config)];

    const first = await Promise.all([call(a), call(b)]);
    const held = tracked(call(b));
    await pause(500);

    expect(first.every((result) => result.isError !== true)).toBe(true);
    expect(await calls()).toBe(2);
    expect(held.done()).toBe(false);
    expect((await held.promise).isError).not.toBe(true);
    expect(await calls()).toBe(3);
  });

  it("gives a cancelled call's place to the other client's waiting call, and drops the waiting calls of a client that exits", async () => {
    await workspace();
    const config = await configFile("client.json", stubServer(limit(1, 2)));
    const [a, b, c] = [await connect(config), await connect(config), await connect(config)];
    await call(a);

    const cancel = new AbortController();
    const cancelled = call(b, "plain", cancel.signal).then(
      () => "ran",
      () => "cancelled",
    );
    const exiting = Promise.allSettled([call(c), call(c)]);
    await pause(200);
    const next = tracked(call(a));
    await pause(200);
    cancel.abort();
    await c.client.close();
    bridges.splice(bridges.indexOf(c), 1);

    expect(await cancelled).toBe("cancelled");
    await until(() => next.done(), 2_500);
    expect((await next.promise).isError).not.toBe(true);
    expect(await calls()).toBe(2);
    await exiting;
    await pause(2_500);
    expect(await calls()).toBe(2);
  });

  it("holds the configs that share a server to their own limits, with one process for both", async () => {
    await workspace();
    const strict = await connect(await configFile("strict.json", stubServer(limit(1, 10))));
    const loose = await connect(await configFile("loose.json", stubServer(limit(5, 10))));

    await call(strict);
    const held = tracked(call(strict));
    const free = await Promise.all(Array.from({ length: 5 }, () => call(loose)));
    const sixth = tracked(call(loose));
    await pause(300);

    expect(free.every((result) => result.isError !== true)).toBe(true);
    expect(held.done()).toBe(false);
    expect(sixth.done()).toBe(false);
    expect((await status()).children).toHaveLength(1);
  });

  it("holds two names in one config that run the same server to one budget", async () => {
    await workspace();
    const config = join(dir, "client.json");
    await writeFile(config, JSON.stringify({ mcpServers: { stub: stubServer(limit(1, 10)), alias: stubServer(limit(1, 10)) } }));
    const a = await connect(config);

    await call(a);
    const held = tracked(a.client.callTool(viaRunTool("alias__plain")) as Promise<CallResult>);
    await pause(300);

    expect(held.done()).toBe(false);
    expect(await calls()).toBe(1);
    expect((await status()).children).toHaveLength(1);
  });

  it("applies a reload that raises the limit to every client without restarting the server", async () => {
    await workspace();
    const config = await configFile("client.json", stubServer(limit(1, 2)));
    const [a, b] = [await connect(config), await connect(config)];
    const pid = (await status()).children[0]!.pid;

    await writeFile(config, JSON.stringify({ mcpServers: { stub: stubServer(limit(10, 60)) } }));
    await until(async () => {
      const before = await calls();
      const burst = Promise.all([call(a), call(b), call(a), call(b)]);
      await pause(500);
      const reached = (await calls()) - before;
      await burst;
      return reached === 4;
    }, 20_000);

    expect((await status()).children[0]!.pid).toBe(pid);
  });

  it("refuses a waiting call, once its slot comes, whose tool a reload disabled meanwhile", async () => {
    await workspace();
    const config = await configFile("client.json", stubServer(limit(1, 3)));
    const [a, b] = [await connect(config), await connect(config)];
    await call(a);
    const waiting = call(b, "slow");
    await pause(200);

    await writeFile(config, JSON.stringify({ mcpServers: { stub: stubServer({ ...limit(1, 3), tools: { slow: "never" } }) } }));

    expect(await waiting).toMatchObject({ isError: true, content: [{ text: "Tool stub__slow is disabled by policy" }] });
    expect(await calls()).toBe(1);
  });

  it("refuses a call past the queue cap, whichever client makes it", async () => {
    await workspace();
    const config = await configFile("client.json", stubServer(limit(1, 60)));
    const [a, b] = [await connect(config), await connect(config)];
    await call(a);

    const answered: CallResult[] = [];
    const queued = [...Array.from({ length: 6 }, () => call(a)), ...Array.from({ length: 6 }, () => call(b))].map((pending) =>
      pending.then((result) => answered.push(result), () => null),
    );

    await until(() => answered.length === 2, 20_000);

    expect(answered).toEqual(Array(2).fill(expect.objectContaining({ isError: true, content: [{ type: "text", text: "Rate limit queue full" }] })));
    await Promise.all(bridges.splice(0).map((bridge) => bridge.client.close().catch(() => {})));
    await Promise.all(queued);
  });

  it("fails a call waiting for a slot when the manager dies, and runs the next call on a new manager", async () => {
    await workspace();
    const a = await connect(await configFile("client.json", stubServer(limit(1, 60))));
    await call(a);
    const { pid } = await status();
    const waiting = call(a);
    await pause(300);

    process.kill(pid, "SIGKILL");

    expect(await waiting).toMatchObject({ isError: true, content: [{ text: 'Upstream server "stub" error: daemon connection closed' }] });
    await until(async () => {
      const running = await daemonStatus(socketPath).catch(() => null);
      return running !== null && (running as StatusResult).pid !== pid;
    }, 30_000);
    await until(async () => (await call(a)).isError !== true, 30_000);
  });

  it("searches one index from every client, which follows a server's new tools", async () => {
    await workspace();
    const config = await configFile("client.json", stubServer());
    const [a, b] = [await connect(config), await connect(config)];
    const queries = [{ tool: "added_tool", expand_tools: true }];

    await a.client.callTool(viaRunTool("stub__add-tool", { name: "added_tool" }));
    await until(async () => JSON.stringify(await search(b, queries)).includes("stub__added_tool"), 20_000);

    expect(await search(a, queries)).toEqual(await search(b, queries));
  });
});
