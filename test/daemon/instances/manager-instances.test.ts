import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { BridgeConfigSchema } from "../../../src/config/schema.js";
import type { CredentialStore } from "../../../src/credentials/credential-store.js";
import { tellManagerAuthChanged } from "../../../src/daemon/auth-changed.js";
import { DaemonClient } from "../../../src/daemon/client.js";
import { InstanceHost } from "../../../src/daemon/instances/instance-host.js";
import { ManagerDaemon } from "../../../src/daemon/manager.js";
import { netTransport } from "../../../src/daemon/net-transport.js";
import { MIN_BRIDGE_PROTOCOL_VERSION, type DaemonNotification, type StatusResult } from "../../../src/daemon/protocol.js";
import { ScriptedUpstreamClient } from "../../_helpers/scripted-upstream-client.js";

const source = { kind: "file" as const, path: "/home/u/bridge.json" };
const attachParams = { bridgeProtocolVersion: MIN_BRIDGE_PROTOCOL_VERSION, source, env: {}, childEnv: {} };

describe.skipIf(process.platform === "win32")("ManagerDaemon with instances", () => {
  let dir: string;
  let manager: ManagerDaemon;
  let clients: ScriptedUpstreamClient[];
  const bridges: DaemonClient[] = [];

  function start(idleMs = 60_000, killGraceMs?: number): Promise<void> {
    manager = new ManagerDaemon({
      socketPath: join(dir, "m.sock"),
      pidPath: join(dir, "m.pid"),
      lockPath: join(dir, "m.lock"),
      idleMs,
      killGraceMs,
      transport: netTransport,
      _instances: {
        loadConfig: async () => ({
          config: BridgeConfigSchema.parse({ mcpServers: { svc: { url: "https://svc.example.com/mcp" } } }),
          watchPaths: [],
        }),
        createCredentialStore: () => ({}) as CredentialStore,
        createHttpClient: (name) => {
          const client = new ScriptedUpstreamClient(name);
          clients.push(client);
          return client;
        },
      },
    });
    return manager.start();
  }

  async function bridge(): Promise<{ client: DaemonClient; notifications: DaemonNotification[] }> {
    const notifications: DaemonNotification[] = [];
    const client = new DaemonClient({
      socketPath: join(dir, "m.sock"),
      transport: netTransport,
      rpcTimeoutMs: 5_000,
      onNotification: (n) => notifications.push(n),
    });
    await client.connect();
    bridges.push(client);
    return { client, notifications };
  }

  beforeEach(async () => {
    dir = await mkdtemp("/tmp/cbe-mgri-");
    clients = [];
  });

  afterEach(async () => {
    for (const client of bridges.splice(0)) client.close();
    await manager.stop(0).catch(() => {});
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("attaches a bridge, streaming the snapshots before the reply, and lists the instance in STATUS", async () => {
    await start();
    const { client, notifications } = await bridge();

    expect(await client.call("ATTACH", attachParams)).toEqual({ upstreams: ["svc"] });
    expect(notifications).toEqual([{ method: "UPSTREAM", params: { name: "svc", status: "connected", tools: [] } }]);
    const status = (await client.call("STATUS")) as StatusResult;
    expect(status.instances).toEqual([{ source, bridges: 1, upstreams: ["svc"] }]);
    expect(status.upstreams).toEqual([{ serverName: "svc", type: "streamable-http", status: "connected", instances: 1 }]);
  });

  it("routes tool calls, retries and cancellations to the instance", async () => {
    await start();
    const { client } = await bridge();
    await client.call("ATTACH", attachParams);

    expect(await client.call("CALL_TOOL", { callId: "1", upstream: "svc", name: "search" }, { timeoutMs: 0 })).toEqual({
      content: [{ type: "text", text: "called search" }],
    });
    expect(await client.call("RETRY", { upstream: "svc" })).toMatchObject({ name: "svc", status: "connected" });

    clients[0]!.answer = (call) => new Promise((_, reject) => call.signal!.addEventListener("abort", () => reject(new Error("aborted"))));
    const slow = client.call("CALL_TOOL", { callId: "2", upstream: "svc", name: "slow" }, { timeoutMs: 0 });
    await vi.waitFor(() => expect(clients[0]!.calls).toHaveLength(2));
    client.sendNotification("CANCEL_TOOL", { callId: "2" });
    await expect(slow).rejects.toThrow("Request cancelled");
  });

  it("reconnects a server when told its credentials changed, by a connection that never attached", async () => {
    await start();
    const { client } = await bridge();
    await client.call("ATTACH", attachParams);
    clients[0]!.setStatus("auth_required", new Error("needs auth"));
    const control = await bridge();

    expect(await control.client.call("AUTH_CHANGED", { upstream: "svc" })).toEqual({ connections: 1 });
    expect(clients[0]!.status).toBe("connected");

    await tellManagerAuthChanged("svc", { socketPath: join(dir, "m.sock") });
    expect(clients[0]!.reconnects).toBe(2);
  });

  it("answers a reply too large to send with an error instead of leaving the call waiting", async () => {
    await start();
    const { client } = await bridge();
    await client.call("ATTACH", attachParams);
    clients[0]!.answer = async () => ({ content: [{ type: "text", text: "x".repeat(17 * 1024 * 1024) }] });

    await expect(client.call("CALL_TOOL", { callId: "1", upstream: "svc", name: "huge" }, { timeoutMs: 0 })).rejects.toThrow(
      "the reply is too large for the manager to send",
    );
    expect(await client.call("RETRY", { upstream: "svc" })).toMatchObject({ status: "connected" });
  });

  it("stays up while an instance outlives its last bridge, then stops idleMs after the instance closes", async () => {
    await start(300);
    const { client } = await bridge();
    await client.call("ATTACH", attachParams);
    const detachedAt = Date.now();
    client.close();

    const code = await manager.waitForExit();

    expect(code).toBe(0);
    expect(Date.now() - detachedAt).toBeGreaterThanOrEqual(550);
    expect(clients[0]!.closed).toBe(true);
  });

  it("closes instances and their connections when it stops", async () => {
    await start();
    const { client } = await bridge();
    await client.call("ATTACH", attachParams);

    await manager.stop(0);

    expect(clients[0]!.closed).toBe(true);
  });

  it("gives connections no longer than its kill grace to save their refreshes' tokens when it stops", async () => {
    await start(60_000, 300);
    const closing = vi.spyOn(InstanceHost.prototype, "close");

    await manager.stop(0);

    expect(closing).toHaveBeenCalledWith(300);
  });
});
