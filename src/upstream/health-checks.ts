import type { Logger } from "../logging/index.js";
import { ConnectionSupersededError, type HealthState, type UpstreamClient } from "./types.js";

export interface HealthChecksOptions {
  /** Seconds between pings. 0 disables the checks. */
  intervalSec: number;
  logger: Logger;
  pingTimeoutMs?: number;
  /** Consecutive failed pings that make a connected client reconnect. */
  unhealthyThreshold?: number;
  /** What to do with a client that failed `unhealthyThreshold` pings in a row; reconnects it by default. */
  onUnhealthy?: (client: UpstreamClient) => Promise<void>;
}

export interface HealthSnapshot {
  health: HealthState;
  lastPingAt?: number;
}

interface HealthTracking {
  consecutiveFailures: number;
  lastPingAt?: number;
  health: HealthState;
}

interface Member {
  server: string;
  pinging: boolean;
  tracking: HealthTracking | undefined;
}

const DEFAULT_PING_TIMEOUT_MS = 5000;
const DEFAULT_UNHEALTHY_THRESHOLD = 3;

/**
 * Pings each connected member on an interval and reconnects one after
 * `unhealthyThreshold` consecutive failures.
 */
export class HealthChecks {
  private readonly _members = new Map<UpstreamClient, Member>();
  private readonly _logger: Logger;
  private readonly _pingTimeoutMs: number;
  private readonly _unhealthyThreshold: number;
  private readonly _onUnhealthy: (client: UpstreamClient) => Promise<void>;
  private _intervalSec: number;
  private _timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: HealthChecksOptions) {
    this._intervalSec = options.intervalSec;
    this._logger = options.logger.child({ component: "health" });
    this._pingTimeoutMs = options.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS;
    this._unhealthyThreshold = options.unhealthyThreshold ?? DEFAULT_UNHEALTHY_THRESHOLD;
    this._onUnhealthy = options.onUnhealthy ?? ((client) => client.reconnect());
  }

  /** `server` names the member in log lines. */
  add(client: UpstreamClient, server: string): void {
    if (!this._members.has(client)) this._members.set(client, { server, pinging: false, tracking: undefined });
  }

  healthOf(client: UpstreamClient): HealthSnapshot {
    const tracking = this._members.get(client)?.tracking;
    return { health: tracking?.health ?? "unknown", lastPingAt: tracking?.lastPingAt };
  }

  start(): void {
    if (this._intervalSec <= 0 || this._timer) return;
    this._logger.debug("starting health checks", { interval: this._intervalSec });
    this._timer = setInterval(() => this._tick(), this._intervalSec * 1000);
  }

  stop(): void {
    if (!this._timer) return;
    clearInterval(this._timer);
    this._timer = undefined;
  }

  restart(intervalSec: number): void {
    this.stop();
    this._intervalSec = intervalSec;
    this.start();
  }

  private _tick(): void {
    for (const [client, member] of this._members) {
      if (client.status !== "connected" || member.pinging) continue;
      member.tracking ??= { consecutiveFailures: 0, health: "unknown" };
      member.pinging = true;
      client.ping(this._pingTimeoutMs).then(
        () => this._onPingSucceeded(member),
        (err: unknown) => this._onPingFailed(client, member, err),
      );
    }
  }

  private _onPingSucceeded(member: Member): void {
    member.pinging = false;
    const tracking = member.tracking;
    if (!tracking) return;
    const wasUnhealthy = tracking.health === "unhealthy";
    tracking.consecutiveFailures = 0;
    tracking.lastPingAt = Date.now();
    tracking.health = "healthy";
    if (wasUnhealthy) this._logger.info("recovered", { server: member.server });
  }

  private _onPingFailed(client: UpstreamClient, member: Member, err: unknown): void {
    member.pinging = false;
    const tracking = member.tracking;
    if (!tracking) return;
    tracking.consecutiveFailures++;
    tracking.health = "unhealthy";
    this._logger.warn("ping failed", {
      server: member.server,
      error: errorMessage(err),
      failures: tracking.consecutiveFailures,
    });
    if (tracking.consecutiveFailures < this._unhealthyThreshold || client.status !== "connected") return;
    this._logger.error(`${tracking.consecutiveFailures} consecutive ping failures`, { server: member.server });
    tracking.consecutiveFailures = 0;
    tracking.health = "unknown";
    this._onUnhealthy(client).catch((reconnectErr: unknown) => {
      if (reconnectErr instanceof ConnectionSupersededError) return;
      this._logger.error("failed to recover from failed pings", { server: member.server, error: errorMessage(reconnectErr) });
    });
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
