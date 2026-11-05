import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, userInfo } from "node:os";
import { promisify } from "node:util";
import { getDaemonKeyPath, getDaemonSocketPath } from "../../src/daemon/paths.js";
import { BRIDGE_CONFIG_FILENAME, CREDENTIALS_DIR } from "../../src/constants.js";
import { processExists, system32Path } from "../../src/process/process-utils.js";
import { connectBridgeProcess, occurrences, type BridgeProcess } from "../_helpers/bridge-process.js";
import { until } from "../_helpers/daemon-fixtures.js";
import { FAST_RECONNECT } from "../_helpers/stdio-manager.js";
import { viaRunTool } from "../_helpers/run-tool.js";
import { STUB_STDIO_SERVER } from "../_helpers/stub-stdio-server.js";
import { bundleForSubprocess } from "../_helpers/subprocess-bundle.js";

const MASTER_KEY = randomBytes(32).toString("hex");
const SECOND_USER = process.env.CBE_SECOND_USER;
const run = promisify(execFile);
const REFUSAL = "refusing to use";
const SECOND_USER_TIMEOUT_MS = 30_000;

const SQUATTER = `
const net = require("node:net");
const fs = require("node:fs");
const [pipe, out] = process.argv.slice(2);
const seen = { frames: [], bytes: 0 };
const proof = Buffer.from(JSON.stringify({ proof: "ab".repeat(32) }));
const header = Buffer.alloc(4);
header.writeUInt32BE(proof.length, 0);
net.createServer((socket) => {
  let pending = Buffer.alloc(0);
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    seen.bytes += chunk.length;
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32BE(0)) {
      const length = pending.readUInt32BE(0);
      seen.frames.push(JSON.parse(pending.subarray(4, 4 + length).toString()));
      pending = pending.subarray(4 + length);
      socket.write(Buffer.concat([header, proof]));
    }
    record();
  });
}).listen({ path: pipe, readableAll: true, writableAll: true }, record);
function record() {
  try {
    fs.writeFileSync(out + ".tmp", JSON.stringify(seen));
    fs.renameSync(out + ".tmp", out);
  } catch {}
}
`;

const PROBE = `
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const [pipe, keyPath, out] = process.argv.slice(2);
const result = { user: os.userInfo().username };
const socket = net.connect(pipe);
socket.on("connect", () => { result.write = "connected"; socket.destroy(); next(); });
socket.on("error", (err) => { result.write = err.code; next(); });
function next() {
  try { fs.readFileSync(keyPath); result.key = "read"; } catch (err) { result.key = err.code; }
  try {
    const fd = fs.openSync(pipe, "r");
    try { result.readBytes = fs.readSync(fd, Buffer.alloc(64)); } catch (err) { result.readBytes = 0; result.readError = err.code; }
    fs.closeSync(fd);
  } catch (err) { result.readOpen = err.code; }
  fs.writeFileSync(out + ".tmp", JSON.stringify(result));
  fs.renameSync(out + ".tmp", out);
}
`;

interface Seen {
  frames: unknown[];
  bytes: number;
}

describe.runIf(process.platform === "win32")("the manager's pipe on Windows", { timeout: 120_000 }, () => {
  let cliScript: string;
  const profiles: string[] = [];
  const sharedDirs: string[] = [];
  const bridges: BridgeProcess[] = [];
  const started: number[] = [];

  beforeAll(async () => {
    cliScript = await bundleForSubprocess("src/index.ts", "cli-foreign-pipe");
  }, 120_000);

  afterEach(async () => {
    await Promise.all(bridges.splice(0).map((bridge) => bridge.client.close().catch(() => {})));
    for (const pid of started.splice(0)) await run(system32Path("taskkill.exe"), ["/F", "/T", "/PID", String(pid)]).catch(() => {});
    for (const dir of profiles.splice(0)) {
      await cli(dir, "stop");
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    for (const dir of sharedDirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }, 60_000);

  async function profile(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "cbe-pipe-"));
    profiles.push(dir);
    await mkdir(join(dir, CREDENTIALS_DIR));
    await writeFile(join(dir, CREDENTIALS_DIR, BRIDGE_CONFIG_FILENAME), JSON.stringify({ _bridge: { daemon: { killGraceMs: 0 } } }));
    return dir;
  }

  function env(dir: string): NodeJS.ProcessEnv {
    const replaced = new Set(["MCP_BRIDGE_CONFIG", "HOME", "USERPROFILE", "LOCALAPPDATA", "CBE_SECOND_USER", "CBE_SECOND_PASSWORD"]);
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !replaced.has(name.toUpperCase())));
    return { ...inherited, HOME: dir, USERPROFILE: dir, LOCALAPPDATA: join(dir, "AppData", "Local"), MCP_BRIDGE_MASTER_KEY: MASTER_KEY };
  }

  function inProfile<T>(dir: string, read: () => T): T {
    vi.stubEnv("LOCALAPPDATA", join(dir, "AppData", "Local"));
    try {
      return read();
    } finally {
      vi.unstubAllEnvs();
    }
  }

  async function cli(dir: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await run(process.execPath, [cliScript, "daemon", ...args], { env: env(dir) });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const failed = err as { code?: number; stdout?: string; stderr?: string };
      return { code: failed.code ?? -1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
    }
  }

  async function sharedDir(): Promise<string> {
    const dir = await mkdtemp(join(process.env.PUBLIC ?? "C:\\Users\\Public", "cbe-pipe-"));
    sharedDirs.push(dir);
    await run(system32Path("icacls.exe"), [dir, "/grant", "Everyone:(OI)(CI)F"]);
    return dir;
  }

  async function startAsSecondUser(dir: string, script: string, args: string[]): Promise<number> {
    const argv = [script, ...args];
    if ([process.execPath, dir, ...argv].some((arg) => /[\s']/.test(arg))) {
      throw new Error(`argument unsafe for Start-Process: ${argv.join(" ")}`);
    }
    const command =
      "$c = New-Object System.Management.Automation.PSCredential($env:CBE_SECOND_USER, (ConvertTo-SecureString $env:CBE_SECOND_PASSWORD -AsPlainText -Force)); " +
      `$p = Start-Process -FilePath '${process.execPath}' -ArgumentList ${argv.map((arg) => `'${arg}'`).join(",")} ` +
      `-Credential $c -WorkingDirectory '${dir}' -RedirectStandardOutput '${join(dir, "out.txt")}' -RedirectStandardError '${join(dir, "err.txt")}' -PassThru; $p.Id`;
    const { stdout } = await run(system32Path("WindowsPowerShell\\v1.0\\powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", command], {
      env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PSMODULEPATH")),
      timeout: SECOND_USER_TIMEOUT_MS,
    });
    return Number(stdout.trim());
  }

  async function startScript(script: string, args: string[]): Promise<{ dir: string; pid: number }> {
    const dir = await sharedDir();
    const path = join(dir, "script.cjs");
    await writeFile(path, script);
    const resolved = args.map((arg) => arg.replace("<dir>", dir));
    const pid = SECOND_USER
      ? await startAsSecondUser(dir, path, resolved)
      : spawn(process.execPath, [path, ...resolved], { stdio: "ignore" }).pid!;
    started.push(pid);
    return { dir, pid };
  }

  async function readWhenWritten<T>(path: string): Promise<T> {
    await until(() => access(path).then(() => true, () => false), SECOND_USER_TIMEOUT_MS);
    return JSON.parse(await readFile(path, "utf8")) as T;
  }

  async function squat(pipe: string): Promise<{ pid: number; seen: () => Promise<Seen> }> {
    const { dir, pid } = await startScript(SQUATTER, [pipe, "<dir>\\seen.json"]);
    const seen = (): Promise<Seen> => readWhenWritten<Seen>(join(dir, "seen.json"));
    await seen();
    return { pid, seen };
  }

  function managerLog(dir: string): Promise<string> {
    return readFile(join(dir, "AppData", "Local", "crabeye", "logs", "daemon.log"), "utf8").catch(() => "");
  }

  async function statusPid(dir: string): Promise<number> {
    return (JSON.parse((await cli(dir, "status")).stdout) as { pid: number }).pid;
  }

  async function connect(dir: string): Promise<BridgeProcess> {
    await writeFile(join(dir, "stub.cjs"), STUB_STDIO_SERVER);
    const servers = {
      stub: { command: process.execPath, args: [join(dir, "stub.cjs")], _bridge: FAST_RECONNECT },
      svc: { url: "http://127.0.0.1:9/mcp", _bridge: FAST_RECONNECT },
    };
    const config = join(dir, "client.json");
    await writeFile(config, JSON.stringify({ mcpServers: servers }));
    const bridge = await connectBridgeProcess(cliScript, config, env(dir));
    bridges.push(bridge);
    return bridge;
  }

  it.each(["without", "with"])(
    "refuses a process serving the manager's pipe name %s a manager key, sending it only challenges",
    async (keyCase) => {
      const dir = await profile();
      if (keyCase === "with") {
        expect((await cli(dir, "start")).code).toBe(0);
        expect((await cli(dir, "stop")).code).toBe(0);
      }
      const pipe = inProfile(dir, getDaemonSocketPath);
      const startsBefore = occurrences(await managerLog(dir), "daemon starting");
      const squatter = await squat(pipe);

      const bridge = await connect(dir);
      const refused = (name: string) => bridge.stderr().includes(`[upstream:${name}] failed to connect: ${REFUSAL} ${pipe}`);
      await until(() => refused("stub") && refused("svc"), 30_000);

      for (const action of ["start", "status", "restart-upstream --all"]) {
        const result = await cli(dir, ...action.split(" "));
        expect(result.code, action).toBe(1);
        expect(result.stderr, action).toContain(`${REFUSAL} ${pipe}`);
      }
      expect((await cli(dir, "stop")).stderr).toContain(`${REFUSAL} ${pipe}`);

      const seen = await squatter.seen();
      if (keyCase === "without") expect(seen.bytes).toBe(0);
      else expect(seen.frames.length).toBeGreaterThan(0);
      expect(seen.frames).toEqual(seen.frames.map(() => ({ challenge: expect.stringMatching(/^[0-9a-f]{64}$/) })));
      expect(processExists(squatter.pid)).toBe(true);
      expect(occurrences(await managerLog(dir), "daemon starting")).toBe(startsBefore);

      await run(system32Path("taskkill.exe"), ["/F", "/T", "/PID", String(squatter.pid)]);
      await until(async () => !(await bridge.client.callTool(viaRunTool("stub__process", {}))).isError, 60_000);
    },
  );

  it("gives each profile under one account its own manager", async () => {
    const [first, second] = [await profile(), await profile()];
    expect(inProfile(first, getDaemonSocketPath)).not.toBe(inProfile(second, getDaemonSocketPath));

    const starts = await Promise.all([cli(first, "start"), cli(first, "start"), cli(second, "start")]);
    expect(starts.map((start) => start.code)).toEqual([0, 0, 0]);

    const [firstPid, secondPid] = [await statusPid(first), await statusPid(second)];
    expect(firstPid).toEqual(expect.any(Number));
    expect(secondPid).toEqual(expect.any(Number));
    expect(firstPid).not.toBe(secondPid);
  });

  it("runs the second-user checks on CI", () => {
    if (process.env.CI) expect(SECOND_USER).toBeTruthy();
  });

  it.runIf(SECOND_USER)("keeps another user from writing to the manager's pipe, reading its key, or reading anything from it", async () => {
    const dir = await profile();
    expect((await cli(dir, "start")).code).toBe(0);
    const [pipe, keyPath] = inProfile(dir, () => [getDaemonSocketPath(), getDaemonKeyPath()]);

    const { dir: probeDir } = await startScript(PROBE, [pipe, keyPath, "<dir>\\probe.json"]);

    const result = await readWhenWritten<Record<string, unknown>>(join(probeDir, "probe.json"));
    expect(result.user).not.toBe(userInfo().username);
    expect(["EPERM", "EACCES"]).toContain(result.write);
    expect(["EPERM", "EACCES"]).toContain(result.key);
    if (result.readOpen === undefined) {
      expect(result.readBytes).toBe(0);
      expect([undefined, "EOF", "EPIPE"]).toContain(result.readError);
    } else {
      expect(["EPERM", "EACCES"]).toContain(result.readOpen);
    }
    expect((await cli(dir, "status")).code).toBe(0);
  });
});
