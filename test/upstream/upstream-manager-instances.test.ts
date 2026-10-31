import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeConfigSchema, type BridgeConfig } from "../../src/config/schema.js";
import { diffConfigs } from "../../src/config/config-diff.js";
import { ToolRegistry } from "../../src/server/tool-registry.js";
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

  it("connects every HTTP upstream through the instance link, with or without _bridge.auth", async () => {
    const registry = new ToolRegistry();
    manager = new UpstreamManager({ config: config({ plain: PLAIN, oauth: OAUTH }), toolRegistry: registry, instanceLink: fakeLink() });

    const result = await manager.connectAll();

    expect(manager.getClient("plain")).toBeInstanceOf(InstanceUpstreamClient);
    expect(manager.getClient("oauth")).toBeInstanceOf(InstanceUpstreamClient);
    expect(result.failed).toEqual([]);
    expect(registry.listRegisteredTools().map((t) => t.tool.name).sort()).toEqual(["oauth__oauth_tool", "plain__plain_tool"]);
  });

  it("keeps a server's stand-in when a reload changes how it connects, leaving the change to the manager", async () => {
    const link = fakeLink();
    const before = config({ svc: { ...PLAIN, _bridge: { auth: { type: "oauth2", scopes: ["read"] } } } });
    const after = config({ svc: { ...PLAIN, _bridge: { auth: { type: "oauth2", scopes: ["write"] }, category: "tracker" } } });
    const registry = new ToolRegistry();
    manager = new UpstreamManager({ config: before, toolRegistry: registry, instanceLink: link });
    await manager.connectAll();
    const first = manager.getClient("svc");
    const clientsChanged = vi.fn();
    manager.onClientsChanged(clientsChanged);

    await manager.applyConfigDiff(diffConfigs(before, after), after);

    expect(manager.getClient("svc")).toBe(first);
    expect(first!.status).toBe("connected");
    expect(link.viewsOf("svc")).toHaveLength(1);
    expect(registry.getCategoryForSource("svc")).toBe("tracker");
    expect(clientsChanged).not.toHaveBeenCalled();
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
