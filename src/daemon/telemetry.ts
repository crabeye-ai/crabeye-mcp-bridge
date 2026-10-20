/**
 * Daemon telemetry: counters and gauges exposed via STATUS RPC.
 *
 * Process-lifetime values; reset to zero on daemon respawn. Observers detect
 * resets by watching `StatusResult.uptime` go backwards (no separate
 * started_at gauge — uptime is sufficient signal).
 */

export type KilledReason = "grace" | "restart" | "crash" | "wedged";

const RPC_ERROR_CODE_CAP = 64;
const REFUSED_METHOD_CAP = 64;

export interface TelemetrySnapshot {
  children: {
    total: number;
    spawnedTotal: number;
    killedTotal: Record<KilledReason, number>;
  };
  sessions: {
    total: number;
    openedTotal: number;
    closedTotal: number;
  };
  rpc: {
    inFlight: number;
    errorsTotal: Record<string, number>;
  };
  upstreamRequests: {
    refusedTotal: Record<string, number>;
  };
}

export class Telemetry {
  private childrenTotal = 0;
  private childrenSpawnedTotal = 0;
  private childrenKilledTotal: Record<KilledReason, number> = {
    grace: 0,
    restart: 0,
    crash: 0,
    wedged: 0,
  };

  private sessionsTotal = 0;
  private sessionsOpenedTotal = 0;
  private sessionsClosedTotal = 0;

  private rpcInFlight = 0;
  private rpcErrorsTotal = new Map<string, number>();
  private refusedUpstreamRequests = new Map<string, number>();

  recordSpawn(): void {
    this.childrenTotal += 1;
    this.childrenSpawnedTotal += 1;
  }

  recordKill(reason: KilledReason): void {
    if (this.childrenTotal > 0) this.childrenTotal -= 1;
    this.childrenKilledTotal[reason] += 1;
  }

  recordSessionOpen(): void {
    this.sessionsTotal += 1;
    this.sessionsOpenedTotal += 1;
  }

  recordSessionClose(): void {
    if (this.sessionsTotal > 0) this.sessionsTotal -= 1;
    this.sessionsClosedTotal += 1;
  }

  rpcInFlightInc(): void {
    this.rpcInFlight += 1;
  }

  rpcInFlightDec(): void {
    if (this.rpcInFlight > 0) this.rpcInFlight -= 1;
  }

  recordRpcError(code: string): void {
    // Bound the per-code map. All daemon error codes today flow from a closed
    // ERROR_CODE_* enum (~10 entries), so this cap is well above the live set;
    // it exists to keep the map finite if a future code path ever introduces
    // a dynamic code string.
    if (!this.rpcErrorsTotal.has(code) && this.rpcErrorsTotal.size >= RPC_ERROR_CODE_CAP) {
      return;
    }
    this.rpcErrorsTotal.set(code, (this.rpcErrorsTotal.get(code) ?? 0) + 1);
  }

  recordRefusedUpstreamRequest(methodLabel: string): void {
    if (!this.refusedUpstreamRequests.has(methodLabel) && this.refusedUpstreamRequests.size >= REFUSED_METHOD_CAP) return;
    this.refusedUpstreamRequests.set(methodLabel, (this.refusedUpstreamRequests.get(methodLabel) ?? 0) + 1);
  }

  snapshot(): TelemetrySnapshot {
    const errorsTotal: Record<string, number> = {};
    for (const [code, count] of this.rpcErrorsTotal) errorsTotal[code] = count;
    return {
      children: {
        total: this.childrenTotal,
        spawnedTotal: this.childrenSpawnedTotal,
        killedTotal: { ...this.childrenKilledTotal },
      },
      sessions: {
        total: this.sessionsTotal,
        openedTotal: this.sessionsOpenedTotal,
        closedTotal: this.sessionsClosedTotal,
      },
      rpc: { inFlight: this.rpcInFlight, errorsTotal },
      upstreamRequests: { refusedTotal: Object.fromEntries(this.refusedUpstreamRequests) },
    };
  }
}
