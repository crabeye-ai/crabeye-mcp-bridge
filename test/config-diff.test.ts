import { describe, it, expect } from "vitest";
import { diffConfigs } from "../src/config/config-diff.js";
import type { BridgeConfig } from "../src/config/schema.js";
import { BridgeConfigSchema } from "../src/config/schema.js";

function makeConfig(
  servers: Record<string, unknown>,
  bridgeOverrides: Record<string, unknown> = {},
): BridgeConfig {
  return BridgeConfigSchema.parse({
    mcpServers: servers,
    _bridge: bridgeOverrides,
  });
}

describe("diffConfigs", () => {
  describe("server changes", () => {
    const http = (url: string, extra: Record<string, unknown> = {}) => ({ type: "streamable-http", url, ...extra });

    it("detects added and removed servers", () => {
      const kept = http("http://localhost:3000");
      const diff = diffConfigs(makeConfig({ kept, gone: http("http://localhost:1000") }), makeConfig({ kept, fresh: http("http://localhost:2000") }));

      expect(diff.servers.added.map((a) => a.name)).toEqual(["fresh"]);
      expect(diff.servers.removed).toEqual(["gone"]);
      expect(diff.servers.changed).toEqual([]);
    });

    it.each([
      ["its URL", http("http://localhost:3000"), http("http://localhost:4000")],
      ["its headers", http("http://localhost:3000"), http("http://localhost:3000", { headers: { Authorization: "Bearer abc" } })],
      ["its _bridge.auth", http("http://localhost:3000", { _bridge: { auth: { type: "oauth2" } } }), http("http://localhost:3000", { _bridge: { auth: { type: "oauth2", scopes: ["read"] } } })],
      ["its category", http("http://localhost:3000", { _bridge: { category: "a" } }), http("http://localhost:3000", { _bridge: { category: "b" } })],
      ["its toolPolicy", http("http://localhost:3000", { _bridge: { toolPolicy: "always" } }), http("http://localhost:3000", { _bridge: { toolPolicy: "prompt" } })],
      ["a STDIO command", { command: "node", args: ["server.js"] }, { command: "bun", args: ["server.js"] }],
      ["STDIO args", { command: "node", args: ["server.js"] }, { command: "node", args: ["server.js", "--verbose"] }],
      ["STDIO env", { command: "node" }, { command: "node", env: { DEBUG: "1" } }],
      ["STDIO cwd", { command: "node" }, { command: "node", cwd: "/srv" }],
    ])("reports a server whose %s changed, with its new entry", (_label, before, after) => {
      const diff = diffConfigs(makeConfig({ svc: before }), makeConfig({ svc: after }));

      expect(diff.servers.changed).toEqual([{ name: "svc", config: makeConfig({ svc: after }).mcpServers.svc }]);
      expect(diff.servers.added).toEqual([]);
      expect(diff.servers.removed).toEqual([]);
    });

    it("reports no changes for configs that differ only in key order", () => {
      const before = makeConfig({ linear: { type: "streamable-http", url: "http://localhost:3000", headers: { A: "1", B: "2" } } });
      const after = makeConfig({ linear: { headers: { B: "2", A: "1" }, url: "http://localhost:3000", type: "streamable-http" } });

      expect(diffConfigs(before, after).servers).toEqual({ added: [], removed: [], changed: [] });
    });
  });

  describe("bridge changes", () => {
    it("detects logLevel change", () => {
      const oldCfg = makeConfig({}, { logLevel: "info" });
      const newCfg = makeConfig({}, { logLevel: "debug" });

      const diff = diffConfigs(oldCfg, newCfg);
      expect(diff.bridge.logLevel).toBe("debug");
    });

    it("flags logFormat as requiresRestart", () => {
      const oldCfg = makeConfig({}, { logFormat: "text" });
      const newCfg = makeConfig({}, { logFormat: "json" });

      const diff = diffConfigs(oldCfg, newCfg);
      expect(diff.bridge.requiresRestart).toContain("logFormat");
    });

    it("detects toolPolicy change", () => {
      const oldCfg = makeConfig({}, { toolPolicy: "always" });
      const newCfg = makeConfig({}, { toolPolicy: "prompt" });

      const diff = diffConfigs(oldCfg, newCfg);
      expect(diff.bridge.toolPolicy).toBe("prompt");
    });

    it("flags port as requiresRestart", () => {
      const oldCfg = makeConfig({}, { port: 19875 });
      const newCfg = makeConfig({}, { port: 8080 });

      const diff = diffConfigs(oldCfg, newCfg);
      expect(diff.bridge.requiresRestart).toContain("port");
    });

    it("flags maxUpstreamConnections as requiresRestart", () => {
      const oldCfg = makeConfig({}, { maxUpstreamConnections: 1000 });
      const newCfg = makeConfig({}, { maxUpstreamConnections: 500 });

      const diff = diffConfigs(oldCfg, newCfg);
      expect(diff.bridge.requiresRestart).toContain("maxUpstreamConnections");
    });

    it("flags connectionTimeout as requiresRestart", () => {
      const oldCfg = makeConfig({}, {});
      const newCfg = makeConfig({}, { connectionTimeout: 60 });

      const diff = diffConfigs(oldCfg, newCfg);
      expect(diff.bridge.requiresRestart).toContain("connectionTimeout");
    });

    it("flags idleTimeout as requiresRestart", () => {
      const oldCfg = makeConfig({}, {});
      const newCfg = makeConfig({}, { idleTimeout: 1200 });

      const diff = diffConfigs(oldCfg, newCfg);
      expect(diff.bridge.requiresRestart).toContain("idleTimeout");
    });

    it("no bridge changes for identical config", () => {
      const cfg = makeConfig({}, { logLevel: "info" });
      const diff = diffConfigs(cfg, cfg);

      expect(diff.bridge.logLevel).toBeUndefined();
      expect(diff.bridge.toolPolicy).toBeUndefined();
      expect(diff.bridge.requiresRestart).toHaveLength(0);
    });
  });
});
