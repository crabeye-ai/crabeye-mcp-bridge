import { refreshRequestOf } from "./refresh-request.js";

export type FetchLike = typeof fetch;

type RefreshOutcome = "succeeded" | "transient" | "rejected";

const REUSE_SUCCESSFUL_REFRESH_MS = 30_000;

function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

function outcomeOf(response: Response): RefreshOutcome {
  if (response.ok) return "succeeded";
  return isTransientStatus(response.status) ? "transient" : "rejected";
}

/**
 * Coalesces refreshes that redeem the same refresh token into one
 * token-endpoint call: those in flight together, and those started up to
 * 30 seconds after one succeeded (a request sent before that refresh can come
 * back unauthorized after it, and redeeming the old token again would be
 * refused by a server that rotates refresh tokens). Remembers every refresh
 * token the authorization server rejected outright (a non-transient error
 * response); a rejected refresh token never becomes valid again, so that set
 * is never cleared.
 */
export class RefreshTracker {
  private readonly inFlight = new Map<string | undefined, Promise<Response>>();
  private readonly succeeded = new Map<string, { response: Response; at: number }>();
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
      const recent = this.recentSuccess(refresh.refreshToken);
      if (recent !== undefined) return recent.clone();
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
      (response) => {
        const outcome = outcomeOf(response);
        this.record(refreshToken, outcome);
        if (outcome === "succeeded" && refreshToken !== undefined) this.rememberSuccess(refreshToken, response);
      },
      () => this.record(refreshToken, "transient"),
    );
    pending
      .finally(() => {
        if (this.inFlight.get(refreshToken) === pending) this.inFlight.delete(refreshToken);
      })
      .catch(() => {});
    return pending;
  }

  private recentSuccess(refreshToken: string | undefined): Response | undefined {
    if (refreshToken === undefined) return undefined;
    const entry = this.succeeded.get(refreshToken);
    if (entry === undefined) return undefined;
    if (Date.now() - entry.at < REUSE_SUCCESSFUL_REFRESH_MS) return entry.response;
    this.succeeded.delete(refreshToken);
    return undefined;
  }

  private rememberSuccess(refreshToken: string, response: Response): void {
    const now = Date.now();
    for (const [token, entry] of this.succeeded) {
      if (now - entry.at >= REUSE_SUCCESSFUL_REFRESH_MS) this.succeeded.delete(token);
    }
    this.succeeded.set(refreshToken, { response: response.clone(), at: now });
  }

  private record(refreshToken: string | undefined, outcome: RefreshOutcome): void {
    this.failedTransiently = outcome === "transient";
    if (outcome === "rejected" && refreshToken !== undefined) this.rejected.add(refreshToken);
  }
}
