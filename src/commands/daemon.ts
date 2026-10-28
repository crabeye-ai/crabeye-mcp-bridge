import {
  DaemonClient,
  DaemonRpcError,
  ManagerDaemon,
  daemonStatus,
  ensureDaemonRunning,
  isDaemonReachable,
  reportToLauncher,
  daemonFit,
  daemonVersionLabel,
  UNKNOWN_DAEMON_VERSION,
  olderDaemonStillRunning,
  reportedDaemonPid,
  daemonFilesFor,
  getDaemonSocketPath,
  netTransport,
  DaemonAlreadyRunningError,
  DaemonStoppedWhileStartingError,
  readPidFile,
  recordedPids,
  terminateDaemon,
  waitForExit,
  isSocketAddressError,
  createDaemonLogger,
  getDaemonLogPath,
  daemonStopBudgetMs,
  installCrashHandlers,
  installSignalHandlers,
  type ChildEraLabel,
  type DaemonStatus,
  type TerminateResult,
} from "../daemon/index.js";
import { LockBusyError, processExists } from "../process/index.js";
import { escapeLabel, type Logger } from "../logging/index.js";
import { getBridgeConfigPath, loadDaemonSettings, loadDaemonShutdownWaitMs } from "../config/bridge-config.js";
import { APP_NAME, APP_VERSION } from "../constants.js";

export type DaemonAction = "start" | "stop" | "status" | "restart";

interface StatusReply extends DaemonStatus {
  uptime?: unknown;
  children?: unknown;
  telemetry?: { upstreamRequests?: { refusedTotal?: unknown } };
}

const CHILD_ERAS: ReadonlySet<string> = new Set<ChildEraLabel>(["modern", "legacy", "unknown"]);

export interface RestartUpstreamOpts {
  hash?: string;
  all?: boolean;
  /** Test override for socket path. */
  _socketPath?: string;
}

const SHUTDOWN_RPC_TIMEOUT_MS = 2_000;

export async function runDaemonCommand(action: DaemonAction): Promise<number> {
  try {
    return await dispatch(action);
  } catch (err) {
    reportSocketAddressError(err);
    return 1;
  }
}

function reportSocketAddressError(err: unknown): void {
  if (!isSocketAddressError(err)) throw err;
  process.stderr.write(`${err.message}\n`);
}

function dispatch(action: DaemonAction): Promise<number> {
  switch (action) {
    case "start":
      return runStart();
    case "stop":
      return runStop();
    case "status":
      return runStatus();
    case "restart":
      return runRestart();
  }
}

/**
 * Run as the daemon process itself. Called from the CLI when invoked with
 * `--internal-launch`. Resolves when the manager exits.
 */
export async function runDaemonInternal(awaitPredecessorMs = 0): Promise<number> {
  const settings = await loadDaemonSettings();
  const cfg = settings.daemon;
  const logger = createDaemonLogger({ level: settings.logLevel });
  const log = logger.child({ component: "daemon" });

  const socketPath = getDaemonSocketPath();
  log.info("daemon starting", { version: APP_VERSION, socket: socketPath });
  if (settings.loadError !== undefined) {
    log.warn(`could not load ${getBridgeConfigPath()}; using defaults: ${settings.loadError}`);
  }
  let waitedForPredecessor = false;
  let manager: ManagerDaemon;
  try {
    manager = new ManagerDaemon({
      socketPath,
      ...daemonFilesFor(socketPath),
      idleMs: cfg.idleMs,
      graceMs: cfg.graceMs,
      killGraceMs: cfg.killGraceMs,
      childPingMs: cfg.childPingMs,
      childPingTimeoutMs: cfg.childPingTimeoutMs,
      childPingMaxConsecutiveFailures: cfg.childPingMaxConsecutiveFailures,
      transport: netTransport,
      awaitPredecessorMs,
      logger,
      onWaitingForPredecessor: () => {
        waitedForPredecessor = true;
        reportToLauncher("waiting");
      },
    });
  } catch (err) {
    return failedToStart(log, err);
  }
  installCrashHandlers({ logger, target: manager, watchdogMs: daemonStopBudgetMs(cfg.killGraceMs) });
  installSignalHandlers(manager);

  try {
    await manager.start();
  } catch (err) {
    if (err instanceof DaemonStoppedWhileStartingError) return manager.waitForExit();
    if (err instanceof LockBusyError || err instanceof DaemonAlreadyRunningError) {
      const deferral = `${err.message}; deferring to existing daemon`;
      log.info(deferral);
      process.stderr.write(`daemon: ${deferral}\n`);
      return 0;
    }
    return failedToStart(log, err);
  }
  if (!waitedForPredecessor && !manager.isStopping) reportToLauncher("serving");
  return manager.waitForExit();
}

function failedToStart(log: Logger, err: unknown): number {
  const failure = `daemon failed to start: ${errMsg(err)}`;
  log.error(failure);
  process.stderr.write(`${failure}\n`);
  return 1;
}

async function runStart(): Promise<number> {
  const socketPath = getDaemonSocketPath();
  const running = await daemonStatus(socketPath);
  if (running !== null && daemonFit(running) === "current") {
    process.stderr.write("daemon already running\n");
    return 0;
  }

  try {
    await ensureDaemonRunning();
    const started = await daemonStatus(socketPath);
    if (started !== null && daemonFit(started) === "older") {
      process.stderr.write(
        `${olderDaemonStillRunning(started)} and could not be replaced; run \`${APP_NAME} daemon stop\`, then start again\n`,
      );
      return 1;
    }
    process.stderr.write("daemon started\n");
    return 0;
  } catch (err) {
    process.stderr.write(`${errMsg(err)}\n`);
    return 1;
  }
}

async function runStop(): Promise<number> {
  const reachable = await isDaemonReachable(getDaemonSocketPath()).catch((err: unknown) => {
    reportSocketAddressError(err);
    return false;
  });
  const recorded = await recordedDaemonPids();
  const shutdownWaitMs = await loadDaemonShutdownWaitMs();

  if (!reachable) {
    if (recorded.length === 0) process.stderr.write("daemon not running\n");
    for (const pid of recorded) {
      const result = await terminateDaemon(pid, { graceMs: shutdownWaitMs, allowUnidentified: true });
      reportStop(pid, result, `unresponsive daemon ${pid} stopped`);
    }
    return 0;
  }

  const client = makeClient({ rpcTimeoutMs: SHUTDOWN_RPC_TIMEOUT_MS });
  try {
    await client.connect();
    try {
      await client.call("SHUTDOWN");
    } catch (err) {
      if (!(err instanceof DaemonRpcError)) throw err;
      // SHUTDOWN may not flush its response before the daemon dies; tolerate
      // rpc_timeout / connection-closed but surface anything else.
      if (err.code !== "rpc_timeout") {
        process.stderr.write(`shutdown rpc error: ${err.message}\n`);
      }
    }
  } finally {
    client.close();
  }

  const lingering: number[] = [];
  for (const pid of recorded) {
    if (!(await waitForExit(pid, shutdownWaitMs))) lingering.push(pid);
  }
  if (lingering.length === 0) process.stderr.write("daemon stopped\n");
  for (const pid of lingering) {
    reportStop(pid, await terminateDaemon(pid, { graceMs: 0, allowUnidentified: true }), `daemon ${pid} force-stopped`);
  }
  return 0;
}

async function recordedDaemonPids(): Promise<number[]> {
  const pids = await recordedPids(daemonFilesFor(getDaemonSocketPath()));
  return pids.filter((pid) => pid !== process.pid);
}

function reportStop(pid: number, result: TerminateResult, stoppedMessage: string): void {
  switch (result) {
    case "terminated":
      process.stderr.write(`${stoppedMessage}\n`);
      return;
    case "not_ours":
      process.stderr.write(`pid ${pid} recorded for the daemon is a different program; not signalling it\n`);
      return;
    case "failed":
      process.stderr.write(`could not stop pid ${pid} recorded for the daemon\n`);
  }
}

async function runStatus(): Promise<number> {
  const client = makeClient({ rpcTimeoutMs: 1_500, connectTimeoutMs: 1_500 });
  try {
    await client.connect();
    const status = (await client.call("STATUS")) as StatusReply;
    writeStatus({
      running: true,
      pid: reportedDaemonPid(status),
      uptime: nonNegativeIntegerOrNull(status.uptime),
      appVersion: daemonVersionLabel(status),
      refusedUpstreamRequests: refusedRequestCounts(status.telemetry?.upstreamRequests?.refusedTotal),
      children: childEras(status.children),
    });
    return 0;
  } catch (err) {
    if (isSocketAddressError(err)) throw err;
  } finally {
    client.close();
  }

  const pid = await readPidFile(daemonFilesFor(getDaemonSocketPath()).pidPath);
  if (pid !== null && processExists(pid)) {
    writeStatus({
      running: true,
      pid,
      uptime: null,
      appVersion: UNKNOWN_DAEMON_VERSION,
      refusedUpstreamRequests: null,
      children: null,
    });
    return 0;
  }

  writeStatus({ running: false });
  return 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nonNegativeIntegerOrNull(value: unknown): number | null {
  return isNonNegativeInteger(value) ? value : null;
}

function refusedRequestCounts(value: unknown): Record<string, number> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const counts: [string, number][] = [];
  for (const [method, count] of Object.entries(value)) {
    if (!isNonNegativeInteger(count)) return null;
    counts.push([escapeLabel(method), count]);
  }
  return Object.fromEntries(counts);
}

function childEras(value: unknown): { server: string; era: ChildEraLabel }[] | null {
  if (!Array.isArray(value)) return null;
  const children: { server: string; era: ChildEraLabel }[] = [];
  for (const child of value) {
    if (typeof child !== "object" || child === null) return null;
    const { serverName, era } = child as { serverName?: unknown; era?: unknown };
    if (typeof serverName !== "string" || typeof era !== "string" || !CHILD_ERAS.has(era)) return null;
    children.push({ server: escapeLabel(serverName), era: era as ChildEraLabel });
  }
  return children.sort((a, b) => a.server.localeCompare(b.server));
}

function writeStatus(status: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ ...status, logFile: getDaemonLogPath() }, null, 2) + "\n");
}

async function runRestart(): Promise<number> {
  await runStop();
  return runStart();
}

/**
 * Admin CLI: force-respawn one upstream child by hash, or every active upstream
 * when `--all` is passed. Hits the daemon's RESTART RPC.
 *
 * Exit codes:
 *  - 0: success (or daemon not running — idempotent no-op).
 *  - 1: RPC error from a reachable daemon, or the daemon socket path can't be used.
 *  - 2: usage error (neither hash nor --all).
 */
export async function runRestartUpstream(opts: RestartUpstreamOpts): Promise<number> {
  if (!opts.all && (typeof opts.hash !== "string" || opts.hash.length === 0)) {
    process.stderr.write(
      `Usage: ${APP_NAME} daemon restart-upstream <hash> | --all\n`,
    );
    return 2;
  }
  const socketPath = opts._socketPath ?? getDaemonSocketPath();
  const client = new DaemonClient({
    socketPath,
    transport: netTransport,
    rpcTimeoutMs: 5_000,
    connectTimeoutMs: 1_500,
  });
  try {
    try {
      await client.connect();
    } catch (err) {
      if (isSocketAddressError(err)) throw err;
      // Daemon not reachable: nothing to restart. Idempotent no-op, matching
      // `daemon stop`'s behaviour.
      process.stderr.write("daemon not running; nothing to restart\n");
      return 0;
    }
    const hashes: string[] = opts.all
      ? ((await client.call("STATUS")) as { children: { upstreamHash: string }[] }).children.map(
          (c) => c.upstreamHash,
        )
      : [opts.hash as string];
    const unique = Array.from(new Set(hashes));
    let killedTotal = 0;
    for (const upstreamHash of unique) {
      const r = (await client.call("RESTART", { upstreamHash })) as { killed: number };
      killedTotal += r.killed;
    }
    process.stderr.write(
      `restart-upstream: killed ${killedTotal} child group${killedTotal === 1 ? "" : "s"}\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`restart-upstream: ${errMsg(err)}\n`);
    return 1;
  } finally {
    client.close();
  }
}

function makeClient(opts: { rpcTimeoutMs?: number; connectTimeoutMs?: number } = {}): DaemonClient {
  return new DaemonClient({
    socketPath: getDaemonSocketPath(),
    transport: netTransport,
    rpcTimeoutMs: opts.rpcTimeoutMs,
    connectTimeoutMs: opts.connectTimeoutMs,
  });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
