import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { daemonStatus } from "../../src/daemon/bootstrap.js";
import type { StatusResult } from "../../src/daemon/protocol.js";
import {
  BRIDGE_CONFIG_FILENAME,
  CREDENTIALS_DIR,
  DAEMON_DIR,
  DAEMON_RUN_SUBDIR,
  DAEMON_SOCKET_FILENAME,
} from "../../src/constants.js";
import { daemonPidsRunning, signalIfRunning, waitUntil } from "./processes.js";
import { STUB_STDIO_SERVER } from "./stub-stdio-server.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const CALLED = [{ type: "text", text: "called plain" }];
export const STILL_RUNNING = "is still running after an attempt to replace it";

export function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

export async function cliAtVersion(cliScript: string, dir: string, version: string): Promise<string> {
  const root = join(dir, `crabeye-${version}`);
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@crabeye-ai/crabeye-mcp-bridge", version, type: "module" }));
  await symlink(join(repoRoot, "node_modules"), join(root, "node_modules"));
  const script = join(root, "dist", "index.js");
  await copyFile(cliScript, script);
  return script;
}

export interface BridgeProcess {
  client: Client;
  stderr: () => string;
}

export async function connectBridgeProcess(script: string, configPath: string, env: NodeJS.ProcessEnv): Promise<BridgeProcess> {
  const definedEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [script, "--config", configPath],
    env: definedEnv,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const client = new Client({ name: "test-client", version: "0" });
  await client.connect(transport);
  return { client, stderr: () => stderr };
}

export async function callStubTool(
  { client }: BridgeProcess,
  tool = "plain",
  args: Record<string, unknown> = {},
): Promise<unknown> {
  return (await client.callTool({ name: "run_tool", arguments: { name: `stub__${tool}`, arguments: args } })).content;
}

export interface ScratchHome {
  dir: string;
  configPath: string;
  socketPath: string;
  env: () => NodeJS.ProcessEnv;
  status: () => Promise<StatusResult | null>;
  connectBridge: (script: string) => Promise<BridgeProcess>;
  cleanUp: () => Promise<void>;
}

/** A scratch HOME with a stub STDIO server configured as "stub" and a short daemon kill grace. */
export async function scratchHome(
  scripts: () => string[],
  extraConfig: { stubBridge?: Record<string, unknown>; stubEnv?: Record<string, string>; bridge?: Record<string, unknown> } = {},
): Promise<ScratchHome> {
  const dir = await mkdtemp("/tmp/cbe-home-");
  const stub = join(dir, "stub.cjs");
  await writeFile(stub, STUB_STDIO_SERVER);
  const configPath = join(dir, "client.json");
  await writeFile(
    configPath,
    JSON.stringify({
      mcpServers: {
        stub: { command: process.execPath, args: [stub], ...(extraConfig.stubEnv && { env: extraConfig.stubEnv }), _bridge: extraConfig.stubBridge ?? {} },
      },
      ...(extraConfig.bridge && { _bridge: extraConfig.bridge }),
    }),
  );
  await mkdir(join(dir, CREDENTIALS_DIR));
  await writeFile(join(dir, CREDENTIALS_DIR, BRIDGE_CONFIG_FILENAME), JSON.stringify({ _bridge: { daemon: { killGraceMs: 0 } } }));
  const bridges: BridgeProcess[] = [];
  const env = () => ({ ...process.env, HOME: dir });
  const socketPath = join(dir, DAEMON_DIR, DAEMON_RUN_SUBDIR, DAEMON_SOCKET_FILENAME);
  return {
    dir,
    configPath,
    socketPath,
    env,
    status: async () => (await daemonStatus(socketPath)) as StatusResult | null,
    connectBridge: async (script) => {
      const bridge = await connectBridgeProcess(script, configPath, env());
      bridges.push(bridge);
      return bridge;
    },
    cleanUp: async () => {
      await Promise.all(bridges.splice(0).map((bridge) => bridge.client.close().catch(() => {})));
      await stopDaemonsOf(scripts());
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export async function stopDaemonsOf(scripts: string[]): Promise<void> {
  const running = () => scripts.flatMap((script) => daemonPidsRunning(script));
  for (const pid of running()) signalIfRunning(pid, "SIGTERM");
  await waitUntil(() => running().length === 0, 10_000);
  for (const pid of running()) signalIfRunning(pid, "SIGKILL");
}
