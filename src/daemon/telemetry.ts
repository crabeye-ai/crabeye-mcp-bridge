/**
 * Daemon telemetry: counters and gauges exposed via STATUS RPC.
 *
 * Process-lifetime values; reset to zero on daemon respawn. Observers detect
 * resets by watching `StatusResult.uptime` go backwards (no separate
 * started_at gauge — uptime is sufficient signal).
 */

export type KilledReason = "grace" | "restart" | "crash" | "wedged";

const RPC_ERROR_CODE_CAP = 64;

export interface TelemetrySnapshot {
  children: {
    total: number;
    spawnedTotal: number;
    killedTotal: Record<KilledReason, number>;
  };
  rpc: {
    inFlight: number;
    errorsTotal: Record<string, number>;
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

  private rpcInFlight = 0;
  private rpcErrorsTotal = new Map<string, number>();

  recordSpawn(): void {
    this.childrenTotal += 1;
    this.childrenSpawnedTotal += 1;
  }

  /** A child is gone; `reason` is why the daemon stopped it, or null when it doesn't count as a kill. */
  recordStop(reason: KilledReason | null): void {
    if (this.childrenTotal > 0) this.childrenTotal -= 1;
    if (reason !== null) this.childrenKilledTotal[reason] += 1;
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

  snapshot(): TelemetrySnapshot {
    const errorsTotal: Record<string, number> = {};
    for (const [code, count] of this.rpcErrorsTotal) errorsTotal[code] = count;
    return {
      children: {
        total: this.childrenTotal,
        spawnedTotal: this.childrenSpawnedTotal,
        killedTotal: { ...this.childrenKilledTotal },
      },
      rpc: { inFlight: this.rpcInFlight, errorsTotal },
    };
  }
}
