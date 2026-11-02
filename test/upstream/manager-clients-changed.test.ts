import { afterEach, describe, expect, it } from "vitest";
import { InMemoryTransport, Server } from "@modelcontextprotocol/server";
import type { Transport } from "@modelcontextprotocol/client";
import { UpstreamManager } from "../../src/upstream/upstream-manager.js";
import { BaseUpstreamClient } from "../../src/upstream/base-client.js";
import { ToolRegistry } from "../../src/server/tool-registry.js";
import { createNoopLogger } from "../../src/logging/index.js";
import type { ConnectionStatus, UpstreamClient } from "../../src/upstream/types.js";
import { FakeInstanceLink } from "../_helpers/fake-instance-link.js";

function inMemoryUpstream(name: string): Transport {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name, version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler("tools/list", () => ({ tools: [] }));
  void server.connect(serverSide);
  return clientSide;
}

class InMemoryUpstreamClient extends BaseUpstreamClient {
  protected _buildTransport(): Transport {
    return inMemoryUpstream(this.name);
  }
}

function clientFactory(name: string): UpstreamClient {
  return new InMemoryUpstreamClient({ name });
}

interface Seen {
  client: UpstreamClient | undefined;
  status: ConnectionStatus | undefined;
}

describe("UpstreamManager following the instance's upstreams", () => {
  let manager: UpstreamManager | undefined;
  let link: FakeInstanceLink;

  afterEach(async () => {
    await manager?.closeAll().catch(() => {});
    manager = undefined;
  });

  async function startWith(names: string[], watched = "alpha"): Promise<Seen[]> {
    link = new FakeInstanceLink();
    manager = new UpstreamManager({ names, toolRegistry: new ToolRegistry(), logger: createNoopLogger(), instanceLink: link, _clientFactory: clientFactory });
    await manager.connectAll();
    const seen: Seen[] = [];
    manager.onClientsChanged(() => {
      const client = manager!.getClient(watched);
      seen.push({ client, status: client?.status });
    });
    return seen;
  }

  it("fires once when the instance loses a server, after it is gone", async () => {
    const seen = await startWith(["alpha", "beta"]);

    link.setUpstreams(["beta"]);

    expect(seen).toEqual([{ client: undefined, status: undefined }]);
  });

  it("keeps the client and fires nothing when the instance still has the server", async () => {
    const seen = await startWith(["alpha"]);
    const old = manager!.getClient("alpha");

    link.setUpstreams(["alpha"]);

    expect(seen).toEqual([]);
    expect(manager!.getClient("alpha")).toBe(old);
  });

  it("fires when the instance gains a server the bridge's config didn't list", async () => {
    const seen = await startWith(["beta"]);

    link.setUpstreams(["alpha", "beta"]);

    expect(seen.map((s) => s.client)).toEqual([manager!.getClient("alpha")]);
  });

  it("keeps the servers from the bridge's config until it has attached", async () => {
    const seen = await startWith(["alpha"]);
    link.isAttached = false;

    link.setUpstreams(["beta"]);

    expect(manager!.getClient("alpha")).toBeDefined();
    expect(seen.map((s) => s.client)).toEqual([manager!.getClient("alpha")]);
  });

  it("attaches even when the bridge's config names no server, so it hears of the ones the instance gains", async () => {
    const seen = await startWith([]);

    link.setUpstreams(["alpha"]);

    expect(link.attach).toHaveBeenCalled();
    expect(seen.map((s) => s.client)).toEqual([manager!.getClient("alpha")]);
  });

  it("stops calling a listener after it unsubscribes", async () => {
    await startWith(["alpha"]);
    let calls = 0;
    const unsubscribe = manager!.onClientsChanged(() => calls++);
    unsubscribe();

    link.setUpstreams([]);

    expect(calls).toBe(0);
  });
});
