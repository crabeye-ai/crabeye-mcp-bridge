import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../../src/server/tool-registry.js";
import { RateLimiter } from "../../src/server/rate-limiter.js";
import { PolicyEngine } from "../../src/policy/policy-engine.js";
import type { StatusChangeCallback, UpstreamClient } from "../../src/upstream/types.js";
import { createTestPair, FakeUpstreams, makeMockUpstreamClient, makeTool } from "../_helpers/bridge-test-pair.js";

type Pair = Awaited<ReturnType<typeof createTestPair>>;

function disconnectedClient(name: string): { client: UpstreamClient; listeners: Set<StatusChangeCallback> } {
  const listeners = new Set<StatusChangeCallback>();
  const client = makeMockUpstreamClient(name, {
    status: "disconnected",
    onStatusChange: vi.fn((callback: StatusChangeCallback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }),
  });
  return { client, listeners };
}

function gatedRateLimiter(): { limiter: RateLimiter; acquired: Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const acquired = new Promise<void>((resolve) => { entered = resolve; });
  const limiter = { acquire: vi.fn(() => { entered(); return gate; }) } as unknown as RateLimiter;
  return { limiter, acquired, release };
}

function queuedWaiters(limiter: RateLimiter): unknown[] {
  return (limiter as unknown as { queue: unknown[] }).queue;
}

describe("run_tool waits across reloads and cancellation", () => {
  let pair: Pair | undefined;
  const upstreams = new FakeUpstreams();

  afterEach(async () => {
    await pair?.cleanup();
    pair = undefined;
    const leftoverListeners = upstreams.changeListeners.size;
    upstreams.changeListeners.clear();
    expect(leftoverListeners).toBe(0);
  });

  async function connect(rateLimiter?: RateLimiter, policyEngine?: PolicyEngine): Promise<Pair> {
    const registry = new ToolRegistry();
    registry.setToolsForSource("srv", [makeTool("srv__op")]);
    pair = await createTestPair({
      registry,
      getUpstreamClient: upstreams.get,
      getRateLimiter: () => rateLimiter,
      policyEngine,
      onClientsChanged: upstreams.onClientsChanged,
    });
    return pair;
  }

  it("fails with the removal when a reload removes the upstream while the call waits for a rate-limit slot", async () => {
    const original = makeMockUpstreamClient("srv");
    upstreams.set("srv", original);
    const { limiter, acquired, release } = gatedRateLimiter();
    const { client } = await connect(limiter);

    const call = client.callTool({ name: "srv__op", arguments: {} });
    await acquired;
    upstreams.set("srv", undefined);
    release();

    await expect(call).rejects.toThrow(/Upstream server "srv" was removed from the configuration/);
    expect(original.callTool).not.toHaveBeenCalled();
  });

  it("fails with the removal when a reload disposes the rate limiter the call is queued on", async () => {
    const upstream = makeMockUpstreamClient("srv");
    upstreams.set("srv", upstream);
    const limiter = new RateLimiter({ maxCalls: 1, windowSeconds: 60 });
    await limiter.acquire();
    const queue = queuedWaiters(limiter);
    const { client } = await connect(limiter);

    const call = client.callTool({ name: "srv__op", arguments: {} });
    await vi.waitFor(() => expect(queue).toHaveLength(1));
    limiter.dispose();
    upstreams.set("srv", undefined);

    await expect(call).rejects.toThrow(/Upstream server "srv" was removed from the configuration/);
    expect(upstream.callTool).not.toHaveBeenCalled();
  });

  it("calls the replacement when a reload replaces the upstream while the call waits for a rate-limit slot", async () => {
    const original = makeMockUpstreamClient("srv");
    upstreams.set("srv", original);
    const { limiter, acquired, release } = gatedRateLimiter();
    const { client } = await connect(limiter);
    const replacement = makeMockUpstreamClient("srv", {
      callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "from replacement" }] }),
    });

    const call = client.callTool({ name: "srv__op", arguments: {} });
    await acquired;
    upstreams.set("srv", replacement);
    release();

    expect((await call).content).toEqual([{ type: "text", text: "from replacement" }]);
    expect(original.callTool).not.toHaveBeenCalled();
  });

  it("fails promptly with the removal when a reload removes an upstream the call is waiting on", async () => {
    const { client: down, listeners } = disconnectedClient("srv");
    upstreams.set("srv", down);
    const { client } = await connect();

    const call = client.callTool({ name: "srv__op", arguments: {} });
    await vi.waitFor(() => expect(listeners.size).toBe(1));
    upstreams.set("srv", undefined);

    await expect(call).rejects.toThrow(/was removed from the configuration/);
    expect(listeners.size).toBe(0);
  });

  it("refuses a call that a reload denied while it waited, even on the replacement", async () => {
    const { client: down, listeners } = disconnectedClient("srv");
    upstreams.set("srv", down);
    const policy = new PolicyEngine("always", {});
    const { client } = await connect(undefined, policy);
    const replacement = makeMockUpstreamClient("srv");

    const call = client.callTool({ name: "srv__op", arguments: {} });
    await vi.waitFor(() => expect(listeners.size).toBe(1));
    policy.update("always", { srv: { toolPolicy: "never" } });
    upstreams.set("srv", replacement);

    await expect(call).rejects.toThrow(/Tool srv__op is disabled by policy/);
    expect(replacement.callTool).not.toHaveBeenCalled();
  });

  it("refuses a call that a reload denied while it waited for a rate-limit slot", async () => {
    const upstream = makeMockUpstreamClient("srv");
    upstreams.set("srv", upstream);
    const policy = new PolicyEngine("always", {});
    const { limiter, acquired, release } = gatedRateLimiter();
    const { client } = await connect(limiter, policy);

    const call = client.callTool({ name: "srv__op", arguments: {} });
    await acquired;
    policy.update("always", { srv: { toolPolicy: "never" } });
    release();

    await expect(call).rejects.toThrow(/Tool srv__op is disabled by policy/);
    expect(upstream.callTool).not.toHaveBeenCalled();
  });

  it("refuses a call that a reload denied while it waited for a reconnect after its rate-limit slot", async () => {
    const original = makeMockUpstreamClient("srv");
    upstreams.set("srv", original);
    const policy = new PolicyEngine("always", {});
    const { limiter, acquired, release } = gatedRateLimiter();
    const { client } = await connect(limiter, policy);
    const { client: down, listeners } = disconnectedClient("srv");
    const replacement = makeMockUpstreamClient("srv");

    const call = client.callTool({ name: "srv__op", arguments: {} });
    await acquired;
    upstreams.set("srv", down);
    release();
    await vi.waitFor(() => expect(listeners.size).toBe(1));
    policy.update("always", { srv: { toolPolicy: "never" } });
    upstreams.set("srv", replacement);

    await expect(call).rejects.toThrow(/Tool srv__op is disabled by policy/);
    expect(original.callTool).not.toHaveBeenCalled();
    expect(replacement.callTool).not.toHaveBeenCalled();
  });

  it("refuses a call whose tool started requiring confirmation while it waited, instead of running it unconfirmed", async () => {
    const { client: down, listeners } = disconnectedClient("srv");
    upstreams.set("srv", down);
    const policy = new PolicyEngine("always", {});
    const { client } = await connect(undefined, policy);
    const replacement = makeMockUpstreamClient("srv");

    const call = client.callTool({ name: "srv__op", arguments: {} });
    await vi.waitFor(() => expect(listeners.size).toBe(1));
    policy.update("always", { srv: { toolPolicy: "prompt" } });
    upstreams.set("srv", replacement);

    await expect(call).rejects.toThrow(/Tool srv__op now requires confirmation after a configuration change; please retry/);
    expect(replacement.callTool).not.toHaveBeenCalled();
  });

  it("stops waiting for a reconnect when the client cancels", async () => {
    const { client: down, listeners } = disconnectedClient("srv");
    upstreams.set("srv", down);
    const { client } = await connect();
    const controller = new AbortController();

    const call = client.callTool({ name: "srv__op", arguments: {} }, { signal: controller.signal });
    await vi.waitFor(() => expect(listeners.size).toBe(1));
    controller.abort();

    await expect(call).rejects.toThrow();
    await vi.waitFor(() => expect(listeners.size).toBe(0));
    expect(down.callTool).not.toHaveBeenCalled();
  });

  it("gives up a queued rate-limit slot when the client cancels, so the next call is first in line", async () => {
    const upstream = makeMockUpstreamClient("srv");
    upstreams.set("srv", upstream);
    const limiter = new RateLimiter({ maxCalls: 1, windowSeconds: 60 });
    await limiter.acquire();
    const queue = queuedWaiters(limiter);
    const { client } = await connect(limiter);
    const controller = new AbortController();

    const cancelled = client.callTool({ name: "srv__op", arguments: { n: 1 } }, { signal: controller.signal });
    await vi.waitFor(() => expect(queue).toHaveLength(1));
    const next = client.callTool({ name: "srv__op", arguments: { n: 2 } });
    await vi.waitFor(() => expect(queue).toHaveLength(2));
    controller.abort();

    await expect(cancelled).rejects.toThrow();
    await vi.waitFor(() => expect(queue).toHaveLength(1));
    limiter.drainAndDispose();
    await next;
    expect(upstream.callTool).toHaveBeenCalledOnce();
    expect(upstream.callTool).toHaveBeenCalledWith({ name: "op", arguments: { n: 2 } }, { signal: expect.any(AbortSignal) });
  });

  it("aborts the upstream call when the client cancels it in flight", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const upstream = makeMockUpstreamClient("srv", {
      callTool: vi.fn((_params, options?: { signal?: AbortSignal }) => {
        upstreamSignal = options?.signal;
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted upstream")));
        });
      }) as UpstreamClient["callTool"],
    });
    upstreams.set("srv", upstream);
    const { client } = await connect();
    const controller = new AbortController();

    const call = client.callTool({ name: "srv__op", arguments: {} }, { signal: controller.signal });
    await vi.waitFor(() => expect(upstreamSignal).toBeDefined());
    controller.abort();

    await expect(call).rejects.toThrow();
    await vi.waitFor(() => expect(upstreamSignal!.aborted).toBe(true));
  });
});
