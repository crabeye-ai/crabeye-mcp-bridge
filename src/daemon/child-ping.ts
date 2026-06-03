/**
 * Daemon-side MCP `ping` health-check against a spawned stdio child.
 *
 * The bridge already runs an end-to-end MCP ping through its own session
 * (`UpstreamManager._runHealthCheck`), but that path can mask a wedged child
 * for a buggy upstream that responds to some sessions while losing in-flight
 * tokens on others. The daemon-side ping is the authoritative liveness
 * signal: it issues an MCP `ping` with a daemon-allocated negative id and
 * watches for any response (a JSON-RPC error is fine — an error response
 * still proves the child is reading + writing the stdio pipes).
 *
 * On `maxConsecutiveFailures` failures, `onWedged` fires. The caller is
 * expected to kill the child; the daemon's existing `handleChildExit` path
 * then runs and the bridge reconnects through its normal disconnect flow.
 */

import type { Logger } from "../logging/index.js";
import { createNoopLogger } from "../logging/index.js";

export interface ChildPingDeps {
  /** Allocate the next negative id for an outbound daemon-issued request. */
  allocateId(): number;
  /** Register a one-shot response callback keyed by id. */
  registerCallback(id: number, cb: () => void): void;
  /** Drop a callback whose request timed out (so a late response is ignored). */
  unregisterCallback(id: number): void;
  /** Send a JSON-RPC payload to the child's stdin. May throw on backpressure. */
  sendPayload(payload: unknown): void;
  /** Called when consecutive failures hit the kill threshold. */
  onWedged(reason: string): void;
}

export interface ChildPingOptions {
  /** Cadence between pings, ms. `0` disables the supervisor. */
  pingMs: number;
  /** Per-ping deadline, ms. Must be positive. */
  timeoutMs: number;
  /** Trigger `onWedged` after this many consecutive failures. Must be ≥ 1. */
  maxConsecutiveFailures: number;
  deps: ChildPingDeps;
  logger?: Logger;
}

export class ChildPing {
  private readonly pingMs: number;
  private readonly timeoutMs: number;
  private readonly maxConsecutiveFailures: number;
  private readonly deps: ChildPingDeps;
  private readonly logger: Logger;

  private cadenceTimer: NodeJS.Timeout | null = null;
  private pendingId: number | null = null;
  private pendingTimer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  private stopped = false;
  private wedged = false;

  constructor(opts: ChildPingOptions) {
    this.pingMs = opts.pingMs;
    this.timeoutMs = opts.timeoutMs;
    this.maxConsecutiveFailures = opts.maxConsecutiveFailures;
    this.deps = opts.deps;
    this.logger = opts.logger ?? createNoopLogger();
  }

  start(): void {
    if (this.cadenceTimer !== null || this.stopped || this.wedged) return;
    // `pingMs <= 0` is the documented disable knob — leaves the supervisor
    // dormant. Useful for environments where the bridge's end-to-end ping is
    // sufficient and the extra child traffic is unwanted.
    if (this.pingMs <= 0) return;
    this.cadenceTimer = setInterval(() => this.tick(), this.pingMs);
    if (typeof this.cadenceTimer.unref === "function") this.cadenceTimer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.cadenceTimer !== null) {
      clearInterval(this.cadenceTimer);
      this.cadenceTimer = null;
    }
    this.clearPending();
  }

  /** True once the supervisor has declared the child wedged. */
  get isWedged(): boolean {
    return this.wedged;
  }

  /** Test seam. */
  _statsForTest(): {
    consecutiveFailures: number;
    wedged: boolean;
    pendingId: number | null;
    running: boolean;
  } {
    return {
      consecutiveFailures: this.consecutiveFailures,
      wedged: this.wedged,
      pendingId: this.pendingId,
      running: this.cadenceTimer !== null,
    };
  }

  private tick(): void {
    if (this.stopped || this.wedged) return;
    // Cadence reentry while a previous ping is still pending: the prior ping
    // is still in flight past its own deadline (handled by its own timer),
    // but waiting another full cadence to issue a fresh one would mask a
    // wedge. Skip this tick; the pending timer will count the failure when
    // it fires.
    if (this.pendingId !== null) return;

    const id = this.deps.allocateId();
    this.pendingId = id;
    this.deps.registerCallback(id, () => this.onResponse(id));
    this.pendingTimer = setTimeout(() => {
      // Drop the daemon-side callback so a late response is silently
      // ignored instead of resolving the next ping's slot.
      this.deps.unregisterCallback(id);
      this.pendingId = null;
      this.pendingTimer = null;
      this.recordFailure(`no response in ${this.timeoutMs}ms`);
    }, this.timeoutMs);
    if (typeof this.pendingTimer.unref === "function") this.pendingTimer.unref();

    try {
      this.deps.sendPayload({ jsonrpc: "2.0", id, method: "ping" });
    } catch (err) {
      this.clearPending();
      this.recordFailure(
        `send failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private onResponse(id: number): void {
    if (this.stopped) return;
    if (id !== this.pendingId) return; // stale (e.g. response after timeout)
    this.clearPending();
    this.consecutiveFailures = 0;
  }

  private recordFailure(reason: string): void {
    if (this.stopped || this.wedged) return;
    this.consecutiveFailures += 1;
    this.logger.warn("child ping failed", {
      component: "child-ping",
      reason,
      consecutiveFailures: this.consecutiveFailures,
      threshold: this.maxConsecutiveFailures,
    });
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      this.wedged = true;
      // Stop the cadence so the caller's onWedged hook doesn't race against
      // another tick during teardown.
      if (this.cadenceTimer !== null) {
        clearInterval(this.cadenceTimer);
        this.cadenceTimer = null;
      }
      this.deps.onWedged(
        `${this.consecutiveFailures} consecutive ping failures (last: ${reason})`,
      );
    }
  }

  private clearPending(): void {
    if (this.pendingTimer !== null) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (this.pendingId !== null) {
      this.deps.unregisterCallback(this.pendingId);
      this.pendingId = null;
    }
  }
}
