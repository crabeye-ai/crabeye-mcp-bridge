import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { bundleForSubprocess } from "../_helpers/subprocess-bundle.js";
import { isDaemonReachable } from "../../src/daemon/bootstrap.js";
import { DAEMON_LAUNCH_ARGS } from "../../src/daemon/daemon-identity.js";
import { encodeFrame, FrameDecoder } from "../../src/daemon/protocol.js";
import { readPidFile, waitForExit } from "../../src/daemon/daemon-process.js";
import { processExists } from "../../src/process/process-utils.js";

const RECOVERY_WAIT_MS = 1_500;
const CONCURRENT_BRIDGES = 3;

function daemonPidsRunning(script: string): number[] {
  return execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf-8" })
    .split("\n")
    .filter((line) => line.includes(script) && line.includes(DAEMON_LAUNCH_ARGS.join(" ")))
    .map((line) => Number(line.trim().split(/\s+/)[0]));
}

function firstLine(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const newline = out.indexOf("\n");
      if (newline >= 0) resolve(out.slice(0, newline));
    });
    child.once("exit", () => resolve(out.trim()));
  });
}

async function waitUntil(check: () => Promise<boolean> | boolean, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

describe.skipIf(process.platform === "win32")("recovering a wedged daemon across real processes (#211)", () => {
  let cliScript: string;
  let ensureScript: string;
  let dir: string;
  let wedgedPid: number | null = null;
  const children: ChildProcessWithoutNullStreams[] = [];

  beforeAll(async () => {
    [cliScript, ensureScript] = await Promise.all([
      bundleForSubprocess("src/index.ts", "cli"),
      bundleForSubprocess("test/_helpers/subprocess/ensure-daemon.ts", "ensure-daemon"),
    ]);
  });

  afterEach(async () => {
    if (wedgedPid !== null && processExists(wedgedPid)) process.kill(wedgedPid, "SIGKILL");
    wedgedPid = null;
    for (const child of children.splice(0)) child.kill("SIGKILL");
    for (const pid of daemonPidsRunning(cliScript)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    await waitUntil(() => daemonPidsRunning(cliScript).length === 0, 5_000);
    if (dir) await rm(dir, { recursive: true, force: true });
  }, 20_000);

  function start(args: string[], env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
    const child = spawn(process.execPath, args, { stdio: "pipe", env });
    children.push(child);
    return child;
  }

  async function startWedgedDaemon(): Promise<{ env: NodeJS.ProcessEnv; socketPath: string }> {
    dir = await mkdtemp("/tmp/cbe-wedge-");
    const env = { ...process.env, HOME: dir };
    const runDir = join(dir, ".crabeye", "run");
    const socketPath = join(runDir, "manager.sock");
    start([cliScript, ...DAEMON_LAUNCH_ARGS], env);
    expect(await waitUntil(() => isDaemonReachable(socketPath), 10_000)).toBe(true);
    wedgedPid = await readPidFile(join(runDir, "manager.pid"));
    expect(wedgedPid).not.toBeNull();
    process.kill(wedgedPid!, "SIGSTOP");
    expect(await isDaemonReachable(socketPath)).toBe(false);
    return { env, socketPath };
  }

  it("a bridge replaces a stopped daemon nobody else is connected to", async () => {
    const { env, socketPath } = await startWedgedDaemon();

    const verdict = await firstLine(start([ensureScript, socketPath, cliScript, String(RECOVERY_WAIT_MS)], env));

    expect(verdict).toBe("ok 1");
    expect(await waitForExit(wedgedPid!, 2_000)).toBe(true);
    expect(await isDaemonReachable(socketPath)).toBe(true);
    expect(daemonPidsRunning(cliScript).filter((pid) => pid !== wedgedPid)).toHaveLength(1);
  }, 40_000);

  it("several bridges recovering at once start exactly one replacement daemon", async () => {
    const { env, socketPath } = await startWedgedDaemon();

    const verdicts = await Promise.all(
      Array.from({ length: CONCURRENT_BRIDGES }, () =>
        firstLine(start([ensureScript, socketPath, cliScript, String(RECOVERY_WAIT_MS)], env)),
      ),
    );

    expect(verdicts.every((v) => v.startsWith("ok "))).toBe(true);
    expect(verdicts.reduce((total, v) => total + Number(v.split(" ")[1]), 0)).toBe(1);
    expect(await waitForExit(wedgedPid!, 2_000)).toBe(true);
    expect(await waitUntil(() => daemonPidsRunning(cliScript).length === 1, 5_000)).toBe(true);
    expect(await isDaemonReachable(socketPath)).toBe(true);
  }, 60_000);

  async function runDir(): Promise<string> {
    const path = join(dir, ".crabeye", "run");
    await mkdir(path, { recursive: true, mode: 0o700 });
    return path;
  }

  async function stopWithPidfileNaming(pid: number): Promise<string> {
    await writeFile(join(await runDir(), "manager.pid"), `${pid}\n`);
    return runStop();
  }

  async function runStop(): Promise<string> {
    const env = { ...process.env, HOME: dir };
    const stop = start([cliScript, "daemon", "stop"], env);
    let stderr = "";
    stop.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    await new Promise((r) => stop.once("exit", r));
    return stderr;
  }

  it("daemon stop never signals a pidfile process that is not a daemon", async () => {
    dir = await mkdtemp("/tmp/cbe-stop-");
    const stranger = start(["-e", "setInterval(() => {}, 1e6)"], process.env);

    const stderr = await stopWithPidfileNaming(stranger.pid!);

    expect(processExists(stranger.pid!)).toBe(true);
    expect(stderr).toMatch(/is a different program; not signalling it/);
  }, 20_000);

  it("daemon stop terminates an unresponsive daemon named by the pidfile", async () => {
    dir = await mkdtemp("/tmp/cbe-stop-");
    const daemon = start(["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1e6)", ...DAEMON_LAUNCH_ARGS], process.env);
    await new Promise((r) => setTimeout(r, 200));

    const stderr = await stopWithPidfileNaming(daemon.pid!);

    expect(await waitForExit(daemon.pid!, 2_000)).toBe(true);
    expect(stderr).toMatch(/unresponsive daemon \d+ stopped/);
    expect(stderr).not.toMatch(/daemon not running/);
  }, 20_000);

  it("daemon stop finds an unresponsive daemon through the lock when no pidfile was written", async () => {
    dir = await mkdtemp("/tmp/cbe-stop-");
    const daemon = start(["-e", "setInterval(() => {}, 1e6)", ...DAEMON_LAUNCH_ARGS], process.env);
    await writeFile(join(await runDir(), "manager.lock"), `${daemon.pid}\ntoken\n`);
    await new Promise((r) => setTimeout(r, 200));

    const stderr = await runStop();

    expect(await waitForExit(daemon.pid!, 2_000)).toBe(true);
    expect(stderr).toMatch(/unresponsive daemon \d+ stopped/);
  }, 20_000);

  it("daemon stop force-stops a daemon that acknowledges shutdown but never exits", async () => {
    dir = await mkdtemp("/tmp/cbe-stop-");
    const run = await runDir();
    const daemon = start(["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1e6)", ...DAEMON_LAUNCH_ARGS], process.env);
    await writeFile(join(run, "manager.pid"), `${daemon.pid}\n`);
    const acknowledging = createServer((sock: Socket) => {
      const decoder = new FrameDecoder();
      sock.on("data", (chunk: Buffer) => {
        decoder.push(chunk);
        for (let frame = decoder.next(); frame !== null; frame = decoder.next()) {
          const request = frame as { id?: string };
          sock.write(encodeFrame({ id: request.id, result: { ok: true } }));
        }
      });
    });
    await new Promise<void>((r) => acknowledging.listen(join(run, "manager.sock"), () => r()));

    try {
      const stderr = await runStop();

      expect(await waitForExit(daemon.pid!, 2_000)).toBe(true);
      expect(stderr).toMatch(/^daemon \d+ force-stopped$/m);
      expect(stderr).not.toMatch(/unresponsive/);
    } finally {
      await new Promise<void>((r) => acknowledging.close(() => r()));
    }
  }, 20_000);
});
