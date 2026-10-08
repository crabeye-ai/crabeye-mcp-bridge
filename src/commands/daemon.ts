import {
  DaemonClient,
  DaemonRpcError,
  ManagerDaemon,
  ensureDaemonRunning,
  isDaemonReachable,
  daemonFilesFor,
  getDaemonSocketPath,
  netTransport,
  LockBusyError,
  DaemonAlreadyRunningError,
  readPidFile,
  recordedPids,
  terminateDaemon,
  waitForExit,
  isSocketAddressError,
  type StatusResult,
  type TerminateResult,
} from "../daemon/index.js";
import { processExists } from "../process/index.js";
import { loadDaemonConfig, loadDaemonShutdownWaitMs } from "../config/bridge-config.js";
import { APP_NAME } from "../constants.js";

export type DaemonAction = "start" | "stop" | "status" | "restart";

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
export async function runDaemonInternal(): Promise<number> {
  const cfg = await loadDaemonConfig();

  const socketPath = getDaemonSocketPath();
  const manager = new ManagerDaemon({
    socketPath,
    ...daemonFilesFor(socketPath),
    idleMs: cfg.idleMs,
    graceMs: cfg.graceMs,
    killGraceMs: cfg.killGraceMs,
    autoForkDrainTimeoutMs: cfg.autoForkDrainTimeoutMs,
    autoForkInitializeTimeoutMs: cfg.autoForkInitializeTimeoutMs,
    childPingMs: cfg.childPingMs,
    childPingTimeoutMs: cfg.childPingTimeoutMs,
    childPingMaxConsecutiveFailures: cfg.childPingMaxConsecutiveFailures,
    transport: netTransport,
  });

  try {
    await manager.start();
  } catch (err) {
    if (err instanceof LockBusyError || err instanceof DaemonAlreadyRunningError) {
      process.stderr.write(`daemon: ${err.message}; deferring to existing daemon\n`);
      return 0;
    }
    process.stderr.write(`daemon failed to start: ${errMsg(err)}\n`);
    return 1;
  }

  let signaled = false;
  const onSignal = (): void => {
    if (signaled) return;
    signaled = true;
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
    void manager.stop(0);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);

  return manager.waitForExit();
}

async function runStart(): Promise<number> {
  if (await isDaemonReachable(getDaemonSocketPath())) {
    process.stderr.write("daemon already running\n");
    return 0;
  }

  try {
    await ensureDaemonRunning();
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
    const status = (await client.call("STATUS")) as StatusResult;
    process.stdout.write(
      JSON.stringify(
        { running: true, pid: status.pid, uptime: status.uptime },
        null,
        2,
      ) + "\n",
    );
    return 0;
  } catch (err) {
    if (isSocketAddressError(err)) throw err;
  } finally {
    client.close();
  }

  const pid = await readPidFile(daemonFilesFor(getDaemonSocketPath()).pidPath);
  if (pid !== null && processExists(pid)) {
    process.stdout.write(
      JSON.stringify({ running: true, pid, uptime: null }, null, 2) + "\n",
    );
    return 0;
  }

  process.stdout.write(JSON.stringify({ running: false }, null, 2) + "\n");
  return 0;
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
