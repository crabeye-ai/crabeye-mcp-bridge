import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { daemonFilesFor } from "../../src/daemon/paths.js";
import { APP_VERSION, BRIDGE_CONFIG_FILENAME, CREDENTIALS_DIR } from "../../src/constants.js";
import { closeServer, serveFrames } from "../_helpers/frame-server.js";
import { countingLauncher } from "../_helpers/launchers.js";

vi.mock("../../src/daemon/daemon-process.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/daemon/daemon-process.js")>()),
  terminateDaemon: vi.fn(async () => "not_ours"),
}));

const { DaemonUnresponsiveError, daemonStatus, ensureDaemonRunning } = await import("../../src/daemon/bootstrap.js");
const { loadDaemonShutdownWaitMs } = await import("../../src/config/bridge-config.js");
const { MAX_AWAIT_PREDECESSOR_MS } = await import("../../src/daemon/daemon-launch.js");

const isWindows = process.platform === "win32";

describe.skipIf(isWindows)("replacing a recorded older daemon", { timeout: 30_000 }, () => {
  let dir: string;
  let socketPath: string;
  let server: Server | null;
  let successor: Server | null;
  let oldDaemon: ChildProcess;
  let requests: string[];

  beforeEach(async () => {
    dir = await mkdtemp("/tmp/cbe-boot-survivor-");
    socketPath = join(dir, "manager.sock");
    requests = [];
    server = null;
    successor = null;
    vi.stubEnv("HOME", dir);
    await mkdir(join(dir, CREDENTIALS_DIR));
    await killGraceMs(0);
    oldDaemon = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)", "daemon", "--internal-launch"], { stdio: "ignore" });
    await writeFile(daemonFilesFor(socketPath).pidPath, `${oldDaemon.pid}\n`);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    oldDaemon.kill("SIGKILL");
    for (const listening of [server, successor]) if (listening !== null) await closeServer(listening);
    await rm(dir, { recursive: true, force: true });
  });

  async function killGraceMs(ms: number): Promise<void> {
    await writeFile(join(dir, CREDENTIALS_DIR, BRIDGE_CONFIG_FILENAME), JSON.stringify({ _bridge: { daemon: { killGraceMs: ms } } }));
  }

  async function serveOlderDaemonThatStopsAnswering({ exitOnShutdown = false } = {}): Promise<void> {
    server = await serveFrames(socketPath, ({ method }, older) => {
      requests.push(method);
      if (method === "SHUTDOWN") {
        setImmediate(() => void closeServer(older));
        if (exitOnShutdown) oldDaemon.kill("SIGKILL");
      }
      return method === "STATUS" ? { pid: oldDaemon.pid } : { ok: true };
    });
  }

  it("reports the process it could not identify instead of a generic timeout, without waiting for it to exit", async () => {
    await serveOlderDaemonThatStopsAnswering();
    const { launch, calls } = countingLauncher("waiting");
    const startedAt = Date.now();

    const attempt = ensureDaemonRunning({ socketPath, launch, _startingDaemonWaitMs: 300 });

    await expect(attempt).rejects.toBeInstanceOf(DaemonUnresponsiveError);
    await expect(attempt).rejects.toMatchObject({ reason: "unconfirmed", pid: oldDaemon.pid });
    expect(Date.now() - startedAt).toBeLessThan(4_500);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.awaitPredecessorMs).toBeGreaterThan(2 * (await loadDaemonShutdownWaitMs()) + 5_000);
  });

  it("waits for the daemon it launched to answer once the older one has exited", async () => {
    await serveOlderDaemonThatStopsAnswering({ exitOnShutdown: true });
    const oldExited = new Promise<void>((resolve) => oldDaemon.once("exit", () => resolve()));
    const serveSuccessorLate = async (): Promise<void> => {
      await oldExited;
      await new Promise((r) => setTimeout(r, 300));
      successor = await serveFrames(socketPath, () => ({ pid: process.pid, appVersion: APP_VERSION }));
    };

    await ensureDaemonRunning({
      socketPath,
      launch: async () => {
        void serveSuccessorLate();
        return "waiting";
      },
    });

    expect(requests).toContain("SHUTDOWN");
    expect((await daemonStatus(socketPath))?.appVersion).toBe(APP_VERSION);
  });

  it("leaves the older daemon running when the daemon launched to replace it is gone before it is ready", async () => {
    await serveOlderDaemonThatStopsAnswering();
    const { launch, calls } = countingLauncher("gone");

    await ensureDaemonRunning({ socketPath, launch });

    expect(requests.filter((method) => method !== "STATUS")).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("does not ask a different daemon to stop when one has taken over the socket by then", async () => {
    let tookOver = false;
    server = await serveFrames(socketPath, ({ method }) => {
      requests.push(method);
      return method === "STATUS" ? { pid: tookOver ? process.pid : oldDaemon.pid } : { ok: true };
    });

    await ensureDaemonRunning({
      socketPath,
      _startingDaemonWaitMs: 300,
      launch: async () => {
        tookOver = true;
        return "waiting";
      },
    });

    expect(requests).not.toContain("SHUTDOWN");
  });

  it("never asks the older daemon to stop after a launch that reports no successor state", async () => {
    await serveOlderDaemonThatStopsAnswering();

    await ensureDaemonRunning({ socketPath, launch: countingLauncher("launched").launch });

    expect(requests.filter((method) => method !== "STATUS")).toEqual([]);
  });

  it("does not ask anything to stop when the launched daemon found nothing in its way", async () => {
    await serveOlderDaemonThatStopsAnswering();
    const { launch, calls } = countingLauncher("serving");

    await ensureDaemonRunning({ socketPath, launch });

    expect(requests.filter((method) => method !== "STATUS")).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("caps how long the launched daemon waits, whatever the configured kill grace", async () => {
    await killGraceMs(3_600_000);
    await serveOlderDaemonThatStopsAnswering();
    const { launch, calls } = countingLauncher("gone");

    await ensureDaemonRunning({ socketPath, launch });

    expect(calls).toEqual([{ awaitPredecessorMs: MAX_AWAIT_PREDECESSOR_MS }]);
  });
});
