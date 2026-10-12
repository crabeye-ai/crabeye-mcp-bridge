import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitConnectedClient, WAIT_FOR_RESPAWN_MS } from "../../src/server/upstream-wait.js";
import type { ConnectionStatus, StatusChangeCallback, UpstreamClient } from "../../src/upstream/types.js";
import { FakeUpstreams } from "../_helpers/bridge-test-pair.js";

class FakeClient {
  readonly listeners = new Set<StatusChangeCallback>();
  readonly retryNow = vi.fn(async () => {});
  constructor(readonly name: string, public status: ConnectionStatus = "disconnected") {}

  onStatusChange(callback: StatusChangeCallback): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  become(status: ConnectionStatus): void {
    const previous = this.status;
    this.status = status;
    for (const listener of [...this.listeners]) listener({ previous, current: status });
  }

  asClient(): UpstreamClient {
    return this as unknown as UpstreamClient;
  }
}

describe("awaitConnectedClient", () => {
  let clients: FakeUpstreams;

  beforeEach(() => {
    vi.useFakeTimers();
    clients = new FakeUpstreams();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function wait(source: string, signal?: AbortSignal) {
    const settled = { done: false };
    const promise = awaitConnectedClient(source, { getClient: clients.get, onClientsChanged: clients.onClientsChanged, signal });
    void promise.then(() => (settled.done = true), () => (settled.done = true));
    return { promise, settled };
  }

  function expectNothingLeft(...fakes: FakeClient[]): void {
    for (const fake of fakes) expect(fake.listeners.size).toBe(0);
    expect(clients.changeListeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  }

  it("returns a connected client without retrying or waiting", async () => {
    const srv = new FakeClient("srv", "connected");
    clients.set("srv", srv.asClient());

    await expect(awaitConnectedClient("srv", { getClient: clients.get })).resolves.toBe(srv);
    expect(srv.retryNow).not.toHaveBeenCalled();
  });

  it("reports the upstream unavailable exactly when the wait runs out", async () => {
    const srv = new FakeClient("srv");
    clients.set("srv", srv.asClient());
    const { promise, settled } = wait("srv");
    const assertion = expect(promise).rejects.toThrow(/Upstream server "srv" is unavailable; reconnecting in the background/);

    await vi.advanceTimersByTimeAsync(WAIT_FOR_RESPAWN_MS - 1);
    expect(settled.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await assertion;
    expect(WAIT_FOR_RESPAWN_MS).toBe(30_000);
    expect(srv.retryNow).toHaveBeenCalledOnce();
    expectNothingLeft(srv);
  });

  it("returns the client once it reconnects", async () => {
    const srv = new FakeClient("srv");
    clients.set("srv", srv.asClient());
    const { promise } = wait("srv");

    await vi.advanceTimersByTimeAsync(1_000);
    srv.become("connected");

    await expect(promise).resolves.toBe(srv);
    expectNothingLeft(srv);
  });

  it("fails at once with the removal when a reload removes the upstream", async () => {
    const srv = new FakeClient("srv");
    clients.set("srv", srv.asClient());
    const { promise } = wait("srv");

    clients.set("srv", undefined);

    await expect(promise).rejects.toThrow(/Upstream server "srv" was removed from the configuration/);
    expectNothingLeft(srv);
  });

  it("fails for a removed alias even when the client it shared later connects", async () => {
    const shared = new FakeClient("primary");
    clients.set("primary", shared.asClient());
    clients.set("alias", shared.asClient());
    const { promise } = wait("alias");

    clients.set("alias", undefined);
    shared.become("connected");

    await expect(promise).rejects.toThrow(/Upstream server "alias" was removed/);
    expectNothingLeft(shared);
  });

  it("follows a replacement client and returns it once it connects", async () => {
    const old = new FakeClient("srv");
    clients.set("srv", old.asClient());
    const { promise } = wait("srv");
    const replacement = new FakeClient("srv");

    clients.set("srv", replacement.asClient());
    old.become("connected");
    await vi.advanceTimersByTimeAsync(0);
    replacement.become("connected");

    await expect(promise).resolves.toBe(replacement);
    expect(replacement.retryNow).toHaveBeenCalledOnce();
    expectNothingLeft(old, replacement);
  });

  it("keeps the original deadline after following a replacement", async () => {
    const old = new FakeClient("srv");
    clients.set("srv", old.asClient());
    const { promise, settled } = wait("srv");
    const assertion = expect(promise).rejects.toThrow(/is unavailable/);

    await vi.advanceTimersByTimeAsync(20_000);
    const replacement = new FakeClient("srv");
    clients.set("srv", replacement.asClient());
    await vi.advanceTimersByTimeAsync(WAIT_FOR_RESPAWN_MS - 20_000 - 1);
    expect(settled.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await assertion;
    expectNothingLeft(old, replacement);
  });

  it("keeps waiting through changes to other upstreams without retrying again", async () => {
    const srv = new FakeClient("srv");
    clients.set("srv", srv.asClient());
    const { promise, settled } = wait("srv");

    clients.set("other", new FakeClient("other").asClient());
    await vi.advanceTimersByTimeAsync(0);
    expect(settled.done).toBe(false);
    srv.become("connected");

    await expect(promise).resolves.toBe(srv);
    expect(srv.retryNow).toHaveBeenCalledOnce();
    expectNothingLeft(srv);
  });

  it("asks for re-authorization when the upstream pauses for it while waiting", async () => {
    const srv = new FakeClient("srv");
    clients.set("srv", srv.asClient());
    const { promise } = wait("srv");

    srv.become("auth_required");

    await expect(promise).rejects.toThrow(/needs re-authorization/);
    expectNothingLeft(srv);
  });

  it("stops at once when the request is cancelled while waiting", async () => {
    const srv = new FakeClient("srv");
    clients.set("srv", srv.asClient());
    const controller = new AbortController();
    const { promise } = wait("srv", controller.signal);

    controller.abort();

    await expect(promise).rejects.toThrow(/Request cancelled/);
    expectNothingLeft(srv);
  });

  it("does not wait at all for a request that was already cancelled", async () => {
    const srv = new FakeClient("srv");
    clients.set("srv", srv.asClient());

    await expect(awaitConnectedClient("srv", { getClient: clients.get, signal: AbortSignal.abort() })).rejects.toThrow(/Request cancelled/);
    expect(srv.retryNow).not.toHaveBeenCalled();
  });
});
