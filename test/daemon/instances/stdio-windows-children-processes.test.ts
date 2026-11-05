import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { BRIDGE_CONFIG_FILENAME, CREDENTIALS_DIR } from "../../../src/constants.js";
import { windowsPowerShellPath } from "../../../src/process/process-utils.js";
import { connectBridgeProcess, type BridgeProcess } from "../../_helpers/bridge-process.js";
import { FAST_RECONNECT } from "../../_helpers/stdio-manager.js";
import { viaRunTool } from "../../_helpers/run-tool.js";
import { STUB_STDIO_SERVER } from "../../_helpers/stub-stdio-server.js";
import { bundleForSubprocess } from "../../_helpers/subprocess-bundle.js";

const MASTER_KEY = randomBytes(32).toString("hex");
const run = promisify(execFile);
const CONSOLE_WINDOW_PROBE = Buffer.from(
  "$t = Add-Type -Name W -Namespace Cbe -PassThru -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern System.IntPtr GetConsoleWindow();'\n" +
    "[Console]::Out.Write($t::GetConsoleWindow().ToInt64())",
  "utf16le",
).toString("base64");

describe.runIf(process.platform === "win32")("processes the manager starts on Windows", { timeout: 90_000 }, () => {
  let cliScript: string;
  let dir: string;
  const bridges: BridgeProcess[] = [];

  beforeAll(async () => {
    cliScript = await bundleForSubprocess("src/index.ts", "cli-stdio-windows-children");
  }, 120_000);

  afterEach(async () => {
    await Promise.all(bridges.splice(0).map((bridge) => bridge.client.close().catch(() => {})));
    await run(process.execPath, [cliScript, "daemon", "stop"], { env: env() }).catch(() => {});
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }, 30_000);

  function env(): NodeJS.ProcessEnv {
    const replaced = new Set(["MCP_BRIDGE_CONFIG", "HOME", "USERPROFILE", "LOCALAPPDATA", "PSMODULEPATH"]);
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !replaced.has(name.toUpperCase())));
    return { ...inherited, HOME: dir, USERPROFILE: dir, LOCALAPPDATA: join(dir, "AppData", "Local"), MCP_BRIDGE_MASTER_KEY: MASTER_KEY };
  }

  async function workspace(): Promise<void> {
    dir = await mkdtemp(join(tmpdir(), "cbe-children-"));
    await writeFile(join(dir, "stub.cjs"), STUB_STDIO_SERVER);
    await writeFile(join(dir, "stubshim.cmd"), `@"${process.execPath}" "${join(dir, "stub.cjs")}" %*\r\n`);
    await mkdir(join(dir, CREDENTIALS_DIR));
    await writeFile(join(dir, CREDENTIALS_DIR, BRIDGE_CONFIG_FILENAME), JSON.stringify({ _bridge: { daemon: { killGraceMs: 0 } } }));
  }

  async function connect(server: Record<string, unknown>): Promise<BridgeProcess> {
    const config = join(dir, "client.json");
    await writeFile(config, JSON.stringify({ mcpServers: { stub: { _bridge: FAST_RECONNECT, ...server } } }));
    const bridge = await connectBridgeProcess(cliScript, config, env());
    bridges.push(bridge);
    return bridge;
  }

  async function consoleWindowOfChild(bridge: BridgeProcess): Promise<string> {
    const args = { command: windowsPowerShellPath(), args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", CONSOLE_WINDOW_PROBE] };
    const result = await bridge.client.callTool(viaRunTool("stub__run-child", args));
    if (result.isError) throw new Error(JSON.stringify(result.content));
    return (result.content as Array<{ text: string }>)[0]!.text;
  }

  it("starts a STDIO server, and the programs it starts, without a console window", async () => {
    await workspace();
    const bridge = await connect({ command: process.execPath, args: [join(dir, "stub.cjs")] });

    expect(await consoleWindowOfChild(bridge)).toBe("0");
  });

  it("starts a STDIO server run through a .cmd shim without a console window", async () => {
    await workspace();
    const bridge = await connect({ command: "stubshim", env: { PATH: `${dir};${process.env.PATH ?? process.env.Path ?? ""}` } });

    expect(await consoleWindowOfChild(bridge)).toBe("0");
  });
});
