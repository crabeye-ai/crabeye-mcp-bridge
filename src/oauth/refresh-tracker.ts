import { refreshRequestOf } from "./refresh-request.js";
import { PendingSaves } from "./pending-saves.js";
import { SharedRefreshes } from "./shared-refreshes.js";

export type FetchLike = typeof fetch;

type RefreshOutcome = "succeeded" | "transient" | "rejected";

const REDEMPTIONS_KEPT = 16;

interface Redemption {
  refreshToken: string;
  settle: () => void;
}

function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

function outcomeOf(response: Response): RefreshOutcome {
  if (response.ok) return "succeeded";
  return isTransientStatus(response.status) ? "transient" : "rejected";
}

function endpointOf(input: Parameters<FetchLike>[0]): string {
  if (input instanceof URL) return input.href;
  if (typeof input === "string") return input;
  return input.url;
}

/**
 * Sends refreshes through `shared`, so that refreshes of the same refresh
 * token at the same token endpoint coalesce with every other tracker using
 * it, and records what came back for this tracker's own provider: which
 * refresh token each new access token was issued for, and every refresh
 * token the authorization server rejected outright (a non-transient error
 * response). A rejected refresh token never becomes valid again, so that set
 * is never cleared. A refresh counts in `pending` until it fails, or until
 * the provider says it is done saving the tokens it issued.
 */
export class RefreshTracker {
  private readonly rejected = new Set<string>();
  private readonly redemptions = new Map<string, Redemption>();
  private failedTransiently = false;

  constructor(
    private readonly shared: SharedRefreshes = new SharedRefreshes(),
    private readonly pending: PendingSaves = new PendingSaves(),
  ) {}

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

  /** The refresh token whose refresh, seen by this tracker, issued `accessToken`. */
  redeemedFor(accessToken: string): string | undefined {
    return this.redemptions.get(accessToken)?.refreshToken;
  }

  /** The provider is done saving the tokens issued with `accessToken`, whether it saved them or not. */
  saveFinished(accessToken: string): void {
    this.redemptions.get(accessToken)?.settle();
  }

  wrap(baseFetch: FetchLike): FetchLike {
    return async (input, init) => {
      const refreshToken = refreshRequestOf(init)?.refreshToken;
      if (refreshToken === undefined) return baseFetch(input, init);
      const settle = this.pending.track();
      let response: Response;
      try {
        response = await this.shared.fetch(endpointOf(input), refreshToken, (signal) => baseFetch(input, { ...init, signal }));
      } catch (err) {
        settle();
        this.record(refreshToken, "transient");
        throw err;
      }
      const outcome = outcomeOf(response);
      this.record(refreshToken, outcome);
      const awaitingSave = outcome === "succeeded" && (await this.rememberRedemption(response, { refreshToken, settle }));
      if (!awaitingSave) settle();
      return response;
    };
  }

  private async rememberRedemption(response: Response, redemption: Redemption): Promise<boolean> {
    const body = (await response.clone().json().catch(() => undefined)) as { access_token?: unknown } | undefined;
    if (typeof body?.access_token !== "string") return false;
    this.redemptions.get(body.access_token)?.settle();
    this.redemptions.delete(body.access_token);
    this.redemptions.set(body.access_token, redemption);
    if (this.redemptions.size > REDEMPTIONS_KEPT) {
      const [oldest, forgotten] = this.redemptions.entries().next().value!;
      forgotten.settle();
      this.redemptions.delete(oldest);
    }
    return true;
  }

  private record(refreshToken: string, outcome: RefreshOutcome): void {
    this.failedTransiently = outcome === "transient";
    if (outcome === "rejected") this.rejected.add(refreshToken);
  }
}
