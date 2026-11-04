import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { BRIDGE_CONFIG_FILENAME, CREDENTIALS_DIR } from "../../../src/constants.js";
import { processExists, readProcessInfo } from "../../../src/process/process-utils.js";
import { connectBridgeProcess, occurrences, type BridgeProcess } from "../../_helpers/bridge-process.js";
import { until } from "../../_helpers/daemon-fixtures.js";
import { FAST_RECONNECT } from "../../_helpers/stdio-manager.js";
import { viaRunTool } from "../../_helpers/run-tool.js";
import { readMethodLog, STUB_METHOD_LOG_ENV, STUB_STDIO_SERVER } from "../../_helpers/stub-stdio-server.js";
import { bundleForSubprocess } from "../../_helpers/subprocess-bundle.js";

const MASTER_KEY = randomBytes(32).toString("hex");
const run = promisify(execFile);
const ARGS_TO_PASS_UNCHANGED = [
  "a b", '"q"', "&", "|", "^", "%PATH%", "%PATH:x=y%", "%PATH:~0,1%", "%", "%%", "%1", "%~1", "%*", "<", ">", "!", "(x)", "",
  '{"q":"a&b"}', 'x"|y', 'a"^b', '"<z>"&', 'say "a & b" > out',
  "C:\\a b\\", "a\\\\", 'a\\\\"b', '{"root":"C:\\\\"}', "a=b", "C:\\Users\\José\\日本",
];

interface ProcessStart {
  pid: number;
  startTime?: number | null;
}

interface ServerProcess {
  argv: string[];
  pid: number;
  ppid: number;
}

describe.runIf(process.platform === "win32")("STDIO servers started through cmd.exe on Windows", { timeout: 90_000 }, () => {
  let cliScript: string;
  let dir: string;
  let shims: string;
  const bridges: BridgeProcess[] = [];
  const processes: ProcessStart[] = [];

  beforeAll(async () => {
    cliScript = await bundleForSubprocess("src/index.ts", "cli-stdio-shims");
  }, 120_000);

  afterEach(async () => {
    await Promise.all(bridges.splice(0).map((bridge) => bridge.client.close().catch(() => {})));
    await run(process.execPath, [cliScript, "daemon", "stop"], { env: env() }).catch(() => {});
    for (const started of processes.splice(0)) {
      if (await ended(started)) continue;
      try {
        process.kill(started.pid);
      } catch {
        /* exited meanwhile */
      }
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }, 30_000);

  function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const replaced = new Set(["MCP_BRIDGE_CONFIG", ...Object.keys(extra)].map((name) => name.toUpperCase()));
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !replaced.has(name.toUpperCase())));
    return { ...inherited, HOME: dir, USERPROFILE: dir, LOCALAPPDATA: join(dir, "AppData", "Local"), MCP_BRIDGE_MASTER_KEY: MASTER_KEY, ...extra };
  }

  async function workspace(): Promise<void> {
    dir = await mkdtemp(join(tmpdir(), "cbe shims "));
    shims = join(dir, "shim (x) & ^ dir");
    await mkdir(shims);
    await writeFile(join(dir, "stub.cjs"), STUB_STDIO_SERVER);
    await shim("stubshim", stubLauncher());
    await mkdir(join(dir, CREDENTIALS_DIR));
    await writeFile(join(dir, CREDENTIALS_DIR, BRIDGE_CONFIG_FILENAME), JSON.stringify({ _bridge: { daemon: { killGraceMs: 0 } } }));
  }

  function managerLog(): Promise<string> {
    return readFile(join(dir, "AppData", "Local", "crabeye", "logs", "daemon.log"), "utf8").catch(() => "");
  }

  function stubLauncher(): string {
    return `@"${process.execPath}" "${join(dir, "stub.cjs")}" %*`;
  }

  function shim(name: string, body: string): Promise<void> {
    return writeFile(join(shims, `${name}.cmd`), `${body}\r\n`);
  }

  function onPath(extra: Record<string, string> = {}): Record<string, string> {
    return { PATH: `"${shims}";${process.env.PATH ?? process.env.Path ?? ""}`, ...extra };
  }

  async function ended({ pid, startTime }: ProcessStart): Promise<boolean> {
    if (!processExists(pid)) return true;
    const info = await readProcessInfo(pid);
    return info !== null && info.startTime !== startTime;
  }

  async function connect(
    server: Record<string, unknown>,
    { others = {}, managerEnv = {} }: { others?: Record<string, Record<string, unknown>>; managerEnv?: Record<string, string> } = {},
  ): Promise<BridgeProcess> {
    const config = join(dir, "client.json");
    const entries = Object.entries({ ...others, stub: server }).map(([name, entry]) => [name, { _bridge: FAST_RECONNECT, ...entry }]);
    await writeFile(config, JSON.stringify({ mcpServers: Object.fromEntries(entries) }));
    const bridge = await connectBridgeProcess(cliScript, config, env(managerEnv));
    bridges.push(bridge);
    return bridge;
  }

  async function serverProcess(bridge: BridgeProcess): Promise<ServerProcess> {
    const result = await bridge.client.callTool(viaRunTool("stub__process", {}));
    if (result.isError) throw new Error(JSON.stringify(result.content));
    return JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as ServerProcess;
  }

  it("starts a server whose command is a .cmd shim named without its extension, found through a quoted PATH entry", async () => {
    await workspace();
    const bridge = await connect({ command: "stubshim", env: onPath() });

    expect((await serverProcess(bridge)).argv).toEqual([]);
  });

  it("starts a server whose command is the full path of a .cmd shim with spaces in it", async () => {
    await workspace();
    const bridge = await connect({ command: join(shims, "stubshim.cmd") });

    expect((await serverProcess(bridge)).argv).toEqual([]);
  });

  it("passes arguments with spaces, quotes and cmd.exe metacharacters to a shim unchanged", async () => {
    await workspace();
    const bridge = await connect({ command: "stubshim", args: ARGS_TO_PASS_UNCHANGED, env: onPath() });

    expect((await serverProcess(bridge)).argv).toEqual(ARGS_TO_PASS_UNCHANGED);
  });

  it("passes arguments unchanged to a shim whose path is written with a trailing space, which cmd.exe still runs", async () => {
    await workspace();
    const bridge = await connect({ command: `${join(shims, "stubshim.cmd")} `, args: ARGS_TO_PASS_UNCHANGED });

    expect((await serverProcess(bridge)).argv).toEqual(ARGS_TO_PASS_UNCHANGED);
  });

  it("runs a script whose shebang names a shim through that shim, with the script and arguments unchanged", async () => {
    await workspace();
    const script = join(shims, "stubscript");
    await writeFile(script, "#!/usr/bin/env stubshim\n");
    const bridge = await connect({ command: script, args: ARGS_TO_PASS_UNCHANGED, env: onPath() });

    expect((await serverProcess(bridge)).argv).toEqual([script, ...ARGS_TO_PASS_UNCHANGED]);
  });

  it("runs a script whose shebang names a program that cmd.exe finds and the manager's own lookup doesn't, with the script and arguments unchanged", async () => {
    await workspace();
    const script = join(shims, "nodescript");
    await writeFile(script, `#!/usr/bin/env node\n${STUB_STDIO_SERVER}`);
    const bridge = await connect({ command: script, args: ARGS_TO_PASS_UNCHANGED, env: { PATHEXT: ".EXE;.CMD" } }, { managerEnv: { PATHEXT: ".CMD" } });

    expect((await serverProcess(bridge)).argv).toEqual(ARGS_TO_PASS_UNCHANGED);
  });

  it("passes arguments with spaces, quotes and cmd.exe metacharacters to a .bat file unchanged", async () => {
    await workspace();
    await writeFile(join(shims, "stubbat.bat"), `${stubLauncher()}\r\n`);
    const bridge = await connect({ command: join(shims, "stubbat.bat"), args: ARGS_TO_PASS_UNCHANGED });

    expect((await serverProcess(bridge)).argv).toEqual(ARGS_TO_PASS_UNCHANGED);
  });

  it("reports a shim named without its extension as exited when the server's PATHEXT leaves out .CMD, because cmd.exe then can't find it", async () => {
    await workspace();
    const bridge = await connect({ command: "stubshim", env: onPath({ PATHEXT: ".EXE" }) });

    await until(() => bridge.stderr().includes("STDIO server exited with code 1"), 20_000);
    expect(bridge.stderr()).not.toContain("STDIO server could not be started");
  });

  it("passes arguments unchanged to a program that cmd.exe finds and the manager's own lookup doesn't", async () => {
    await workspace();
    const bridge = await connect({ command: "node", args: [join(dir, "stub.cjs"), ...ARGS_TO_PASS_UNCHANGED], env: { PATHEXT: ".EXE;.CMD" } }, { managerEnv: { PATHEXT: ".CMD" } });

    const server = await serverProcess(bridge);
    expect(server.argv).toEqual(ARGS_TO_PASS_UNCHANGED);
    expect((await readProcessInfo(server.ppid))?.cmdline).toMatch(/\\cmd\.exe/i);
  });

  it("runs a shim with System32's cmd.exe even when COMSPEC names another program", async () => {
    await workspace();
    const bridge = await connect({ command: "stubshim", env: onPath() }, { managerEnv: { COMSPEC: join(dir, "not-cmd.exe") } });

    expect((await serverProcess(bridge)).argv).toEqual([]);
  });

  it("doesn't start a shim given an argument with a line break, and still starts the client's other servers", async () => {
    await workspace();
    const bridge = await connect({ command: "stubshim", env: onPath() }, { others: { broken: { command: "stubshim", args: ["a\nb"], env: onPath() } } });

    expect((await serverProcess(bridge)).argv).toEqual([]);
    await until(async () => (await managerLog()).includes("failed to connect: spawn failed for stubshim"), 20_000);
    expect((await bridge.client.callTool(viaRunTool("broken__process", {}))).isError).toBe(true);
  });

  it("starts a shim named with its extension when the server's PATHEXT leaves out .CMD", async () => {
    await workspace();
    const bridge = await connect({ command: "stubshim.cmd", env: onPath({ PATHEXT: ".EXE" }) });

    expect((await serverProcess(bridge)).argv).toEqual([]);
  });

  it("reports a missing command as not started only once, and starts it after it is created", async () => {
    await workspace();
    const bridge = await connect({ command: "laterShim", env: onPath() });

    await until(() => bridge.stderr().includes("STDIO server could not be started"), 20_000);
    await writeFile(join(shims, "laterShim.tmp"), `${stubLauncher()}\r\n`);
    await rename(join(shims, "laterShim.tmp"), join(shims, "laterShim.cmd"));

    await until(async () => (await serverProcess(bridge).catch(() => null)) !== null, 20_000);
    expect(occurrences(bridge.stderr(), "STDIO server could not be started")).toBe(1);
    expect(bridge.stderr()).not.toContain("STDIO server exited");
  });

  it("reports a shim that exits with code 1 on its own as an exit, not as a command that couldn't be started", async () => {
    await workspace();
    await shim("failshim", "@exit /b 1");
    const bridge = await connect({ command: "failshim", env: onPath() });

    await until(() => bridge.stderr().includes("STDIO server exited with code 1"), 20_000);
    expect(bridge.stderr()).not.toContain("STDIO server could not be started");
  });

  it("stops the server behind a shim and the shim's cmd.exe when its upstream is restarted, even a server that outlives its input, and starts a new one", async () => {
    await workspace();
    const log = join(dir, "methods.log");
    const bridge = await connect({ command: "stubshim", env: onPath({ [STUB_METHOD_LOG_ENV]: log }) });
    const old = await serverProcess(bridge);
    const started = await Promise.all([old.pid, old.ppid].map(async (pid) => ({ pid, startTime: (await readProcessInfo(pid))?.startTime })));
    processes.push(...started);
    expect(started.every(({ startTime }) => typeof startTime === "number")).toBe(true);
    void bridge.client.callTool(viaRunTool("stub__slow", { ms: 60_000 })).catch(() => {});
    await until(async () => (await readMethodLog(log, old.pid)).filter((method) => method === "tools/call").length === 2, 10_000);

    await run(process.execPath, [cliScript, "daemon", "restart-upstream", "--all"], { env: env() });

    await until(async () => (await Promise.all(started.map(ended))).every(Boolean), 20_000);
    await until(async () => {
      const current = await serverProcess(bridge).catch(() => old);
      return current.pid !== old.pid || current.ppid !== old.ppid;
    }, 20_000);
  });
});
