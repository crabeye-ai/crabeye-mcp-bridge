import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../../src/server/tool-registry.js";
import { PolicyEngine } from "../../src/policy/policy-engine.js";
import { CallRefusedError } from "../../src/upstream/call-errors.js";
import type { StatusChangeCallback, UpstreamClient } from "../../src/upstream/types.js";
import {
  createTestPair,
  FakeUpstreams,
  makeMockUpstreamClient,
  makeTool,
  useUpRequestIdZero,
} from "../_helpers/bridge-test-pair.js";
import { errorResult, viaRunTool } from "../_helpers/run-tool.js";

const REMOVED = errorResult('Upstream server "srv" was removed from the configuration');

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

describe.each([false, true])("run_tool waits across reloads and cancellation (modern: %s)", (modern) => {
  let pair: Pair | undefined;
  const upstreams = new FakeUpstreams();

  afterEach(async () => {
    await pair?.cleanup();
    pair = undefined;
    const leftoverListeners = upstreams.changeListeners.size;
    upstreams.changeListeners.clear();
    expect(leftoverListeners).toBe(0);
  });

  async function connect(policyEngine?: PolicyEngine): Promise<Pair> {
    const registry = new ToolRegistry();
    registry.setToolsForSource("srv", [makeTool("srv__op")]);
    pair = await createTestPair({
      registry,
      modern,
      getUpstreamClient: upstreams.get,
      policyEngine,
      onClientsChanged: upstreams.onClientsChanged,
    });
    return pair;
  }

  it("fails promptly with the removal when a reload removes an upstream the call is waiting on", async () => {
    const { client: down, listeners } = disconnectedClient("srv");
    upstreams.set("srv", down);
    const { client } = await connect();

    const call = client.callTool(viaRunTool("srv__op"));
    await vi.waitFor(() => expect(listeners.size).toBe(1));
    upstreams.set("srv", undefined);

    expect(await call).toMatchObject(REMOVED);
    expect(listeners.size).toBe(0);
  });

  it("calls the replacement when a reload replaces the upstream the call is waiting on", async () => {
    const { client: down, listeners } = disconnectedClient("srv");
    upstreams.set("srv", down);
    const { client } = await connect();
    const replacement = makeMockUpstreamClient("srv", {
      callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "from replacement" }] }),
    });

    const call = client.callTool(viaRunTool("srv__op"));
    await vi.waitFor(() => expect(listeners.size).toBe(1));
    upstreams.set("srv", replacement);

    expect((await call).content).toEqual([{ type: "text", text: "from replacement" }]);
    expect(down.callTool).not.toHaveBeenCalled();
  });

  it("doesn't say a call was approved when its policy needed no approval", async () => {
    const upstream = makeMockUpstreamClient("srv");
    upstreams.set("srv", upstream);
    const { client } = await connect(new PolicyEngine("always", {}));

    await client.callTool(viaRunTool("srv__op"));

    expect(upstream.callTool).toHaveBeenCalledWith({ name: "op", arguments: {} }, { signal: expect.any(AbortSignal) });
  });

  it("shows the manager's reason for refusing a call as it is", async () => {
    const upstream = makeMockUpstreamClient("srv", {
      callTool: vi.fn().mockRejectedValue(new CallRefusedError("Rate limit queue full")),
    });
    upstreams.set("srv", upstream);
    const { client } = await connect();

    expect(await client.callTool(viaRunTool("srv__op"))).toMatchObject(errorResult("Rate limit queue full"));
  });

  it("stops waiting for a reconnect when the client cancels", async () => {
    const { client: down, listeners } = disconnectedClient("srv");
    upstreams.set("srv", down);
    const { client } = await connect();
    await useUpRequestIdZero(client);
    const controller = new AbortController();

    const call = client.callTool(viaRunTool("srv__op"), { signal: controller.signal });
    await vi.waitFor(() => expect(listeners.size).toBe(1));
    controller.abort();

    await expect(call).rejects.toThrow();
    await vi.waitFor(() => expect(listeners.size).toBe(0));
    expect(down.callTool).not.toHaveBeenCalled();
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
    await useUpRequestIdZero(client);
    const controller = new AbortController();

    const call = client.callTool(viaRunTool("srv__op"), { signal: controller.signal });
    await vi.waitFor(() => expect(upstreamSignal).toBeDefined());
    controller.abort();

    await expect(call).rejects.toThrow();
    await vi.waitFor(() => expect(upstreamSignal!.aborted).toBe(true));
  });
});
