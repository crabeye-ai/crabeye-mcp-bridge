import { afterEach, describe, expect, it, vi } from "vitest";
import { PendingSaves } from "../../src/oauth/pending-saves.js";
import { RefreshTracker } from "../../src/oauth/refresh-tracker.js";
import { BridgeOAuthClientProvider } from "../../src/oauth/sdk-provider.js";
import { SharedRefreshes } from "../../src/oauth/shared-refreshes.js";
import type { CredentialStore } from "../../src/credentials/credential-store.js";
import { settledWithin } from "../_helpers/processes.js";

const TOKEN_ENDPOINT = "https://as.example/token";

function refreshInit(refreshToken = "rt-1"): RequestInit {
  return { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }) };
}

interface HeldFetch {
  fetch: typeof fetch;
  calls: () => number;
  release: (response: Response) => void;
}

function heldFetch(): HeldFetch {
  let calls = 0;
  const pending: Array<(response: Response) => void> = [];
  return {
    fetch: async () => {
      calls++;
      return new Promise<Response>((resolve) => pending.push(resolve));
    },
    calls: () => calls,
    release: (response) => {
      for (const resolve of pending.splice(0)) resolve(response.clone());
    },
  };
}

function countingFetch(respond: (call: number) => Response | Promise<Response>): { fetch: typeof fetch; calls: () => number } {
  let calls = 0;
  return { fetch: async () => respond(++calls), calls: () => calls };
}

const tokens = (accessToken: string) => Response.json({ access_token: accessToken, token_type: "Bearer" });

describe("SharedRefreshes", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends one refresh for trackers that redeem the same refresh token at the same endpoint together, through the first one's fetch", async () => {
    const shared = new SharedRefreshes();
    const [first, second] = [heldFetch(), heldFetch()];
    const a = new RefreshTracker(shared).wrap(first.fetch)(TOKEN_ENDPOINT, refreshInit());
    const b = new RefreshTracker(shared).wrap(second.fetch)(new URL(TOKEN_ENDPOINT), refreshInit());
    await new Promise((resolve) => setTimeout(resolve, 0));

    first.release(tokens("at-2"));

    const bodies = await Promise.all([(await a).json(), (await b).json()]);
    expect(bodies).toEqual([
      { access_token: "at-2", token_type: "Bearer" },
      { access_token: "at-2", token_type: "Bearer" },
    ]);
    expect([first.calls(), second.calls()]).toEqual([1, 0]);
  });

  it.each([
    ["another token endpoint", "https://other-as.example/token", "rt-1"],
    ["another refresh token", TOKEN_ENDPOINT, "rt-2"],
  ])("sends separate refreshes for %s", async (_label, endpoint, refreshToken) => {
    const shared = new SharedRefreshes();
    const base = countingFetch(() => tokens("at"));

    await Promise.all([
      new RefreshTracker(shared).wrap(base.fetch)(TOKEN_ENDPOINT, refreshInit()),
      new RefreshTracker(shared).wrap(base.fetch)(endpoint, refreshInit(refreshToken)),
    ]);

    expect(base.calls()).toBe(2);
  });

  it("answers another tracker's late refresh of the same token within 30 seconds of a success, and sends it again after", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const shared = new SharedRefreshes();
    const base = countingFetch((call) => tokens(`at-${call}`));
    await new RefreshTracker(shared).wrap(base.fetch)(TOKEN_ENDPOINT, refreshInit());
    vi.advanceTimersByTime(29_000);

    const late = await new RefreshTracker(shared).wrap(base.fetch)(TOKEN_ENDPOINT, refreshInit());
    expect(await late.json()).toEqual({ access_token: "at-1", token_type: "Bearer" });
    expect(base.calls()).toBe(1);

    vi.advanceTimersByTime(1_000);
    await new RefreshTracker(shared).wrap(base.fetch)(TOKEN_ENDPOINT, refreshInit());
    expect(base.calls()).toBe(2);
  });

  it("tells each tracker that shared a rejected refresh that its refresh token was rejected, and doesn't reuse the rejection", async () => {
    const shared = new SharedRefreshes();
    const held = heldFetch();
    const trackers = [new RefreshTracker(shared), new RefreshTracker(shared)];
    const pending = trackers.map((tracker) => tracker.wrap(held.fetch)(TOKEN_ENDPOINT, refreshInit()));
    await new Promise((resolve) => setTimeout(resolve, 0));

    held.release(Response.json({ error: "invalid_grant" }, { status: 400 }));
    await Promise.all(pending);

    expect(trackers.map((tracker) => tracker.wasRejected("rt-1"))).toEqual([true, true]);
    expect(trackers.map((tracker) => tracker.lastRefreshFailedTransiently)).toEqual([false, false]);
    const again = trackers[0]!.wrap(held.fetch)(TOKEN_ENDPOINT, refreshInit());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(held.calls()).toBe(2);
    held.release(Response.json({ error: "invalid_grant" }, { status: 400 }));
    await again;
  });

  it.each([
    ["a server error", () => new Response(null, { status: 503 })],
    ["a network failure", () => Promise.reject(new Error("socket hang up"))],
  ])("tells each tracker that shared a refresh that failed with %s, and sends the next refresh again", async (_label, respond) => {
    const shared = new SharedRefreshes();
    const base = countingFetch(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return respond();
    });
    const trackers = [new RefreshTracker(shared), new RefreshTracker(shared)];

    await Promise.allSettled(trackers.map((tracker) => tracker.wrap(base.fetch)(TOKEN_ENDPOINT, refreshInit())));

    expect(base.calls()).toBe(1);
    expect(trackers.map((tracker) => tracker.lastRefreshFailedTransiently)).toEqual([true, true]);
    expect(trackers.map((tracker) => tracker.hasRejections())).toEqual([false, false]);
    await new RefreshTracker(shared).wrap(base.fetch)(TOKEN_ENDPOINT, refreshInit()).catch(() => {});
    expect(base.calls()).toBe(2);
  });

  it("sends requests that aren't refreshes, and refreshes without a refresh token, through each tracker's own fetch", async () => {
    const shared = new SharedRefreshes();
    const [first, second] = [countingFetch(() => new Response("ok")), countingFetch(() => new Response("ok"))];
    const noToken = { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token" }) };

    await Promise.all([
      new RefreshTracker(shared).wrap(first.fetch)("https://mcp.example/mcp", { method: "POST", body: "{}" }),
      new RefreshTracker(shared).wrap(second.fetch)("https://mcp.example/mcp", { method: "POST", body: "{}" }),
      new RefreshTracker(shared).wrap(first.fetch)(TOKEN_ENDPOINT, noToken),
      new RefreshTracker(shared).wrap(second.fetch)(TOKEN_ENDPOINT, noToken),
    ]);

    expect([first.calls(), second.calls()]).toEqual([2, 2]);
  });

  it("remembers which refresh token issued each access token, for every tracker that shared the refresh", async () => {
    const shared = new SharedRefreshes();
    const trackers = [new RefreshTracker(shared), new RefreshTracker(shared)];
    const base = countingFetch(() => tokens("at-2"));

    await Promise.all(trackers.map((tracker) => tracker.wrap(base.fetch)(TOKEN_ENDPOINT, refreshInit("rt-1"))));
    await trackers[0]!.wrap(countingFetch(() => Response.json({ error: "invalid_grant" }, { status: 400 })).fetch)(TOKEN_ENDPOINT, refreshInit("rt-x"));

    expect(trackers.map((tracker) => tracker.redeemedFor("at-2"))).toEqual(["rt-1", "rt-1"]);
    expect(trackers[0]!.redeemedFor("at-unknown")).toBeUndefined();
  });

  it("fails a refresh that gets no answer in time as transient, for every tracker waiting on it, so the next one is sent again", async () => {
    const shared = new SharedRefreshes(50);
    let sent = 0;
    const stalls: typeof fetch = (_input, init) => {
      sent++;
      return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    };
    const trackers = [new RefreshTracker(shared), new RefreshTracker(shared)];

    const results = await Promise.allSettled(trackers.map((tracker) => tracker.wrap(stalls)(TOKEN_ENDPOINT, refreshInit())));

    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(trackers.map((tracker) => tracker.lastRefreshFailedTransiently)).toEqual([true, true]);
    expect(sent).toBe(1);
    const answered = countingFetch(() => tokens("at-2"));
    await trackers[1]!.wrap(answered.fetch)(TOKEN_ENDPOINT, refreshInit());
    expect(answered.calls()).toBe(1);
  });

  it("gives a refresh 30 seconds to answer by default", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    let signal: AbortSignal | null | undefined;

    await new RefreshTracker(new SharedRefreshes()).wrap(async (_input, init) => {
      signal = init?.signal;
      return tokens("at-2");
    })(TOKEN_ENDPOINT, refreshInit());

    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(signal).toBe(timeout.mock.results[0]!.value);
    timeout.mockRestore();
  });
});

describe("PendingSaves, counting the refreshes of a RefreshTracker until saved", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for every refresh counted, not just the first to settle", async () => {
    const pending = new PendingSaves();
    const [first, second] = [pending.track(), pending.track()];
    first();

    expect(await settledWithin(pending.settled(), 100)).toBe(false);
    second();
    expect(await settledWithin(pending.settled(), 1_000)).toBe(true);
  });

  it("doesn't wait when told to stop before it begins", async () => {
    const pending = new PendingSaves();
    pending.track();

    await pending.settled(AbortSignal.abort());
  });

  it("counts a successful refresh as pending until its tracker is told the save finished", async () => {
    const pending = new PendingSaves();
    const tracker = new RefreshTracker(new SharedRefreshes(), pending);
    await tracker.wrap(countingFetch(() => tokens("at-2")).fetch)(TOKEN_ENDPOINT, refreshInit());
    const settling = pending.settled();

    expect(await settledWithin(settling, 50)).toBe(false);
    tracker.saveFinished("at-2");

    await settling;
  });

  it.each([
    ["refused", () => Response.json({ error: "invalid_grant" }, { status: 400 })],
    ["failed", () => Promise.reject(new Error("socket hang up"))],
    ["answered without an access token", () => Response.json({ token_type: "Bearer" })],
  ])("doesn't count a refresh that was %s as pending", async (_label, respond) => {
    const pending = new PendingSaves();
    await new RefreshTracker(new SharedRefreshes(), pending).wrap(countingFetch(respond).fetch)(TOKEN_ENDPOINT, refreshInit()).catch(() => {});
    expect(await settledWithin(pending.settled(), 1_000)).toBe(true);
  });

  it("stops counting a refresh after 30 seconds when its tokens are never saved", async () => {
    vi.useFakeTimers();
    const pending = new PendingSaves();
    await new RefreshTracker(new SharedRefreshes(), pending).wrap(async () => tokens("at-2"))(TOKEN_ENDPOINT, refreshInit());
    let settled = false;
    void pending.settled().then(() => (settled = true));

    await vi.advanceTimersByTimeAsync(29_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(settled).toBe(true);
  });

  it("forgets the oldest of more than 16 refreshes it remembers, which then stops counting", async () => {
    const pending = new PendingSaves();
    const tracker = new RefreshTracker(new SharedRefreshes(), pending);
    for (let i = 1; i <= 17; i++) await tracker.wrap(async () => tokens(`at-${i}`))(TOKEN_ENDPOINT, refreshInit(`rt-${i}`));

    expect(tracker.redeemedFor("at-1")).toBeUndefined();
    expect(tracker.redeemedFor("at-17")).toBe("rt-17");
    for (let i = 2; i <= 17; i++) tracker.saveFinished(`at-${i}`);
    expect(await settledWithin(pending.settled(), 1_000)).toBe(true);
  });

  it("counts a refresh once when its tracker is handed the same tokens twice", async () => {
    const pending = new PendingSaves();
    const tracker = new RefreshTracker(new SharedRefreshes(), pending);
    let release!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => (release = resolve));
    const both = [tracker.wrap(() => held)(TOKEN_ENDPOINT, refreshInit()), tracker.wrap(() => held)(TOKEN_ENDPOINT, refreshInit())];
    await new Promise((resolve) => setTimeout(resolve, 0));
    release(tokens("at-2"));
    await Promise.all(both);

    tracker.saveFinished("at-2");
    expect(await settledWithin(pending.settled(), 1_000)).toBe(true);
  });

  it("stops waiting for pending refreshes when told to", async () => {
    const pending = new PendingSaves();
    await new RefreshTracker(new SharedRefreshes(), pending).wrap(countingFetch(() => tokens("at-2")).fetch)(TOKEN_ENDPOINT, refreshInit());
    const startedAt = Date.now();

    await pending.settled(AbortSignal.timeout(100));

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(90);
  });
});

describe("BridgeOAuthClientProvider", () => {
  it("coalesces the refreshes of two providers given the same SharedRefreshes, and not of a provider without it", async () => {
    const shared = new SharedRefreshes();
    const provider = (refreshes?: SharedRefreshes) =>
      new BridgeOAuthClientProvider({ serverName: "srv", store: {} as CredentialStore, redirectUrl: "http://127.0.0.1/callback", clientId: "ci", refreshes });
    const held = heldFetch();
    const pending = [provider(shared), provider(shared), provider()].map((each) => each.wrapFetch(held.fetch)(TOKEN_ENDPOINT, refreshInit()));
    await new Promise((resolve) => setTimeout(resolve, 0));

    held.release(tokens("at-2"));
    await Promise.all(pending);

    expect(held.calls()).toBe(2);
  });
});
