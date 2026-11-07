import { describe, expect, it, vi } from "vitest";
import { METHOD_NOT_FOUND, ProtocolError, type Client, type McpSubscription } from "@modelcontextprotocol/client";
import { keepListening } from "../../src/upstream/change-subscription.js";
import { spyLogger } from "../_helpers/spy-logger.js";

type Closed = "local" | "graceful" | "remote";

function subscription(closed: Promise<Closed>): McpSubscription {
  return { honoredFilter: { toolsListChanged: true }, close: async () => {}, closed };
}

interface FakeClient {
  client: Client;
  listen: ReturnType<typeof vi.fn>;
  listTools: ReturnType<typeof vi.fn>;
}

function fakeClient({ opened, era = "modern", listChanged = true, listen }: { opened?: McpSubscription; era?: string; listChanged?: boolean; listen: () => Promise<McpSubscription> }): FakeClient {
  const listenFn = vi.fn(listen);
  const listTools = vi.fn(async () => ({ tools: [{ name: "fresh", inputSchema: { type: "object" } }] }));
  const client = {
    autoOpenedSubscription: opened,
    listen: listenFn,
    listTools,
    getProtocolEra: () => era,
    getServerCapabilities: () => ({ tools: { listChanged } }),
  };
  return { client: client as unknown as Client, listen: listenFn, listTools };
}

/** Records each wait and stops the loop after `limit` waits. */
function recorder(limit: number): { sleeps: number[]; isCurrent: () => boolean; sleep: (ms: number) => Promise<void> } {
  const sleeps: number[] = [];
  return {
    sleeps,
    isCurrent: () => sleeps.length <= limit,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
}

describe("keepListening", () => {
  it("waits longer after each failed try, up to 30 seconds", async () => {
    const { client } = fakeClient({ opened: subscription(Promise.resolve("remote")), listen: () => Promise.reject(new Error("refused")) });
    const { sleeps, isCurrent, sleep } = recorder(7);

    keepListening(client, { logger: spyLogger(), isCurrent, onTools: () => {}, sleep });

    await vi.waitFor(() => expect(sleeps).toHaveLength(8));
    expect(sleeps).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  });

  it("keeps waiting longer for a server whose subscriptions end as soon as they open", async () => {
    const { client, listen } = fakeClient({ opened: subscription(Promise.resolve("remote")), listen: async () => subscription(Promise.resolve("remote")) });
    const { sleeps, isCurrent, sleep } = recorder(4);

    keepListening(client, { logger: spyLogger(), isCurrent, onTools: () => {}, sleep });

    await vi.waitFor(() => expect(sleeps).toHaveLength(5));
    expect(sleeps).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
    expect(listen).toHaveBeenCalledTimes(4);
  });

  it.each(["remote", "graceful"] as const)("listens again with the same filter after a subscription ends %s, and hands over a freshly fetched tool list", async (reason) => {
    const { client, listen, listTools } = fakeClient({ opened: subscription(Promise.resolve(reason)), listen: async () => subscription(new Promise(() => {})) });
    const onTools = vi.fn();

    keepListening(client, { logger: spyLogger(), isCurrent: () => true, onTools, sleep: async () => {} });

    await vi.waitFor(() => expect(onTools).toHaveBeenCalledWith([expect.objectContaining({ name: "fresh" })]));
    expect(listen).toHaveBeenCalledExactlyOnceWith({ toolsListChanged: true });
    expect(listTools).toHaveBeenCalledExactlyOnceWith(undefined, { cacheMode: "refresh" });
  });

  it.each([
    ["starts from the shortest wait again after a subscription that stayed open 30 seconds", 30_000, [1_000, 2_000, 1_000]],
    ["keeps waiting longer after a subscription that ended sooner", 29_000, [1_000, 2_000, 4_000]],
  ])("%s", async (_case, openFor, expected) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      let endSecond: (reason: Closed) => void = () => {};
      const second = subscription(new Promise<Closed>((resolve) => (endSecond = resolve)));
      const listen = vi.fn<() => Promise<McpSubscription>>().mockRejectedValueOnce(new Error("busy")).mockResolvedValueOnce(second).mockRejectedValue(new Error("busy"));
      const { client } = fakeClient({ opened: subscription(Promise.resolve("remote")), listen });
      const { sleeps, isCurrent, sleep } = recorder(2);
      keepListening(client, { logger: spyLogger(), isCurrent, onTools: () => {}, sleep });
      await vi.waitFor(() => expect(listen).toHaveBeenCalledTimes(2));

      vi.setSystemTime(Date.now() + openFor);
      endSecond("remote");

      await vi.waitFor(() => expect(sleeps).toHaveLength(3));
      expect(sleeps).toEqual(expected);
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't hand over a tool list fetched for a connection replaced meanwhile", async () => {
    let current = true;
    const { client } = fakeClient({
      opened: subscription(Promise.resolve("remote")),
      listen: async () => {
        current = false;
        return subscription(new Promise(() => {}));
      },
    });
    const onTools = vi.fn();

    keepListening(client, { logger: spyLogger(), isCurrent: () => current, onTools, sleep: async () => {} });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(onTools).not.toHaveBeenCalled();
  });

  it("stops for a server that has no subscriptions/listen method", async () => {
    const { client, listen } = fakeClient({ opened: subscription(Promise.resolve("remote")), listen: () => Promise.reject(new ProtocolError(METHOD_NOT_FOUND, "Method not found")) });
    const { sleeps, isCurrent, sleep } = recorder(3);

    keepListening(client, { logger: spyLogger(), isCurrent, onTools: () => {}, sleep });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(listen).toHaveBeenCalledTimes(1);
    expect(sleeps).toHaveLength(1);
  });

  it("doesn't listen again after crabeye closed the subscription", async () => {
    const { client, listen } = fakeClient({ opened: subscription(Promise.resolve("local")), listen: async () => subscription(new Promise(() => {})) });
    const sleep = vi.fn(async () => {});

    keepListening(client, { logger: spyLogger(), isCurrent: () => true, onTools: () => {}, sleep });
    await new Promise((resolve) => setImmediate(resolve));

    expect(sleep).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });

  it("doesn't listen again for a connection that was replaced", async () => {
    const { client, listen } = fakeClient({ opened: subscription(Promise.resolve("remote")), listen: async () => subscription(new Promise(() => {})) });
    const sleep = vi.fn(async () => {});

    keepListening(client, { logger: spyLogger(), isCurrent: () => false, onTools: () => {}, sleep });
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledTimes(1));

    expect(listen).not.toHaveBeenCalled();
  });

  it("listens for a server that announces tool changes when the SDK couldn't open a subscription", async () => {
    const { client, listen } = fakeClient({ listen: async () => subscription(new Promise(() => {})) });

    keepListening(client, { logger: spyLogger(), isCurrent: () => true, onTools: () => {}, sleep: async () => {} });

    await vi.waitFor(() => expect(listen).toHaveBeenCalledExactlyOnceWith({ toolsListChanged: true }));
  });

  it.each([
    ["on a legacy connection", { era: "legacy" }],
    ["for a server that doesn't announce tool changes", { listChanged: false }],
  ])("does nothing without a subscription %s", async (_case, options) => {
    const { client, listen } = fakeClient({ ...options, listen: async () => subscription(new Promise(() => {})) });
    const sleep = vi.fn(async () => {});

    keepListening(client, { logger: spyLogger(), isCurrent: () => true, onTools: () => {}, sleep });
    await new Promise((resolve) => setImmediate(resolve));

    expect(sleep).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });
});
