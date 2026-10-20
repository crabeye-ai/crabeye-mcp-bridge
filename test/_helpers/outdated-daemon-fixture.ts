import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { ensureDaemonRunning, type EnsureAttemptOptions } from "../../src/daemon/bootstrap.js";
import type { DaemonLauncher, LaunchOptions, LaunchOutcome } from "../../src/daemon/daemon-launch.js";
import { APP_NAME, APP_VERSION, BRIDGE_CONFIG_FILENAME, CREDENTIALS_DIR } from "../../src/constants.js";
import type { Logger } from "../../src/logging/index.js";
import { spyLogger } from "./spy-logger.js";
import { closeServer, DROP_CONNECTION, serveFrames } from "./frame-server.js";

export function stillOutdated(label = "unknown"): [string, { component: string }] {
  return [
    `a daemon from an older ${APP_NAME} version (${label}) is still running after an attempt to replace it; this bridge (${APP_VERSION}) will use it`,
    { component: "daemon" },
  ];
}

export type OnShutdown = "stop" | "keep-serving" | { stopAfterMs: number };

export type EnsureOptions = { logger?: Logger; launch?: DaemonLauncher; _startingDaemonWaitMs?: number } & EnsureAttemptOptions;

export function useOutdatedDaemonFixture() {
  const paths = { dir: "", socketPath: "", lockPath: "", recoveryGuardPath: "" };
  const requests: string[] = [];
  const launches: number[] = [];
  const launchOptions: LaunchOptions[] = [];
  const children: ChildProcess[] = [];
  const servers: Server[] = [];

  beforeEach(async () => {
    paths.dir = await mkdtemp("/tmp/cbe-boot-outdated-");
    paths.socketPath = join(paths.dir, "manager.sock");
    paths.lockPath = join(paths.dir, "manager.lock");
    paths.recoveryGuardPath = `${paths.lockPath}.recover`;
    for (const recorded of [requests, launches, launchOptions]) recorded.length = 0;
    vi.stubEnv("HOME", paths.dir);
    await mkdir(join(paths.dir, CREDENTIALS_DIR));
    await useKillGrace(0);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const child of children.splice(0)) child.kill("SIGKILL");
    await closeServers();
    await rm(paths.dir, { recursive: true, force: true });
  });

  function useKillGrace(killGraceMs: number): Promise<void> {
    return writeFile(join(paths.dir, CREDENTIALS_DIR, BRIDGE_CONFIG_FILENAME), JSON.stringify({ _bridge: { daemon: { killGraceMs } } }));
  }

  async function serveTracked(reply: Parameters<typeof serveFrames>[1]): Promise<void> {
    servers.push(await serveFrames(paths.socketPath, reply));
  }

  async function closeServers(): Promise<void> {
    for (const server of servers.splice(0)) await closeServer(server);
  }

  function serveOlderDaemon(onShutdown: OnShutdown, answer: (statusCount: number) => Record<string, unknown> = () => ({})): Promise<void> {
    let statuses = 0;
    return serveTracked(({ method }, server) => {
      requests.push(method);
      if (method === "SHUTDOWN" && onShutdown !== "keep-serving") {
        const delayMs = onShutdown === "stop" ? 0 : onShutdown.stopAfterMs;
        setTimeout(() => server.close(() => requests.push("closed")), delayMs);
      }
      return method === "STATUS" ? { pid: process.pid, ...answer(++statuses) } : { ok: true };
    });
  }

  const recoveryGuardHeld = () => existsSync(paths.recoveryGuardPath);

  function serveOlderDaemonGoneOnceGuardHeld(): Promise<void> {
    return serveTracked(({ method }, server) => {
      requests.push(method);
      if (!recoveryGuardHeld()) return { pid: process.pid };
      void closeServer(server);
      return DROP_CONNECTION;
    });
  }

  async function countLaunch(opts: LaunchOptions = {}): Promise<LaunchOutcome> {
    launches.push(Date.now());
    launchOptions.push(opts);
    return "launched";
  }

  async function launchCurrentDaemon(opts: LaunchOptions = {}): Promise<LaunchOutcome> {
    await countLaunch(opts);
    requests.push("launch");
    void serveTracked(({ method }) => (method === "STATUS" ? { pid: process.pid, appVersion: APP_VERSION } : { ok: true }));
    return "launched";
  }

  function launchDaemonReporting(status: Record<string, unknown>): DaemonLauncher {
    return async (opts) => {
      await countLaunch(opts);
      void serveTracked(({ method }) => {
        requests.push(method);
        return method === "STATUS" ? { pid: process.pid, ...status } : { ok: true };
      });
      return "launched";
    };
  }

  function ensure({ logger = spyLogger(), launch = countLaunch, ...attempt }: EnsureOptions = {}) {
    return ensureDaemonRunning({ socketPath: paths.socketPath, logger, launch, ...attempt });
  }

  const requestsNamed = (method: string) => requests.filter((name) => name === method);

  async function holdRecoveryGuardInAnotherBridge(): Promise<string> {
    const otherBridge = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { stdio: "ignore" });
    children.push(otherBridge);
    await writeFile(paths.recoveryGuardPath, `${otherBridge.pid}\nreplacing\n`);
    return paths.recoveryGuardPath;
  }

  return {
    paths,
    requests,
    launches,
    launchOptions,
    children,
    useKillGrace,
    serveTracked,
    closeServers,
    serveOlderDaemon,
    recoveryGuardHeld,
    serveOlderDaemonGoneOnceGuardHeld,
    countLaunch,
    launchCurrentDaemon,
    launchDaemonReporting,
    ensure,
    requestsNamed,
    holdRecoveryGuardInAnotherBridge,
  };
}
