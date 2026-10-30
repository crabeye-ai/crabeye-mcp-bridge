import { REFRESH_TIMEOUT_MS } from "./shared-refreshes.js";

/**
 * The refreshes whose tokens haven't been saved yet, so a connection that
 * closes can wait for them before its network goes: the authorization server
 * may already have redeemed the refresh token. A refresh stops counting after
 * 30 seconds, as long as the refresh request itself may take.
 */
export class PendingSaves {
  private readonly _pending = new Set<Promise<void>>();

  /** Counts a refresh until the returned function is called. */
  track(): () => void {
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => (settle = resolve));
    const timer = setTimeout(settle, REFRESH_TIMEOUT_MS);
    timer.unref();
    this._pending.add(settled);
    void settled.then(() => {
      clearTimeout(timer);
      this._pending.delete(settled);
    });
    return settle;
  }

  /** Resolves once every refresh counted now has settled, or `signal` aborts. */
  async settled(signal?: AbortSignal): Promise<void> {
    if (this._pending.size === 0 || signal?.aborted) return;
    const aborted = new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
    await Promise.race([Promise.all([...this._pending]), aborted]);
  }
}
