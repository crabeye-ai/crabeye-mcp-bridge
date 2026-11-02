import type { RateLimitConfig } from "../../config/schema.js";
import type { ResolvedRateLimit } from "../../server/rate-limit-resolution.js";
import { RateLimiter } from "../../server/rate-limiter.js";

type LimitSource = Extract<ResolvedRateLimit, { kind: "config" }>["source"];

interface Budget {
  id: string;
  config: RateLimitConfig;
  limiter: RateLimiter;
  owners: Set<object>;
}

interface Owner {
  key: string;
  budget: Budget | undefined;
  source: LimitSource | undefined;
  onDefaultLimitReached: DefaultLimitReached | undefined;
  /** Stops each of the owner's waiting calls, which then look again at where the owner is. */
  waiting: Set<AbortController>;
}

/** What became of a call waiting for a slot: it got one, or its owner was released meanwhile. */
export type SlotOutcome = "granted" | "released";

/** Hears that the default limit an owner follows first made a call through its connection wait. */
type DefaultLimitReached = (config: RateLimitConfig) => void;

/**
 * The call budgets of the pool's connections: one per connection and limit,
 * shared by every owner whose calls go through that connection under that
 * limit. An owner's waiting calls follow the owner: to its new budget when
 * its limit changes, and out of the queue when it is lifted or the owner is
 * released.
 */
export class RateBudgets {
  private readonly _budgets = new Map<string, Budget>();
  private readonly _owners = new Map<object, Owner>();

  /** Puts `owner`'s calls through connection `key` under `limit`. */
  add(owner: object, key: string, limit: ResolvedRateLimit, onDefaultLimitReached?: DefaultLimitReached): void {
    this._owners.set(owner, { key, budget: undefined, source: undefined, onDefaultLimitReached, waiting: new Set() });
    this.setLimit(owner, limit);
  }

  /**
   * Puts `owner`'s calls under `limit`. A budget made for it starts with the
   * calls made within the window under the one it leaves, so moving doesn't
   * reset the window.
   */
  setLimit(owner: object, limit: ResolvedRateLimit): void {
    const state = this._owners.get(owner);
    if (state === undefined) return;
    const current = state.budget;
    if (limit.kind === "disabled") {
      state.source = undefined;
      this._leave(state, owner);
      return;
    }
    state.source = limit.source;
    const id = budgetId(state.key, limit.config);
    if (current?.id === id) return;
    const existing = this._budgets.get(id);
    if (existing === undefined && current !== undefined && current.owners.size === 1) {
      this._reconfigure(current, id, limit.config);
      return;
    }
    const target = existing ?? this._create(id, limit.config, current?.limiter.recentCalls() ?? []);
    this._leave(state, owner);
    target.owners.add(owner);
    state.budget = target;
  }

  /** Forgets `owner`; its waiting calls stop waiting with "released". */
  release(owner: object): void {
    const state = this._owners.get(owner);
    if (state === undefined) return;
    this._owners.delete(owner);
    this._leave(state, owner);
  }

  /**
   * Waits for a slot under `owner`'s limit, granted at once when it has none;
   * "released" once the owner is released, or when it isn't known. Rejects
   * with a `CallRefusedError` when its queue is full or the wait times out.
   */
  async takeSlot(owner: object, signal: AbortSignal): Promise<SlotOutcome> {
    for (;;) {
      const state = this._owners.get(owner);
      if (state === undefined) return "released";
      if (state.budget === undefined) return "granted";
      const withdraw = new AbortController();
      state.waiting.add(withdraw);
      try {
        await state.budget.limiter.acquire(AbortSignal.any([signal, withdraw.signal]));
        return "granted";
      } catch (err) {
        if (signal.aborted || !withdraw.signal.aborted) throw err;
      } finally {
        state.waiting.delete(withdraw);
      }
    }
  }

  private _create(id: string, config: RateLimitConfig, recentCalls: readonly number[]): Budget {
    const budget: Budget = { id, config, limiter: new RateLimiter(config, { recentCalls }), owners: new Set() };
    this._armHint(budget);
    this._budgets.set(id, budget);
    return budget;
  }

  private _reconfigure(budget: Budget, id: string, config: RateLimitConfig): void {
    this._budgets.delete(budget.id);
    budget.id = id;
    budget.config = config;
    this._armHint(budget);
    budget.limiter.reconfigure(config);
    this._budgets.set(id, budget);
  }

  private _armHint(budget: Budget): void {
    budget.limiter.setOnFirstBlock(() => {
      for (const owner of budget.owners) {
        const state = this._owners.get(owner);
        if (state?.source === "default") state.onDefaultLimitReached?.(budget.config);
      }
    });
  }

  private _leave(state: Owner, owner: object): void {
    for (const withdraw of state.waiting) withdraw.abort();
    const budget = state.budget;
    state.budget = undefined;
    if (budget === undefined) return;
    budget.owners.delete(owner);
    if (budget.owners.size > 0) return;
    this._budgets.delete(budget.id);
    budget.limiter.dispose();
  }
}

function budgetId(key: string, config: RateLimitConfig): string {
  return `${key}\0${config.maxCalls}/${config.windowSeconds}`;
}
