import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { daemonStatus } from "../../../src/daemon/bootstrap.js";
import type { StatusResult } from "../../../src/daemon/protocol.js";
import {
  BRIDGE_CONFIG_FILENAME,
  CREDENTIALS_DIR,
  DAEMON_DIR,
  DAEMON_LOG_FILENAME,
  DAEMON_LOG_SUBDIR,
  DAEMON_RUN_SUBDIR,
  DAEMON_SOCKET_FILENAME,
} from "../../../src/constants.js";
import { connectBridgeProcess, type BridgeLaunch, type BridgeProcess, type PromptAnswer } from "../../_helpers/bridge-process.js";
import { until } from "../../_helpers/daemon-fixtures.js";
import { viaRunTool } from "../../_helpers/run-tool.js";
import { FAST_RECONNECT } from "../../_helpers/stdio-manager.js";
import { readMethodLog, STUB_METHOD_LOG_ENV, STUB_STDIO_SERVER } from "../../_helpers/stub-stdio-server.js";
import { bundleForSubprocess } from "../../_helpers/subprocess-bundle.js";

const MASTER_KEY = randomBytes(32).toString("hex");
const isWindows = process.platform === "win32";
const run = promisify(execFile);

type CallResult = { isError?: boolean; content: Array<{ text: string }> };

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A prompt answer the test gives when it chooses, with the prompts the client was shown. */
function heldAnswer(): { elicit: NonNullable<BridgeLaunch["elicit"]>; asked: string[]; answer: (action: PromptAnswer) => void } {
  const asked: string[] = [];
  let release!: (action: PromptAnswer) => void;
  const answered = new Promise<PromptAnswer>((resolve) => (release = resolve));
  const elicit = async (message: string): Promise<PromptAnswer> => {
    asked.push(message);
    return answered;
  };
  return { elicit, asked, answer: (action) => release(action) };
}

describe.skipIf(isWindows)("tool policy decided by the manager for every client", { timeout: 90_000 }, () => {
  let cliScript: string;
  let dir: string;
  let stub: string;
  let methodLog: string;
  let socketPath: string;
  let config: string;
  const bridges: BridgeProcess[] = [];

  beforeAll(async () => {
    cliScript = await bundleForSubprocess("src/index.ts", "cli-policy");
  }, 120_000);

  afterEach(async () => {
    await Promise.all(bridges.splice(0).map((bridge) => bridge.client.close().catch(() => {})));
    const manager = (await daemonStatus(socketPath).catch(() => null)) as StatusResult | null;
    await run(process.execPath, [cliScript, "daemon", "stop"], { env: env(), timeout: 20_000, killSignal: "SIGKILL" }).catch(() => {});
    if (manager !== null) killIfRunning(manager.pid);
    await rm(dir, { recursive: true, force: true });
  }, 30_000);

  function killIfRunning(pid: number): void {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }

  function env(): NodeJS.ProcessEnv {
    const inherited = { ...process.env };
    delete inherited.MCP_BRIDGE_CONFIG;
    return { ...inherited, HOME: dir, USERPROFILE: dir, LOCALAPPDATA: join(dir, "AppData", "Local"), MCP_BRIDGE_MASTER_KEY: MASTER_KEY };
  }

  async function workspace(bridge: Record<string, unknown> = {}, global: Record<string, unknown> = {}): Promise<void> {
    dir = await mkdtemp(join(tmpdir(), "cbe-policy-home-"));
    stub = join(dir, "stub.cjs");
    methodLog = join(dir, "methods.log");
    await writeFile(stub, STUB_STDIO_SERVER);
    socketPath = join(dir, DAEMON_DIR, DAEMON_RUN_SUBDIR, DAEMON_SOCKET_FILENAME);
    await mkdir(join(dir, CREDENTIALS_DIR));
    await writeFile(join(dir, CREDENTIALS_DIR, BRIDGE_CONFIG_FILENAME), JSON.stringify({ _bridge: { daemon: { killGraceMs: 0 } } }));
    config = join(dir, "client.json");
    await writeConfig(bridge, global);
  }

  function writeConfig(bridge: Record<string, unknown> = {}, global: Record<string, unknown> = {}): Promise<void> {
    const server = { command: process.execPath, args: [stub], env: { [STUB_METHOD_LOG_ENV]: methodLog }, _bridge: { ...FAST_RECONNECT, ...bridge } };
    return writeFile(config, JSON.stringify({ mcpServers: { stub: server }, _bridge: global }));
  }

  async function connect(launch: BridgeLaunch = {}): Promise<BridgeProcess> {
    const bridge = await connectBridgeProcess(cliScript, config, env(), launch);
    bridges.push(bridge);
    await until(async () => JSON.stringify(await bridge.client.callTool({ name: "search_tools", arguments: { queries: [{ provider: "stub", expand_tools: true }] } })).includes("stub__plain"), 20_000);
    return bridge;
  }

  function call(bridge: BridgeProcess): Promise<CallResult> {
    return bridge.client.callTool(viaRunTool("stub__plain")) as Promise<CallResult>;
  }

  async function calls(): Promise<number> {
    return (await readMethodLog(methodLog)).filter((method) => method === "tools/call").length;
  }

  async function managerLog(): Promise<string> {
    return readFile(join(dir, DAEMON_DIR, DAEMON_LOG_SUBDIR, DAEMON_LOG_FILENAME), "utf8").catch(() => "");
  }

  it("asks each client, legacy and modern, about its own call, and runs only the approved one", async () => {
    await workspace({ toolPolicy: "prompt" });
    const [legacy, modern] = [heldAnswer(), heldAnswer()];
    const [a, b] = [await connect({ elicit: legacy.elicit }), await connect({ modern: true, elicit: modern.elicit })];

    const [first, second] = [call(a), call(b)];
    await until(() => legacy.asked.length === 1 && modern.asked.length === 1, 10_000);
    expect(await calls()).toBe(0);
    legacy.answer("accept");
    modern.answer("decline");

    expect(await first).toMatchObject({ content: [{ text: "called plain" }] });
    expect(await second).toMatchObject({ isError: true, content: [{ text: "Tool stub__plain was declined by user" }] });
    expect(legacy.asked).toEqual(["Allow stub__plain to run?\n\nArguments:\n{}"]);
    expect(modern.asked).toEqual(legacy.asked);
    expect(await calls()).toBe(1);
  });

  it("never runs a call whose client leaves with its prompt unanswered, and still asks the other client", async () => {
    await workspace({ toolPolicy: "prompt" });
    const [leaving, staying] = [heldAnswer(), heldAnswer()];
    const [a, b] = [await connect({ elicit: leaving.elicit }), await connect({ modern: true, elicit: staying.elicit })];

    void call(a).catch(() => {});
    await until(() => leaving.asked.length === 1, 10_000);
    await a.client.close();
    leaving.answer("accept");
    const other = call(b);
    await until(() => staying.asked.length === 1, 10_000);
    staying.answer("accept");

    expect(await other).toMatchObject({ content: [{ text: "called plain" }] });
    await pause(500);
    expect(await calls()).toBe(1);
  });

  it("checks a call approved after a reload against the new policy", async () => {
    await workspace({ toolPolicy: "prompt" });
    const held = heldAnswer();
    const [a, b] = [await connect({ elicit: held.elicit }), await connect()];

    const approved = call(a);
    await until(() => held.asked.length === 1, 10_000);
    await writeConfig({ tools: { plain: "never" } });
    await until(async () => JSON.stringify(await call(b)).includes("disabled by policy"), 20_000);
    held.answer("accept");

    expect(await approved).toMatchObject({ isError: true, content: [{ text: "Tool stub__plain is disabled by policy" }] });
    expect(await calls()).toBe(0);
  });

  it("applies a policy edit to every client's next call", async () => {
    await workspace();
    const [a, b] = [await connect(), await connect()];
    expect((await call(a)).isError).not.toBe(true);

    await writeConfig({ tools: { plain: "never" } });

    await until(async () => (await call(a)).isError === true, 20_000);
    const made = await calls();

    expect(await call(b)).toMatchObject({ isError: true, content: [{ text: "Tool stub__plain is disabled by policy" }] });
    expect(await calls()).toBe(made);
  });

  it("changes every client's log level with the config's, and shows a config that stops loading in every client's log and the manager's", async () => {
    await workspace({}, { logLevel: "info" });
    const [a, b] = [await connect(), await connect()];
    await a.client.callTool(viaRunTool("stub__stderr", { text: "before-debug" }));

    await writeConfig({}, { logLevel: "debug" });
    await until(() => [a, b].every((bridge) => bridge.stderr().includes("log level changed to debug")), 20_000);
    await a.client.callTool(viaRunTool("stub__stderr", { text: "after-debug" }));

    await until(() => a.stderr().includes("after-debug"), 10_000);
    expect(a.stderr()).not.toContain("before-debug");
    expect(a.stderr().match(/log level changed/g)).toHaveLength(1);
    await writeFile(config, "{ not json");

    await until(() => [a, b].every((bridge) => bridge.stderr().includes("failed to reload config")), 20_000);
    expect(await managerLog()).toContain("failed to reload config");
    expect((await call(a)).isError).not.toBe(true);
  });

  it("runs a call approved after the manager died once, on the new manager", async () => {
    await workspace({ toolPolicy: "prompt" });
    const held = heldAnswer();
    const a = await connect({ elicit: held.elicit });
    const { pid } = (await daemonStatus(socketPath)) as StatusResult;

    const approved = call(a);
    await until(() => held.asked.length === 1, 10_000);
    process.kill(pid, "SIGKILL");
    await until(async () => {
      const running = await daemonStatus(socketPath).catch(() => null);
      return running !== null && (running as StatusResult).pid !== pid;
    }, 30_000);
    held.answer("accept");

    expect(await approved).toMatchObject({ content: [{ text: "called plain" }] });
    expect(await calls()).toBe(1);
  });
});
