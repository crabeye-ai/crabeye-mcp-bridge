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
    it("detects added servers", () => {
      const oldCfg = makeConfig({});
      const newCfg = makeConfig({
        linear: { type: "streamable-http", url: "http://localhost:3000" },
      });

      const diff = diffConfigs(oldCfg, newCfg);

      expect(diff.servers.added).toHaveLength(1);
      expect(diff.servers.added[0].name).toBe("linear");
      expect(diff.servers.removed).toHaveLength(0);
      expect(diff.servers.reconnect).toHaveLength(0);
      expect(diff.servers.updated).toHaveLength(0);
    });

    it("detects removed servers", () => {
      const oldCfg = makeConfig({
        linear: { type: "streamable-http", url: "http://localhost:3000" },
      });
      const newCfg = makeConfig({});

      const diff = diffConfigs(oldCfg, newCfg);

      expect(diff.servers.removed).toEqual(["linear"]);
      expect(diff.servers.added).toHaveLength(0);
    });

    it("detects reconnect when HTTP url changes", () => {
      const oldCfg = makeConfig({
        linear: { type: "streamable-http", url: "http://localhost:3000" },
      });
      const newCfg = makeConfig({
        linear: { type: "streamable-http", url: "http://localhost:4000" },
      });

      const diff = diffConfigs(oldCfg, newCfg);

      expect(diff.servers.reconnect).toHaveLength(1);
      expect(diff.servers.reconnect[0].name).toBe("linear");
    });

    it("detects reconnect when HTTP headers change", () => {
      const oldCfg = makeConfig({
        svc: { type: "streamable-http", url: "http://localhost:3000" },
      });
      const newCfg = makeConfig({
        svc: { type: "streamable-http", url: "http://localhost:3000", headers: { "Authorization": "Bearer abc" } },
      });

      const diff = diffConfigs(oldCfg, newCfg);
      expect(diff.servers.reconnect).toHaveLength(1);
    });

    it("detects reconnect when STDIO command changes", () => {
      const oldCfg = makeConfig({
        local: { command: "node", args: ["server.js"] },
      });
      const newCfg = makeConfig({
        local: { command: "bun", args: ["server.js"] },
      });

      const diff = diffConfigs(oldCfg, newCfg);

      expect(diff.servers.reconnect).toHaveLength(1);
      expect(diff.servers.reconnect[0].name).toBe("local");
    });

    it("detects reconnect when STDIO args change", () => {
      const oldCfg = makeConfig({
        local: { command: "node", args: ["server.js"] },
      });
      const newCfg = makeConfig({
        local: { command: "node", args: ["server.js", "--verbose"] },
      });

      const diff = diffConfigs(oldCfg, newCfg);
      expect(diff.servers.reconnect).toHaveLength(1);
    });

    it("detects reconnect when STDIO env changes", () => {
      const oldCfg = makeConfig({
        local: { command: "node", args: ["server.js"] },
      });
      const newCfg = makeConfig({
        local: { command: "node", args: ["server.js"], env: { DEBUG: "1" } },
      });

      const diff = diffConfigs(oldCfg, newCfg);
      expect(diff.servers.reconnect).toHaveLength(1);
    });

    it("detects metadata-only update when _bridge changes", () => {
      const oldCfg = makeConfig({
        linear: {
          type: "streamable-http",
          url: "http://localhost:3000",
          _bridge: { category: "project-management" },
        },
      });
      const newCfg = makeConfig({
        linear: {
          type: "streamable-http",
          url: "http://localhost:3000",
          _bridge: { category: "devtools" },
        },
      });

      const diff = diffConfigs(oldCfg, newCfg);

      expect(diff.servers.updated).toHaveLength(1);
      expect(diff.servers.updated[0].name).toBe("linear");
      expect(diff.servers.reconnect).toHaveLength(0);
    });

    it("detects metadata-only update when toolPolicy changes", () => {
      const oldCfg = makeConfig({
        linear: {
          type: "streamable-http",
          url: "http://localhost:3000",
          _bridge: { toolPolicy: "always" },
        },
      });
      const newCfg = makeConfig({
        linear: {
          type: "streamable-http",
          url: "http://localhost:3000",
          _bridge: { toolPolicy: "prompt" },
        },
      });

      const diff = diffConfigs(oldCfg, newCfg);
      expect(diff.servers.updated).toHaveLength(1);
      expect(diff.servers.reconnect).toHaveLength(0);
    });

    it("reports no changes for identical configs", () => {
      const cfg = makeConfig({
        linear: { type: "streamable-http", url: "http://localhost:3000" },
      });

      const diff = diffConfigs(cfg, cfg);

      expect(diff.servers.added).toHaveLength(0);
      expect(diff.servers.removed).toHaveLength(0);
      expect(diff.servers.reconnect).toHaveLength(0);
      expect(diff.servers.updated).toHaveLength(0);
    });

    it("handles mixed add, remove, reconnect, update simultaneously", () => {
      const oldCfg = makeConfig({
        keep: { type: "streamable-http", url: "http://localhost:1000" },
        remove: { command: "node", args: ["old.js"] },
        reconnect: { type: "streamable-http", url: "http://localhost:2000" },
        metaonly: {
          type: "streamable-http",
          url: "http://localhost:3000",
          _bridge: { category: "old" },
        },
      });
      const newCfg = makeConfig({
        keep: { type: "streamable-http", url: "http://localhost:1000" },
        add: { command: "node", args: ["new.js"] },
        reconnect: { type: "streamable-http", url: "http://localhost:2001" },
        metaonly: {
          type: "streamable-http",
          url: "http://localhost:3000",
          _bridge: { category: "new" },
        },
      });

      const diff = diffConfigs(oldCfg, newCfg);

      expect(diff.servers.added.map((s) => s.name)).toEqual(["add"]);
      expect(diff.servers.removed).toEqual(["remove"]);
      expect(diff.servers.reconnect.map((s) => s.name)).toEqual(["reconnect"]);
      expect(diff.servers.updated.map((s) => s.name)).toEqual(["metaonly"]);
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

    it("detects healthCheckInterval change", () => {
      const oldCfg = makeConfig({}, { healthCheckInterval: 30 });
      const newCfg = makeConfig({}, { healthCheckInterval: 60 });

      const diff = diffConfigs(oldCfg, newCfg);
      expect(diff.bridge.healthCheckInterval).toBe(60);
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
      expect(diff.bridge.healthCheckInterval).toBeUndefined();
      expect(diff.bridge.toolPolicy).toBeUndefined();
      expect(diff.bridge.requiresRestart).toHaveLength(0);
    });
  });
});
