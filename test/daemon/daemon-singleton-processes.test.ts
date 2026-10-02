import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bundleForSubprocess } from "../_helpers/subprocess-bundle.js";
import { isServing, netTransport } from "../../src/daemon/net-transport.js";
import { ManagerDaemon } from "../../src/daemon/manager.js";
import { DaemonLivenessSupervisor } from "../../src/daemon/liveness-supervisor.js";

const isWindows = process.platform === "win32";
const CONTENDERS = 8;
const STUB_SERVER = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const reply = (id, body) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...body }) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined || msg.method === undefined) return;
  if (msg.method === "initialize") {
    reply(msg.id, { result: { protocolVersion: msg.params.protocolVersion, serverInfo: { name: "stub", version: "0" }, capabilities: { tools: {} } } });
  } else if (msg.method === "tools/list") {
    reply(msg.id, { result: { tools: [] } });
  } else {
    reply(msg.id, { error: { code: -32601, message: "Method not found" } });
  }
});
`;

function firstLine(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes("\n")) resolve(out.trim());
    });
    child.once("exit", () => resolve(out.trim()));
  });
}

function exited(child: ChildProcessWithoutNullStreams, withinMs: number): Promise<number | null | "running"> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return Promise.race([
    new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code))),
    new Promise<"running">((resolve) => setTimeout(() => resolve("running"), withinMs)),
  ]);
}

function stderrMentions(child: ChildProcessWithoutNullStreams, text: string): Promise<void> {
  return new Promise((resolve) => {
    let err = "";
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString();
      if (err.includes(text)) resolve();
    });
  });
}

function childCommands(parentPid: number): string[] {
  return execFileSync("ps", ["-axo", "ppid=,command="], { encoding: "utf-8" })
    .split("\n")
    .filter((line) => Number(line.trim().split(/\s+/)[0]) === parentPid)
    .map((line) => line.trim().split(/\s+/).slice(1).join(" "));
}

async function waitUntil(condition: () => boolean, withinMs: number): Promise<void> {
  const deadline = Date.now() + withinMs;
  while (!condition() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""]);
  await new Promise((r) => child.once("exit", r));
  return child.pid!;
}

function daemonPidsRunning(script: string): number[] {
  return execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf-8" })
    .split("\n")
    .filter((line) => line.includes(script) && line.includes("daemon --internal-launch"))
    .map((line) => Number(line.trim().split(/\s+/)[0]));
}

describe.skipIf(isWindows)("daemon singleton across real processes (#205)", () => {
  let acquireScript: string;
  let managerScript: string;
  let cliScript: string;
  let dir: string;
  const children: ChildProcessWithoutNullStreams[] = [];

  beforeAll(async () => {
    [acquireScript, managerScript, cliScript] = await Promise.all([
      bundleForSubprocess("test/_helpers/subprocess/acquire-lock.ts", "acquire-lock"),
      bundleForSubprocess("test/_helpers/subprocess/start-manager.ts", "start-manager"),
      bundleForSubprocess("src/index.ts", "cli"),
    ]);
  });

  afterEach(async () => {
    const leftovers = children.splice(0);
    for (const child of leftovers) {
      child.stdin.end();
      child.kill("SIGTERM");
    }
    const exits = await Promise.all(leftovers.map((child) => exited(child, 6_000)));
    leftovers.forEach((child, i) => {
      if (exits[i] === "running") child.kill("SIGKILL");
    });
    for (const pid of daemonPidsRunning(cliScript)) process.kill(pid, "SIGTERM");
    await waitUntil(() => daemonPidsRunning(cliScript).length === 0, 5_000);
    await rm(dir, { recursive: true, force: true });
  }, 20_000);

  function start(args: string[], env?: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
    const child = spawn(process.execPath, args, { stdio: "pipe", env: env ?? process.env });
    children.push(child);
    return child;
  }

  it.each([1, 2, 3])("processes stealing a dead daemon's lock: exactly one holds it (run %i)", async () => {
    dir = await mkdtemp("/tmp/cbe-steal-");
    const lockPath = join(dir, "m.lock");
    await writeFile(lockPath, `${await deadPid()}\n`);

    const verdicts = await Promise.all(
      Array.from({ length: CONTENDERS }, () => firstLine(start([acquireScript, lockPath]))),
    );

    expect(verdicts.filter((v) => v === "held")).toHaveLength(1);
    expect(verdicts.filter((v) => v === "busy")).toHaveLength(CONTENDERS - 1);
  });

  it("daemon processes racing on one run dir: exactly one serves, the rest defer", async () => {
    dir = await mkdtemp("/tmp/cbe-mgr-");
    const socketPath = join(dir, "m.sock");

    const verdicts = await Promise.all(
      Array.from({ length: CONTENDERS }, () => firstLine(start([managerScript, "daemon", "--internal-launch", socketPath]))),
    );

    expect(verdicts.filter((v) => v === "serving")).toHaveLength(1);
    expect(
      verdicts.filter((v) => /^lost: (LockBusyError|DaemonAlreadyRunningError)$/.test(v)),
    ).toHaveLength(CONTENDERS - 1);
    expect(await isServing(socketPath)).toBe(true);
  });

  it("a bridge kills the daemon it was connected to once that daemon freezes", async () => {
    dir = await mkdtemp("/tmp/cbe-frozen-");
    const socketPath = join(dir, "m.sock");
    const daemon = start([managerScript, "daemon", "--internal-launch", socketPath]);
    expect(await firstLine(daemon)).toBe("serving");
    let ensureCalls = 0;
    const sup = new DaemonLivenessSupervisor({
      socketPath,
      rpcTimeoutMs: 300,
      heartbeatMs: 100,
      respawnLockWaitMs: 500,
      lockPath: join(dir, "m.lock"),
      pidPath: join(dir, "m.pid"),
      _ensureDaemonRunning: async () => {
        ensureCalls++;
      },
    });
    await sup.connect();
    await new Promise((r) => setTimeout(r, 300));
    await writeFile(join(dir, "m.pid"), `${await deadPid()}\n`);

    daemon.kill("SIGSTOP");
    const killedBy = await Promise.race([
      new Promise<NodeJS.Signals | null>((resolve) => daemon.once("exit", (_code, signal) => resolve(signal))),
      new Promise<string>((resolve) => setTimeout(() => resolve("still running"), 5_000)),
    ]);

    expect(killedBy).toBe("SIGKILL");
    expect(sup._statsForTest().sigkillsIssued).toBe(1);
    await waitUntil(() => ensureCalls > 0, 2_000);
    await sup.close();
  }, 15_000);

  it("a daemon launched while another serves defers and exits 0", async () => {
    dir = await mkdtemp("/tmp/cbe-defer-");
    const runDir = join(dir, ".crabeye", "run");
    const live = new ManagerDaemon({
      socketPath: join(runDir, "manager.sock"),
      pidPath: join(runDir, "manager.pid"),
      lockPath: join(runDir, "manager.lock"),
      idleMs: 60_000,
      transport: netTransport,
      processTrackerPath: join(runDir, "processes.json"),
    });
    await live.start();

    try {
      const late = start([cliScript, "daemon", "--internal-launch"], { ...process.env, HOME: dir });
      const deferred = stderrMentions(late, "deferring to existing daemon");

      expect(await exited(late, 10_000)).toBe(0);
      await deferred;
    } finally {
      await live.stop(0);
    }
  }, 15_000);

  it("a daemon launched while another holds the lock defers and exits 0", async () => {
    dir = await mkdtemp("/tmp/cbe-busy-");
    const runDir = join(dir, ".crabeye", "run");
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    const holder = start(["-e", "setInterval(() => {}, 1000)", "daemon", "--internal-launch"]);
    await writeFile(join(runDir, "manager.lock"), `${holder.pid}\nholder\n`);

    const late = start([cliScript, "daemon", "--internal-launch"], { ...process.env, HOME: dir });
    const deferred = stderrMentions(late, "deferring to existing daemon");

    expect(await exited(late, 10_000)).toBe(0);
    await deferred;
  }, 15_000);

  it("several bridges with several upstreams starting at once share one daemon", async () => {
    dir = await mkdtemp("/tmp/cbe-fleet-");
    const servers: Record<string, { command: string; args: string[] }> = {};
    for (const name of ["alpha", "beta", "gamma"]) {
      const stub = join(dir, `stub-${name}.cjs`);
      await writeFile(stub, STUB_SERVER);
      servers[name] = { command: process.execPath, args: [stub] };
    }
    const configPath = join(dir, "client.json");
    await writeFile(configPath, JSON.stringify({ mcpServers: servers }));
    const env = { ...process.env, HOME: dir };

    const bridges = Array.from({ length: 4 }, () => start([cliScript, "--config", configPath], env));
    await Promise.all(bridges.map((b) => stderrMentions(b, "ready —")));

    const daemons = daemonPidsRunning(cliScript);
    try {
      expect(daemons).toHaveLength(1);
      const recorded = Number((await readFile(join(dir, ".crabeye", "run", "manager.pid"), "utf-8")).trim());
      expect(daemons).toEqual([recorded]);
    } finally {
      for (const bridge of bridges) bridge.stdin.end();
      const exits = await Promise.all(bridges.map((bridge) => exited(bridge, 6_000)));
      expect(exits).toEqual(bridges.map(() => 0));
    }
  }, 30_000);

  it("a bridge's STDIO upstream recovers after its daemon is killed", async () => {
    dir = await mkdtemp("/tmp/cbe-recover-");
    const stub = join(dir, "stub-alpha.cjs");
    await writeFile(stub, STUB_SERVER);
    const configPath = join(dir, "client.json");
    await writeFile(configPath, JSON.stringify({ mcpServers: { alpha: { command: process.execPath, args: [stub] } } }));
    const bridge = start([cliScript, "--config", configPath], { ...process.env, HOME: dir });
    let stderr = "";
    bridge.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    await waitUntil(() => /\[upstream:alpha\] connected/.test(stderr), 10_000);
    const [firstDaemon] = daemonPidsRunning(cliScript);
    expect(firstDaemon).toBeDefined();

    process.kill(firstDaemon!, "SIGKILL");
    const servedByNewDaemon = () => {
      const successor = daemonPidsRunning(cliScript).find((pid) => pid !== firstDaemon);
      return successor !== undefined && childCommands(successor).some((cmd) => cmd.includes(stub));
    };
    await waitUntil(servedByNewDaemon, 20_000);

    expect(stderr).toMatch(/\[daemon-stdio:alpha\] force_respawn .*sessionsReopened=1/);
    expect(servedByNewDaemon()).toBe(true);
  }, 40_000);

  it("a bridge exits when its client closes stdin", async () => {
    dir = await mkdtemp("/tmp/cbe-cli-");
    const configPath = join(dir, "client.json");
    await writeFile(configPath, JSON.stringify({ mcpServers: {} }));
    const bridge = start([cliScript, "--config", configPath], { ...process.env, HOME: dir });
    await stderrMentions(bridge, "ready —");

    bridge.stdin.end();

    expect(await exited(bridge, 4_000)).toBe(0);
  }, 10_000);
});
