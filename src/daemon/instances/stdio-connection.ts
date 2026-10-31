import type { StdioServerConfig } from "../../config/schema.js";
import type { CredentialStore } from "../../credentials/credential-store.js";
import type { Logger } from "../../logging/index.js";
import { HealthChecks } from "../../upstream/health-checks.js";
import type { UpstreamReconnectInputs } from "../../upstream/upstream-hash.js";
import type { UpstreamClient } from "../../upstream/types.js";
import type { ProcessExit } from "../child-handle.js";
import type { ChildEraLabel } from "../protocol.js";
import { StderrForwardLimit } from "../stderr-capture.js";
import type { KilledReason } from "../telemetry.js";
import { stopOutcome, type ChildEvents, type ChildStopReason, type RunningProcess, type SpawnChild } from "./child-transport.js";
import type { ConnectionDeps, StdioPoolConnection } from "./pooled-upstream.js";
import { StdioUpstreamClient } from "./stdio-upstream-client.js";

const NO_STDERR_OUTPUT = "(no stderr output)";

export interface StdioConnectionSpec {
  config: StdioServerConfig;
  childEnv: Record<string, string>;
  credentialStore: CredentialStore;
  reconnect: UpstreamReconnectInputs;
}

/** Records the STDIO server processes the daemon starts, so a later daemon can stop them if this one dies. */
export interface ChildRecorder {
  register(entry: { pid: number; command: string; args: string[]; server: string; startedAt: number }): Promise<void>;
  unregister(pid: number): Promise<void>;
}

/** What the daemon counts about its children. */
export interface ChildCounters {
  recordSpawn(): void;
  /** A child is gone; `reason` is why the daemon stopped it, or null when it doesn't count as a kill. */
  recordStop(reason: KilledReason | null): void;
}

/** The client a STDIO connection drives: `StdioUpstreamClient`, or a stand-in in tests. */
export type StdioPoolClient = UpstreamClient & Pick<StdioUpstreamClient, "restart" | "stop" | "child" | "protocolEra">;

export type CreateStdioClient = (options: ConstructorParameters<typeof StdioUpstreamClient>[0]) => StdioPoolClient;

export interface ChildPingOptions {
  /** Between pings; 0 disables them. */
  intervalMs: number;
  timeoutMs: number;
  /** Failed pings in a row after which the server is started again. */
  maxConsecutiveFailures: number;
}

export interface StdioConnectionOptions {
  killGraceMs?: number;
  stderrDrainMs?: number;
  childPing: ChildPingOptions;
  recorder: ChildRecorder;
  counters?: ChildCounters;
  spawnChild?: SpawnChild;
  createClient?: CreateStdioClient;
}

/** The keys of the servers found not to answer the protocol version question, for as long as the daemon runs. */
export type LegacyServers = Set<string>;

const KILLED_REASONS: Record<ChildStopReason, KilledReason | null> = {
  "failed to connect": null,
  idle: "grace",
  "not answering pings": "wedged",
  restart: "restart",
  shutdown: null,
};

const createStdioUpstreamClient: CreateStdioClient = (options) => new StdioUpstreamClient(options);

/** A STDIO server the daemon starts, pings and starts again, reporting its stops to the bridges using it. */
export function createStdioConnection(
  spec: StdioConnectionSpec,
  deps: ConnectionDeps & { daemonLogger: Logger; legacyServers: LegacyServers },
  options: StdioConnectionOptions,
): StdioPoolConnection {
  const stderrLog = deps.daemonLogger.child({ component: "stderr", server: deps.name });
  const stderr = new StderrForwardLimit((line) => {
    stderrLog.debug(line);
    deps.report("debug", line, {});
  });
  const warnings = new StopWarnings(deps);
  const client = (options.createClient ?? createStdioUpstreamClient)({
    name: deps.name,
    logger: deps.logger,
    config: spec.config,
    childEnv: spec.childEnv,
    credentialStore: spec.credentialStore,
    killGraceMs: options.killGraceMs,
    stderrDrainMs: options.stderrDrainMs,
    events: childEvents(spec.config, deps, options, warnings),
    onStderr: (line) => stderr.offer(line),
    spawnChild: options.spawnChild,
    knownLegacy: deps.legacyServers.has(deps.key),
    onLegacy: () => deps.legacyServers.add(deps.key),
    ...spec.reconnect,
  });
  const unsubscribe = client.onStatusChange((event) => {
    if (event.current === "connected") warnings.connected();
  });
  const restartUnanswered = () => client.restart("not answering pings");
  const pings = new HealthChecks({
    intervalSec: options.childPing.intervalMs / 1000,
    pingTimeoutMs: options.childPing.timeoutMs,
    unhealthyThreshold: options.childPing.maxConsecutiveFailures,
    logger: deps.daemonLogger.child({ component: "child-ping" }),
    onUnhealthy: restartUnanswered,
  });
  pings.add(client, deps.name);
  pings.start();
  return {
    type: "stdio",
    client,
    async close(reason) {
      pings.stop();
      unsubscribe();
      await client.stop(reason).catch(() => {});
      stderr.stop();
    },
    restart: (reason) => client.restart(reason),
    onUnhealthy: restartUnanswered,
    child() {
      const child = client.child;
      if (child?.pid == null) return undefined;
      return { pid: child.pid, era: eraLabel(client.protocolEra()), startedAt: child.startedAt };
    },
  };
}

function childEvents(
  config: StdioServerConfig,
  deps: ConnectionDeps & { daemonLogger: Logger },
  options: StdioConnectionOptions,
  warnings: StopWarnings,
): ChildEvents {
  const log = deps.daemonLogger.child({ component: "daemon", server: deps.name });
  const forget = async (child: RunningProcess): Promise<void> => {
    if (child.pid !== null) await options.recorder.unregister(child.pid).catch(() => {});
  };
  return {
    started(child) {
      options.counters?.recordSpawn();
      if (child.pid === null) return;
      log.info("child started", { pid: child.pid });
      void options.recorder
        .register({ pid: child.pid, command: config.command, args: config.args ?? [], server: deps.name, startedAt: child.startedAt })
        .catch((err: unknown) => log.warn(`failed to record spawned subprocess: ${err instanceof Error ? err.message : String(err)}`, { pid: child.pid }));
    },
    exited(child, exit) {
      options.counters?.recordStop("crash");
      log.info("child exited", { pid: child.pid, ...exit });
      warnings.report(describeExit(exit), child);
      return forget(child);
    },
    stopped(child, reason) {
      options.counters?.recordStop(KILLED_REASONS[reason]);
      log.info("child stopped", { pid: child.pid, reason, ...stopOutcome(child) });
      if (reason === "not answering pings") warnings.report("STDIO server stopped answering and was stopped", child);
      return forget(child);
    },
    error(error) {
      log.warn(`child error: ${error.message}`);
    },
  };
}

/** Warns each bridge once about a stop, with the server's last stderr lines; the same stop again before it connects goes to debug. */
class StopWarnings {
  private _lastSinceConnect: string | null = null;

  constructor(private readonly _deps: ConnectionDeps) {}

  connected(): void {
    this._lastSinceConnect = null;
  }

  report(message: string, child: RunningProcess): void {
    const tail = child.stderrTail();
    const repeated = message === this._lastSinceConnect;
    this._lastSinceConnect = message;
    this._deps.report(repeated ? "debug" : "warn", message, {}, tail.length > 0 ? tail : [NO_STDERR_OUTPUT]);
  }
}

function describeExit(exit: ProcessExit): string {
  switch (exit.cause) {
    case "failed_to_start":
      return "STDIO server could not be started";
    case "output_flood":
      return "STDIO server sent a message too large to read and was stopped";
    case "exited":
      if (exit.code !== null) return `STDIO server exited with code ${exit.code}`;
      if (exit.signal !== null) return `STDIO server was killed by signal ${exit.signal}`;
      return "STDIO server exited";
  }
}

function eraLabel(era: string | undefined): ChildEraLabel {
  return era === "modern" || era === "legacy" ? era : "unknown";
}
