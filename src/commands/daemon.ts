import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  DaemonClient,
  DaemonRpcError,
  ManagerDaemon,
  ensureDaemonRunning,
  getDaemonLockPath,
  getDaemonPidPath,
  getDaemonSocketPath,
  netTransport,
  LockBusyError,
  type StatusResult,
} from "../daemon/index.js";
import { loadBridgeOwnedConfig } from "../config/bridge-config.js";
import { DaemonConfigSchema } from "../config/schema.js";

export type DaemonAction = "start" | "stop" | "status" | "restart";

const STOP_TIMEOUT_MS = 2_000;
const STOP_POLL_MS = 50;

export async function runDaemonCommand(action: DaemonAction): Promise<number> {
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
  const cfg = DaemonConfigSchema.parse(
    (await loadBridgeOwnedConfig().catch(() => null))?._bridge?.daemon ?? {},
  );

  const manager = new ManagerDaemon({
    socketPath: getDaemonSocketPath(),
    pidPath: getDaemonPidPath(),
    lockPath: getDaemonLockPath(),
    idleMs: cfg.idleMs,
    graceMs: cfg.graceMs,
    killGraceMs: cfg.killGraceMs,
    autoForkDrainTimeoutMs: cfg.autoForkDrainTimeoutMs,
    autoForkInitializeTimeoutMs: cfg.autoForkInitializeTimeoutMs,
    transport: netTransport,
  });

  try {
    await manager.start();
  } catch (err) {
    if (err instanceof LockBusyError) {
      // Another daemon is already running. Concurrent launchers fall through
      // to "connect to the survivor". Surface a diagnostic so a stale-lock
      // condition (PID file points at a dead pid that lockfile mis-detected
      // as live) is debuggable instead of silently exiting 0.
      process.stderr.write(
        `daemon: lock held by pid ${err.heldByPid ?? "?"} at ${err.path}; deferring to existing daemon\n`,
      );
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
  if (await isDaemonReachable()) {
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
  const reachable = await isDaemonReachable();
  const pidBefore = await readPidfile();

  if (!reachable) {
    process.stderr.write("daemon not running\n");
    // Wedged daemon: alive pid but no IPC. Send SIGTERM and escalate to
    // SIGKILL after the same window the reachable path uses.
    if (pidBefore !== null && isAlive(pidBefore)) {
      try {
        process.kill(pidBefore, "SIGTERM");
      } catch {
        /* ignore */
      }
      await waitForDeath(pidBefore, STOP_TIMEOUT_MS);
      if (isAlive(pidBefore)) {
        try {
          process.kill(pidBefore, "SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }
    return 0;
  }

  const client = makeClient({ rpcTimeoutMs: STOP_TIMEOUT_MS });
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

  if (pidBefore !== null) {
    await waitForDeath(pidBefore, STOP_TIMEOUT_MS);
    if (isAlive(pidBefore)) {
      try {
        process.kill(pidBefore, "SIGKILL");
      } catch {
        /* ignore */
      }
      process.stderr.write("daemon force-stopped\n");
      return 0;
    }
  }
  process.stderr.write("daemon stopped\n");
  return 0;
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
  } catch {
    /* fall through to pidfile probe */
  } finally {
    client.close();
  }

  const pid = await readPidfile();
  if (pid !== null && isAlive(pid)) {
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

async function isDaemonReachable(): Promise<boolean> {
  const client = makeClient({ rpcTimeoutMs: 1_000, connectTimeoutMs: 1_000 });
  try {
    await client.connect();
    await client.call("STATUS");
    return true;
  } catch {
    return false;
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

async function readPidfile(): Promise<number | null> {
  try {
    const text = await readFile(getDaemonPidPath(), "utf-8");
    const n = Number.parseInt(text.trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForDeath(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await delay(STOP_POLL_MS);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
