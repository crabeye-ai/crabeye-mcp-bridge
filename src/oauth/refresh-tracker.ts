import { refreshRequestOf } from "./refresh-request.js";

export type FetchLike = typeof fetch;

type RefreshOutcome = "succeeded" | "transient" | "rejected";

function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

function outcomeOf(response: Response): RefreshOutcome {
  if (response.ok) return "succeeded";
  return isTransientStatus(response.status) ? "transient" : "rejected";
}

/**
 * Coalesces concurrent refreshes that redeem the same refresh token into one
 * token-endpoint call, and remembers every refresh token the authorization
 * server rejected outright (a non-transient error response). A rejected
 * refresh token never becomes valid again, so the set is never cleared.
 */
export class RefreshTracker {
  private readonly inFlight = new Map<string | undefined, Promise<Response>>();
  private readonly rejected = new Set<string>();
  private failedTransiently = false;

  get lastRefreshFailedTransiently(): boolean {
    return this.failedTransiently;
  }

  clearTransientFailure(): void {
    this.failedTransiently = false;
  }

  hasRejections(): boolean {
    return this.rejected.size > 0;
  }

  wasRejected(refreshToken: string | undefined): boolean {
    return refreshToken !== undefined && this.rejected.has(refreshToken);
  }

  wrap(baseFetch: FetchLike): FetchLike {
    return async (input, init) => {
      const refresh = refreshRequestOf(init);
      if (!refresh) return baseFetch(input, init);
      let pending = this.inFlight.get(refresh.refreshToken);
      if (!pending) {
        pending = this.send(baseFetch, input, init, refresh.refreshToken);
        this.inFlight.set(refresh.refreshToken, pending);
      }
      const response = await pending;
      return response.clone();
    };
  }

  private send(
    baseFetch: FetchLike,
    input: Parameters<FetchLike>[0],
    init: RequestInit | undefined,
    refreshToken: string | undefined,
  ): Promise<Response> {
    const pending = baseFetch(input, init);
    pending.then(
      (response) => this.record(refreshToken, outcomeOf(response)),
      () => this.record(refreshToken, "transient"),
    );
    pending
      .finally(() => {
        if (this.inFlight.get(refreshToken) === pending) this.inFlight.delete(refreshToken);
      })
      .catch(() => {});
    return pending;
  }

  private record(refreshToken: string | undefined, outcome: RefreshOutcome): void {
    this.failedTransiently = outcome === "transient";
    if (outcome === "rejected" && refreshToken !== undefined) this.rejected.add(refreshToken);
  }
}
