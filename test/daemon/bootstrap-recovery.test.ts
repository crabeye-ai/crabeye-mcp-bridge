import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DaemonUnreachableError, DaemonUnresponsiveError, ensureDaemonRunning } from "../../src/daemon/bootstrap.js";
import { DAEMON_LAUNCH_ARGS } from "../../src/daemon/daemon-identity.js";
import { waitForExit } from "../../src/daemon/daemon-process.js";
import { processExists } from "../../src/process/process-utils.js";
import { encodeFrame, FrameDecoder } from "../../src/daemon/protocol.js";

const WAIT_MS = 2_500;
const DAEMON_ARGS = [...DAEMON_LAUNCH_ARGS];
const SILENT_SERVER = `
  require("node:net").createServer(() => {}).listen(process.argv[1]);
  process.on("SIGTERM", () => require("node:fs").writeFileSync(process.argv[2], String(Date.now())));
`;
const BLOCKED_SERVER = `
  require("node:net").createServer(() => {}).listen(process.argv[1], 1, () => { for (;;) {} });
`;
const IDLE = "setInterval(() => {}, 1e6)";

interface Launch {
  at: number;
  wedgedAlive: boolean;
}

describe.skipIf(process.platform === "win32")("ensureDaemonRunning with a wedged daemon", { timeout: 60_000 }, () => {
  let dir: string;
  let socketPath: string;
  let lockPath: string;
  let pidPath: string;
  let sigtermLog: string;
  const children: ChildProcess[] = [];
  const servers: Server[] = [];

  beforeEach(async () => {
    dir = await mkdtemp("/tmp/cbe-boot-");
    socketPath = join(dir, "manager.sock");
    lockPath = join(dir, "manager.lock");
    pidPath = join(dir, "manager.pid");
    sigtermLog = join(dir, "sigterm-at");
  });

  afterEach(async () => {
    for (const child of children.splice(0)) child.kill("SIGKILL");
    for (const server of servers.splice(0)) await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  });

  function spawnTracked(args: string[]): ChildProcess {
    const child = spawn(process.execPath, args, { stdio: "ignore" });
    children.push(child);
    return child;
  }

  async function startWedgedDaemon(script = SILENT_SERVER, args = DAEMON_ARGS): Promise<ChildProcess> {
    const child = spawnTracked(["-e", script, socketPath, sigtermLog, ...args]);
    await waitUntil(() => stat(socketPath).then(() => true, () => false));
    await new Promise((r) => setTimeout(r, 100));
    return child;
  }

  function startAnsweringServer(): Promise<void> {
    const server = createServer((sock: Socket) => {
      const decoder = new FrameDecoder();
      sock.on("data", (chunk: Buffer) => {
        decoder.push(chunk);
        for (let frame = decoder.next(); frame !== null; frame = decoder.next()) {
          const request = frame as { id?: string; method?: string };
          if (request.method === "STATUS") sock.write(encodeFrame({ id: request.id, result: { pid: process.pid } }));
        }
      });
    });
    servers.push(server);
    return new Promise((resolve) => server.listen(socketPath, () => resolve()));
  }

  async function replaceWithAnsweringServer(): Promise<void> {
    await unlink(socketPath).catch(() => {});
    await startAnsweringServer();
  }

  function launchReplacement(log: Launch[], wedged?: ChildProcess) {
    return () => {
      log.push({ at: Date.now(), wedgedAlive: wedged?.pid !== undefined && processExists(wedged.pid) });
      void replaceWithAnsweringServer();
    };
  }

  async function lockHeldBy(pid: number): Promise<void> {
    await writeFile(lockPath, `${pid}\ntoken-${pid}\n`);
  }

  async function deadPid(): Promise<number> {
    const child = spawn(process.execPath, ["-e", "0"]);
    await new Promise((r) => child.once("exit", r));
    return child.pid!;
  }

  it("replaces a wedged daemon only after the wait, launching nothing while it is wedged", async () => {
    const wedged = await startWedgedDaemon();
    await lockHeldBy(wedged.pid!);
    const launches: Launch[] = [];
    const startedAt = Date.now();

    await ensureDaemonRunning({ socketPath, _startingDaemonWaitMs: WAIT_MS, launch: launchReplacement(launches, wedged) });

    expect(Number(await readFile(sigtermLog, "utf-8")) - startedAt).toBeGreaterThanOrEqual(WAIT_MS);
    expect(launches).toHaveLength(1);
    expect(launches[0]!.wedgedAlive).toBe(false);
  });

  it("still recovers a daemon whose listen queue is full and refuses connections", async () => {
    const wedged = await startWedgedDaemon(BLOCKED_SERVER);
    await lockHeldBy(wedged.pid!);
    const launches: Launch[] = [];

    await ensureDaemonRunning({ socketPath, _startingDaemonWaitMs: WAIT_MS, launch: launchReplacement(launches, wedged) });

    expect(launches).toHaveLength(1);
    expect(launches[0]!.wedgedAlive).toBe(false);
    expect(await waitForExit(wedged.pid!, 1_000)).toBe(true);
  });

  it("finds the wedged daemon through the pidfile when the lock names a dead process", async () => {
    const wedged = await startWedgedDaemon();
    await lockHeldBy(await deadPid());
    await writeFile(pidPath, `${wedged.pid}\n`);
    const launches: Launch[] = [];

    await ensureDaemonRunning({ socketPath, _startingDaemonWaitMs: WAIT_MS, launch: launchReplacement(launches, wedged) });

    expect(launches).toHaveLength(1);
    expect(await waitForExit(wedged.pid!, 1_000)).toBe(true);
  });

  it("stops the lock holder, not a different daemon named by a stale pidfile", async () => {
    const wedged = await startWedgedDaemon();
    await lockHeldBy(wedged.pid!);
    const bystander = spawnTracked(["-e", IDLE, ...DAEMON_ARGS]);
    await writeFile(pidPath, `${bystander.pid}\n`);
    const launches: Launch[] = [];

    await ensureDaemonRunning({ socketPath, _startingDaemonWaitMs: WAIT_MS, launch: launchReplacement(launches, wedged) });

    expect(await waitForExit(wedged.pid!, 1_000)).toBe(true);
    expect(processExists(bystander.pid!)).toBe(true);
  });

  it("leaves an unrelated program recorded for a silent socket running, and reports the socket", async () => {
    const stranger = await startWedgedDaemon(SILENT_SERVER, []);
    await lockHeldBy(stranger.pid!);
    const launches: Launch[] = [];

    const attempt = ensureDaemonRunning({ socketPath, _startingDaemonWaitMs: WAIT_MS, launch: launchReplacement(launches) });

    await expect(attempt).rejects.toMatchObject({ reason: "unrecorded" });
    expect(processExists(stranger.pid!)).toBe(true);
    expect(launches).toHaveLength(0);
    await expect(stat(`${lockPath}.recover`)).rejects.toThrow();
  });

  it("reports a silent socket with no recorded daemon instead of launching over it", async () => {
    await startWedgedDaemon(SILENT_SERVER, []);
    const launches: Launch[] = [];

    const attempt = ensureDaemonRunning({ socketPath, _startingDaemonWaitMs: WAIT_MS, launch: launchReplacement(launches) });

    await expect(attempt).rejects.toBeInstanceOf(DaemonUnresponsiveError);
    await expect(attempt).rejects.toMatchObject({ reason: "unrecorded" });
    expect(launches).toHaveLength(0);
  });

  it("leaves a daemon alone when it starts answering before the deadline", async () => {
    const holder = spawnTracked(["-e", IDLE, ...DAEMON_ARGS]);
    await lockHeldBy(holder.pid!);
    await startWedgedDaemon(SILENT_SERVER, []);
    const launches: Launch[] = [];

    const attempt = ensureDaemonRunning({ socketPath, _startingDaemonWaitMs: WAIT_MS * 2, launch: launchReplacement(launches) });
    await new Promise((r) => setTimeout(r, WAIT_MS / 2));
    await replaceWithAnsweringServer();
    await attempt;

    expect(launches).toHaveLength(0);
    expect(processExists(holder.pid!)).toBe(true);
  });

  it("restarts the wait for a new daemon that took over during it, and kills neither", async () => {
    const wedged = await startWedgedDaemon();
    await lockHeldBy(wedged.pid!);
    const successor = spawnTracked(["-e", IDLE, ...DAEMON_ARGS]);
    const launches: Launch[] = [];

    const attempt = ensureDaemonRunning({ socketPath, _startingDaemonWaitMs: WAIT_MS, launch: launchReplacement(launches, wedged) });
    await new Promise((r) => setTimeout(r, WAIT_MS - 500));
    await lockHeldBy(successor.pid!);
    await new Promise((r) => setTimeout(r, WAIT_MS - 500));
    await replaceWithAnsweringServer();
    await attempt;

    expect(launches).toHaveLength(0);
    expect(processExists(wedged.pid!)).toBe(true);
    expect(processExists(successor.pid!)).toBe(true);
  });

  it("waits while another bridge holds the recovery guard, then recovers once it is released", async () => {
    const wedged = await startWedgedDaemon();
    await lockHeldBy(wedged.pid!);
    const otherBridge = spawnTracked(["-e", IDLE]);
    const guardPath = `${lockPath}.recover`;
    await writeFile(guardPath, `${otherBridge.pid}\nrecovering\n`);
    const launches: Launch[] = [];
    let settled = false;

    const attempt = ensureDaemonRunning({ socketPath, _startingDaemonWaitMs: 400, launch: launchReplacement(launches, wedged) })
      .finally(() => (settled = true));
    await new Promise((r) => setTimeout(r, 10_000));
    expect(settled).toBe(false);
    expect(processExists(wedged.pid!)).toBe(true);
    await expect(stat(sigtermLog)).rejects.toThrow();
    expect(launches).toHaveLength(0);

    const releasedAt = Date.now();
    await unlink(guardPath);
    await attempt;
    expect(launches).toHaveLength(1);
    expect(launches[0]!.at).toBeGreaterThan(releasedAt);
    expect(launches[0]!.wedgedAlive).toBe(false);
  });

  it("takes over a recovery guard held for longer than any recovery can take", async () => {
    const wedged = await startWedgedDaemon();
    await lockHeldBy(wedged.pid!);
    const guardPath = `${lockPath}.recover`;
    await writeFile(guardPath, `${process.pid}\nstuck\n`);
    const longAgo = new Date(Date.now() - 10 * 60_000);
    await utimes(guardPath, longAgo, longAgo);
    const launches: Launch[] = [];

    await ensureDaemonRunning({ socketPath, _startingDaemonWaitMs: 400, launch: launchReplacement(launches, wedged) });

    expect(launches).toHaveLength(1);
  });

  it("takes over a recovery guard left by a bridge that died", async () => {
    const wedged = await startWedgedDaemon();
    await lockHeldBy(wedged.pid!);
    await writeFile(`${lockPath}.recover`, `${await deadPid()}\nabandoned\n`);
    const launches: Launch[] = [];

    await ensureDaemonRunning({ socketPath, _startingDaemonWaitMs: 400, launch: launchReplacement(launches, wedged) });

    expect(launches).toHaveLength(1);
  });

  it("launches a daemon when the recorded pid now belongs to an unrelated program", async () => {
    const unrelated = spawnTracked(["-e", IDLE]);
    await lockHeldBy(unrelated.pid!);
    await writeFile(pidPath, `${unrelated.pid}\n`);
    const launches: Launch[] = [];

    await ensureDaemonRunning({ socketPath, _startingDaemonWaitMs: WAIT_MS, launch: launchReplacement(launches) });

    expect(launches).toHaveLength(1);
    expect(processExists(unrelated.pid!)).toBe(true);
  });

  it("gives up after one replacement that never answers either, instead of replacing forever", async () => {
    const wedged = await startWedgedDaemon();
    await lockHeldBy(wedged.pid!);
    let launches = 0;
    const launchAnotherWedged = () => {
      launches++;
      const replacement = spawnTracked(["-e", IDLE, ...DAEMON_ARGS]);
      void writeFile(lockPath, `${replacement.pid}\nreplacement\n`);
    };

    await expect(
      ensureDaemonRunning({ socketPath, _startingDaemonWaitMs: 1_000, launch: launchAnotherWedged }),
    ).rejects.toBeInstanceOf(DaemonUnreachableError);
    expect(launches).toBe(1);
  });

  it("reports a launched daemon that never comes up after a single launch", async () => {
    let launches = 0;

    await expect(
      ensureDaemonRunning({ socketPath, _startingDaemonWaitMs: 1_000, launch: () => launches++ }),
    ).rejects.toBeInstanceOf(DaemonUnreachableError);
    expect(launches).toBe(1);
  });

  it("does not launch while another live bridge is mid-recovery, then launches once it is done", async () => {
    const otherBridge = spawnTracked(["-e", IDLE]);
    const guardPath = `${lockPath}.recover`;
    await writeFile(guardPath, `${otherBridge.pid}\nrecovering\n`);
    const launches: Launch[] = [];
    let settled = false;

    const attempt = ensureDaemonRunning({ socketPath, _startingDaemonWaitMs: 400, launch: launchReplacement(launches) })
      .finally(() => (settled = true));
    await new Promise((r) => setTimeout(r, 3_000));
    expect(settled).toBe(false);
    expect(launches).toHaveLength(0);

    await unlink(guardPath);
    await attempt;
    expect(launches).toHaveLength(1);
  });

  it("ignores a recovery guard older than any recovery can take when deciding to launch", async () => {
    const otherBridge = spawnTracked(["-e", IDLE]);
    const guardPath = `${lockPath}.recover`;
    await writeFile(guardPath, `${otherBridge.pid}\nstuck\n`);
    const longAgo = new Date(Date.now() - 10 * 60_000);
    await utimes(guardPath, longAgo, longAgo);
    const launches: Launch[] = [];
    const startedAt = Date.now();

    await ensureDaemonRunning({ socketPath, _startingDaemonWaitMs: 400, launch: launchReplacement(launches) });

    expect(launches).toHaveLength(1);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("recovers the pidfile daemon when an unrelated program holds the lock, leaving that program alone", async () => {
    const wedged = await startWedgedDaemon();
    const unrelated = spawnTracked(["-e", IDLE]);
    await lockHeldBy(unrelated.pid!);
    await writeFile(pidPath, `${wedged.pid}\n`);
    const launches: Launch[] = [];

    await ensureDaemonRunning({ socketPath, _startingDaemonWaitMs: WAIT_MS, launch: launchReplacement(launches, wedged) });

    expect(launches).toHaveLength(1);
    expect(launches[0]!.wedgedAlive).toBe(false);
    expect(processExists(unrelated.pid!)).toBe(true);
  });

  it("launches a daemon when a stale pidfile names this very process", async () => {
    await writeFile(pidPath, `${process.pid}\n`);
    await lockHeldBy(process.pid);
    const launches: Launch[] = [];
    const startedAt = Date.now();

    await ensureDaemonRunning({ socketPath, _startingDaemonWaitMs: WAIT_MS, launch: launchReplacement(launches) });

    expect(launches).toHaveLength(1);
    expect(Date.now() - startedAt).toBeLessThan(WAIT_MS);
  });

  it("treats a recovery guard naming this process, which it does not hold, as stale", async () => {
    const wedged = await startWedgedDaemon();
    await lockHeldBy(wedged.pid!);
    await writeFile(`${lockPath}.recover`, `${process.pid}\nleft-behind\n`);
    const launches: Launch[] = [];

    await ensureDaemonRunning({ socketPath, _startingDaemonWaitMs: 400, launch: launchReplacement(launches, wedged) });

    expect(launches).toHaveLength(1);
    expect(launches[0]!.wedgedAlive).toBe(false);
  });
});

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not met");
    await new Promise((r) => setTimeout(r, 20));
  }
}
