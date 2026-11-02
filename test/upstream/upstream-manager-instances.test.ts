import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../../src/server/tool-registry.js";
import { InstanceUpstreamClient } from "../../src/upstream/instance-upstream-client.js";
import { UpstreamManager } from "../../src/upstream/upstream-manager.js";
import { FakeInstanceLink } from "../_helpers/fake-instance-link.js";
import { tool } from "../_helpers/scripted-upstream-client.js";

function fakeLink(): FakeInstanceLink {
  const link = new FakeInstanceLink();
  for (const name of ["plain", "oauth", "svc"]) link.snapshots.set(name, { name, status: "connected", tools: [tool(`${name}_tool`)] });
  return link;
}

describe("UpstreamManager with a daemon instance", () => {
  let manager: UpstreamManager | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await manager?.closeAll();
    manager = undefined;
  });

  it("connects every upstream through the instance link", async () => {
    const registry = new ToolRegistry();
    manager = new UpstreamManager({ names: ["plain", "oauth"], toolRegistry: registry, instanceLink: fakeLink() });

    const result = await manager.connectAll();

    expect(manager.getClient("plain")).toBeInstanceOf(InstanceUpstreamClient);
    expect(manager.getClient("oauth")).toBeInstanceOf(InstanceUpstreamClient);
    expect(result.failed).toEqual([]);
    expect(registry.listRegisteredTools().map((t) => t.tool.name).sort()).toEqual(["oauth__oauth_tool", "plain__plain_tool"]);
  });

  it("knows its upstreams once the instance link has attached, and at once when it can't attach", async () => {
    const link = fakeLink();
    let attached!: () => void;
    link.attachNow.mockReturnValueOnce(new Promise<void>((resolve) => (attached = resolve)));
    manager = new UpstreamManager({ names: [], toolRegistry: new ToolRegistry(), instanceLink: link });
    let known = false;

    const knowing = manager.upstreamsKnown().then(() => (known = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(known).toBe(false);
    attached();
    await knowing;
    link.attachNow.mockRejectedValueOnce(new Error("daemon unreachable"));

    await expect(manager.upstreamsKnown()).resolves.toBeUndefined();
  });

  it("closes the link with the upstreams", async () => {
    const link = fakeLink();
    manager = new UpstreamManager({ names: ["plain"], toolRegistry: new ToolRegistry(), instanceLink: link });
    await manager.connectAll();

    await manager.closeAll();

    expect(link.close).toHaveBeenCalledTimes(1);
    expect(link.viewsOf("plain")).toEqual([]);
  });
});
