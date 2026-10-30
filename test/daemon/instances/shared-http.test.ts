import { describe, expect, it, vi } from "vitest";
import { diffConfigs } from "../../../src/config/config-diff.js";
import { loadConfig } from "../../../src/config/loader.js";
import { loadMergedConfig } from "../../../src/config/merged-loader.js";
import { HttpUpstreamClient } from "../../../src/upstream/http-client.js";
import { InstanceUpstreamClient } from "../../../src/upstream/instance-upstream-client.js";
import { ECHOED } from "../../_helpers/counting-http-upstream.js";
import { settledWithin } from "../../_helpers/processes.js";
import { useSharedHttpFixture } from "../../_helpers/shared-http-fixture.js";
import { startSseUpstream } from "../../_helpers/sse-upstream.js";

describe.skipIf(process.platform === "win32")("HTTP upstreams shared through daemon instances", { timeout: 30_000 }, () => {
  const fixture = useSharedHttpFixture();
  const { daemon, upstream, closeLater, writeJson, rewriteJsonUntil, bridge, status } = fixture;

  it.each(["modern", "legacy"] as const)("gives two clients on one config one %s connection and one health check stream", async (era) => {
    await daemon();
    const server = await upstream({ era });
    const config = await writeJson("bridge.json", { mcpServers: { svc: { url: server.url } }, _bridge: { healthCheckInterval: 1 } });
    const [a, b] = [await bridge(config), await bridge(config)];

    expect(a.tools()).toEqual(["svc__echo", "svc__slow"]);
    expect(b.tools()).toEqual(["svc__echo", "svc__slow"]);
    expect(await a.call("svc")).toEqual(ECHOED);
    expect(await b.call("svc")).toEqual(ECHOED);
    expect(server.count("tools/list")).toBe(1);
    if (era === "legacy") expect(server.sessions()).toBe(1);
    const healthMethod = era === "legacy" ? "ping" : "server/discover";
    const before = server.count(healthMethod);
    await new Promise((resolve) => setTimeout(resolve, 3_300));
    expect(server.count(healthMethod) - before).toBeGreaterThanOrEqual(2);
    expect(server.count(healthMethod) - before).toBeLessThanOrEqual(4);
    expect((await status()).instances).toEqual([{ source: { kind: "file", path: config }, bridges: 2, upstreams: ["svc"] }]);
  });

  it("gives two clients one connection to a server on the deprecated SSE transport", async () => {
    await daemon();
    const server = await startSseUpstream();
    closeLater(server);
    const config = await writeJson("bridge.json", { mcpServers: { svc: { type: "sse", url: server.url } } });
    const [a, b] = [await bridge(config), await bridge(config)];

    expect(await a.call("svc")).toEqual([{ type: "text", text: "echoed over sse" }]);
    expect(await b.call("svc")).toEqual([{ type: "text", text: "echoed over sse" }]);
    expect(a.tools()).toEqual(["svc__echo"]);
    expect(server.streams()).toBe(1);
  });

  it("starts one new legacy session for both clients after the server ends the shared one", async () => {
    await daemon();
    const server = await upstream({ era: "legacy" });
    const config = await writeJson("bridge.json", { mcpServers: { svc: { url: server.url } }, _bridge: { healthCheckInterval: 1 } });
    const [a, b] = [await bridge(config), await bridge(config)];

    await server.endSessions();

    await vi.waitFor(() => expect(server.sessions()).toBe(2), { timeout: 15_000 });
    await vi.waitFor(() => expect([a.client("svc").status, b.client("svc").status]).toEqual(["connected", "connected"]), { timeout: 5_000 });
    expect(await a.call("svc")).toEqual(ECHOED);
    expect(await b.call("svc")).toEqual(ECHOED);
    expect(server.sessions()).toBe(2);
  });

  it("shares a server named the same way in another config file, and connects a different URL on its own", async () => {
    await daemon();
    const [shared, separate] = [await upstream(), await upstream()];
    const first = await writeJson("bridge.json", { mcpServers: { svc: { url: shared.url } } });
    const second = await writeJson("other.json", { mcpServers: { svc: { url: shared.url } } });
    const third = await writeJson("third.json", { mcpServers: { svc: { url: separate.url } } });

    await bridge(first);
    await bridge(second);
    const elsewhere = await bridge(third);

    expect(shared.count("tools/list")).toBe(1);
    expect(separate.count("tools/list")).toBe(1);
    expect(await elsewhere.call("svc")).toEqual(ECHOED);
    expect((await status()).instances).toHaveLength(3);
    expect((await status()).httpUpstreams).toEqual([
      { serverName: "svc", status: "connected", instances: 2 },
      { serverName: "svc", status: "connected", instances: 1 },
    ]);
  });

  it.each(["modern", "legacy"] as const)("cancels a tool call on the %s server when the client cancels it", async (era) => {
    await daemon();
    const server = await upstream({ era });
    const a = await bridge(await writeJson("bridge.json", { mcpServers: { svc: { url: server.url } } }));
    const controller = new AbortController();

    const call = a.client("svc").callTool({ name: "slow" }, { signal: controller.signal });
    await vi.waitFor(() => expect(server.count("tools/call")).toBe(1));
    controller.abort();

    await expect(call).rejects.toThrow();
    await vi.waitFor(() => expect(server.cancellations()).toBe(1));
  });

  it.each(["modern", "legacy"] as const)("passes the %s server's instructions to every client", async (era) => {
    await daemon();
    const server = await upstream({ era, instructions: "Use echo to repeat things." });
    const config = await writeJson("bridge.json", { mcpServers: { svc: { url: server.url } } });
    const [a, b] = [await bridge(config), await bridge(config)];

    expect(a.client("svc").instructions).toBe("Use echo to repeat things.");
    expect(b.client("svc").instructions).toBe("Use echo to repeat things.");
  });

  it("serves a server added to a client config file in merged mode to every attached client", async () => {
    await daemon();
    const [svc, fresh] = [await upstream(), await upstream()];
    const clientFile = await writeJson("client.json", { mcpServers: { svc: { url: svc.url } } });
    const bridgeConfig = await writeJson("config.json", { configPaths: [clientFile] });
    const [a, b] = [await bridge(bridgeConfig, { kind: "merged" }), await bridge(bridgeConfig, { kind: "merged" })];

    await rewriteJsonUntil("client.json", { mcpServers: { svc: { url: svc.url }, fresh: { url: fresh.url } } }, async () =>
      expect((await status()).instances[0]!.upstreams).toEqual(["fresh", "svc"]),
    );
    for (const each of [a, b]) {
      const next = (await loadMergedConfig({ bridgeConfigPath: bridgeConfig })).config;
      await each.manager.applyConfigDiff(diffConfigs(each.config, next), next);
    }

    expect(a.tools()).toContain("fresh__echo");
    expect(b.tools()).toContain("fresh__echo");
    expect(await a.call("fresh")).toEqual(ECHOED);
    expect(await b.call("fresh")).toEqual(ECHOED);
    expect(fresh.count("tools/list")).toBe(1);
  });

  it("loads a server a client asks for before the daemon's own watcher has seen the edit", async () => {
    await daemon({ watchDebounceMs: 60_000 });
    const [svc, fresh] = [await upstream(), await upstream()];
    const config = await writeJson("bridge.json", { mcpServers: { svc: { url: svc.url } } });
    const a = await bridge(config);

    await writeJson("bridge.json", { mcpServers: { svc: { url: svc.url }, fresh: { url: fresh.url } } });
    const next = await loadConfig({ configPath: config });
    await a.manager.applyConfigDiff(diffConfigs(a.config, next), next);

    expect(a.client("fresh").status).toBe("connected");
    expect(await a.call("fresh")).toEqual(ECHOED);
  });

  it("closes the connection idleMs after the last client leaves, and reuses it for a client attaching before then", async () => {
    await daemon({ idleMs: 2_000 });
    const server = await upstream();
    const config = await writeJson("bridge.json", { mcpServers: { svc: { url: server.url } } });
    await (await bridge(config)).manager.closeAll();
    await vi.waitFor(async () => expect((await status()).instances[0]?.bridges).toBe(0));

    const again = await bridge(config);
    expect(server.count("tools/list")).toBe(1);
    await again.manager.closeAll();

    await vi.waitFor(async () => expect((await status()).httpUpstreams).toEqual([]), { timeout: 6_000 });
    expect((await status()).instances).toEqual([]);
  });

  it("connects an upstream with _bridge.auth from each client, and the plain one once through the daemon", async () => {
    await daemon();
    const [plain, oauth] = [await upstream(), await upstream()];
    const config = await writeJson("bridge.json", {
      mcpServers: { plain: { url: plain.url }, oauth: { url: oauth.url, _bridge: { auth: { type: "oauth2", clientId: "c" } } } },
    });
    const [a, b] = [await bridge(config), await bridge(config)];

    expect(a.manager.getClient("oauth")).toBeInstanceOf(HttpUpstreamClient);
    expect(a.manager.getClient("plain")).toBeInstanceOf(InstanceUpstreamClient);
    expect(await a.call("oauth")).toEqual(ECHOED);
    expect(await b.call("plain")).toEqual(ECHOED);
    expect(oauth.count("tools/list")).toBe(2);
    expect(plain.count("tools/list")).toBe(1);
  });

  it("writes an upstream warning to each client's log with the server name, and to the daemon log", async () => {
    await daemon();
    const server = await upstream();
    const config = await writeJson("bridge.json", { mcpServers: { svc: { url: server.url } }, _bridge: { healthCheckInterval: 1 } });
    const [a, b] = [await bridge(config), await bridge(config)];

    server.failHealthChecks(true);

    const pingFailed = expect.objectContaining({ level: "warn", message: "ping failed", context: expect.objectContaining({ component: "health", server: "svc" }) });
    await vi.waitFor(() => expect(a.lines).toContainEqual(pingFailed), { timeout: 5_000 });
    expect(b.lines).toContainEqual(pingFailed);
    expect(fixture.daemonLines).toContainEqual(pingFailed);
  });

  it("lets a call in flight finish while a reload adds a server, and fails it cleanly when a reload removes its server", async () => {
    await daemon();
    const [svc, fresh] = [await upstream(), await upstream()];
    const config = await writeJson("bridge.json", { mcpServers: { svc: { url: svc.url } } });
    const a = await bridge(config);
    const slow = a.client("svc").callTool({ name: "slow" });
    slow.catch(() => {});
    await vi.waitFor(() => expect(svc.count("tools/call")).toBe(1));

    await rewriteJsonUntil("bridge.json", { mcpServers: { svc: { url: svc.url }, fresh: { url: fresh.url } } }, async () =>
      expect((await status()).instances[0]!.upstreams).toEqual(["fresh", "svc"]),
    );
    expect(await settledWithin(slow, 200)).toBe(false);
    expect(svc.cancellations()).toBe(0);

    await rewriteJsonUntil("bridge.json", { mcpServers: { fresh: { url: fresh.url } } }, async () =>
      expect((await status()).instances[0]!.upstreams).toEqual(["fresh"]),
    );
    await expect(slow).rejects.toThrow("Connection closed");
  });

  it("reports an unreachable server to each client, and connects once it is back", async () => {
    await daemon();
    const server = await upstream();
    server.setReachable(false);
    const config = await writeJson("bridge.json", {
      mcpServers: { svc: { url: server.url, _bridge: { reconnect: { reconnectBaseDelay: 100, reconnectMaxDelay: 1_000 } } } },
    });
    const [a, b] = [await bridge(config), await bridge(config)];

    for (const each of [a, b]) {
      expect(each.client("svc").status).not.toBe("connected");
      expect(each.lines).toContainEqual(expect.objectContaining({ level: "error", message: expect.stringContaining("failed to connect") }));
    }
    server.setReachable(true);

    await vi.waitFor(() => expect([a.client("svc").status, b.client("svc").status]).toEqual(["connected", "connected"]), { timeout: 5_000 });
    expect(await b.call("svc")).toEqual(ECHOED);
    expect(server.count("tools/list")).toBe(1);
  });

  it("closes a connection's sockets when the connection closes", async () => {
    await daemon({ idleMs: 200 });
    const server = await upstream();
    const config = await writeJson("bridge.json", { mcpServers: { svc: { url: server.url } } });
    const a = await bridge(config);
    expect(await a.call("svc")).toEqual(ECHOED);
    expect(server.openSockets()).toBeGreaterThan(0);

    await a.manager.closeAll();

    await vi.waitFor(async () => expect((await status()).httpUpstreams).toEqual([]), { timeout: 5_000 });
    await vi.waitFor(() => expect(server.openSockets()).toBe(0), { timeout: 2_000 });
  });
});
