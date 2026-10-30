import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeConfigSchema, type BridgeConfig } from "../../src/config/schema.js";
import { diffConfigs } from "../../src/config/config-diff.js";
import { ToolRegistry } from "../../src/server/tool-registry.js";
import { HttpUpstreamClient } from "../../src/upstream/http-client.js";
import { InstanceUpstreamClient } from "../../src/upstream/instance-upstream-client.js";
import { UpstreamManager } from "../../src/upstream/upstream-manager.js";
import { FakeInstanceLink } from "../_helpers/fake-instance-link.js";
import { tool } from "../_helpers/scripted-upstream-client.js";

const PLAIN = { url: "http://127.0.0.1:1/plain" };
const OAUTH = { url: "http://127.0.0.1:1/oauth", _bridge: { auth: { type: "oauth2" } } };

function config(servers: Record<string, unknown>, bridge: Record<string, unknown> = {}): BridgeConfig {
  return BridgeConfigSchema.parse({ mcpServers: servers, _bridge: bridge });
}

function fakeLink(): FakeInstanceLink {
  const link = new FakeInstanceLink();
  for (const name of ["plain", "svc"]) link.snapshots.set(name, { name, status: "connected", tools: [tool(`${name}_tool`)] });
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

  it("connects HTTP upstreams without _bridge.auth through the instance link, and the others itself", async () => {
    const registry = new ToolRegistry();
    manager = new UpstreamManager({ config: config({ plain: PLAIN, oauth: OAUTH }), toolRegistry: registry, instanceLink: fakeLink() });

    const result = await manager.connectAll();

    expect(manager.getClient("plain")).toBeInstanceOf(InstanceUpstreamClient);
    expect(manager.getClient("oauth")).toBeInstanceOf(HttpUpstreamClient);
    expect(result.failed.map((f) => f.name)).toEqual(["oauth"]);
    expect(registry.listRegisteredTools().map((t) => t.tool.name)).toEqual(["plain__plain_tool"]);
  });

  it("reports the missing link as a connect failure instead of connecting in-process", async () => {
    manager = new UpstreamManager({ config: config({ plain: PLAIN }), toolRegistry: new ToolRegistry() });

    const result = await manager.connectAll();

    expect(result.failed).toEqual([{ name: "plain", error: "no daemon instance link to connect this upstream through" }]);
    expect(manager.getClient("plain")).toBeUndefined();
  });

  it("leaves health checks of daemon-hosted upstreams to the daemon", async () => {
    vi.useFakeTimers();
    const ping = vi.spyOn(InstanceUpstreamClient.prototype, "ping");
    manager = new UpstreamManager({ config: config({ plain: PLAIN }, { healthCheckInterval: 1 }), toolRegistry: new ToolRegistry(), instanceLink: fakeLink() });
    await manager.connectAll();
    manager.startHealthChecks();

    await vi.advanceTimersByTimeAsync(3_000);

    expect(ping).not.toHaveBeenCalled();
  });

  it("moves a server between the daemon and the bridge when a reload adds or removes its _bridge.auth", async () => {
    const before = config({ svc: PLAIN });
    const after = config({ svc: { ...PLAIN, _bridge: { auth: { type: "oauth2" } } } });
    manager = new UpstreamManager({ config: before, toolRegistry: new ToolRegistry(), instanceLink: fakeLink() });
    await manager.connectAll();

    await manager.applyConfigDiff(diffConfigs(before, after), after);
    expect(manager.getClient("svc")).toBeInstanceOf(HttpUpstreamClient);

    await manager.applyConfigDiff(diffConfigs(after, before), before);
    expect(manager.getClient("svc")).toBeInstanceOf(InstanceUpstreamClient);
  });

  it("closes the link with the upstreams", async () => {
    const link = fakeLink();
    manager = new UpstreamManager({ config: config({ plain: PLAIN }), toolRegistry: new ToolRegistry(), instanceLink: link });
    await manager.connectAll();

    await manager.closeAll();

    expect(link.close).toHaveBeenCalledTimes(1);
    expect(link.viewsOf("plain")).toEqual([]);
  });
});
