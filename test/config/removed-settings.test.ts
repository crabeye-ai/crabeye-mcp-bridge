import { describe, it, expect } from "vitest";
import { BridgeConfigSchema } from "../../src/config/schema.js";
import { findRemovedSettings, findToolPassthroughLevels, warnAboutConfig } from "../../src/config/removed-settings.js";
import { spyLogger } from "../_helpers/spy-logger.js";

const RETRIES_FOREVER = "upstreams now retry indefinitely with capped backoff";
const ONE_SHARED_PROCESS = "every bridge shares one process per STDIO server";

describe("findRemovedSettings", () => {
  it("still loads a config that sets every removed setting, and reports each one with where it is set", () => {
    const result = BridgeConfigSchema.safeParse({
      mcpServers: {
        s: { command: "node", _bridge: { sharing: "dedicated", reconnect: { maxReconnectAttempts: 5 } } },
        t: { command: "node" },
        u: { type: "streamable-http", url: "https://example.com/mcp", _bridge: { sharing: "auto" } },
      },
      _bridge: {
        reconnect: { maxReconnectAttempts: -1 },
        daemon: { autoForkDrainTimeoutMs: 1, autoForkInitializeTimeoutMs: "x" },
      },
    });

    expect(result.success).toBe(true);
    expect(findRemovedSettings(result.data!)).toEqual([
      { setting: "maxReconnectAttempts", locations: ["_bridge", 'server "s"'], reason: RETRIES_FOREVER },
      { setting: "sharing", locations: ['server "s"', 'server "u"'], reason: ONE_SHARED_PROCESS },
      { setting: "daemon.autoForkDrainTimeoutMs", locations: ["_bridge"], reason: ONE_SHARED_PROCESS },
      { setting: "daemon.autoForkInitializeTimeoutMs", locations: ["_bridge"], reason: ONE_SHARED_PROCESS },
    ]);
  });

  it("reports nothing when no removed setting is set", () => {
    expect(findRemovedSettings(BridgeConfigSchema.parse({ mcpServers: { s: { command: "node" } } }))).toEqual([]);
  });
});

describe("findToolPassthroughLevels", () => {
  it('names the servers whose passthrough is "tools" or "full"', () => {
    const config = BridgeConfigSchema.parse({
      mcpServers: {
        a: { command: "node", _bridge: { passthrough: "tools" } },
        b: { command: "node", _bridge: { passthrough: "instructions" } },
        c: { command: "node", _bridge: { passthrough: "full" } },
        d: { command: "node", _bridge: { passthrough: true } },
        e: { command: "node" },
      },
    });

    expect(findToolPassthroughLevels(config)).toEqual(['server "a"', 'server "c"']);
  });
});

describe("warnAboutConfig", () => {
  it("warns once that the tools and full passthrough levels now mean true, naming each server", () => {
    const logger = spyLogger();

    warnAboutConfig(
      BridgeConfigSchema.parse({ mcpServers: { a: { command: "node", _bridge: { passthrough: "tools" } }, b: { command: "node", _bridge: { passthrough: "full" } } } }),
      logger,
    );
    warnAboutConfig(BridgeConfigSchema.parse({ mcpServers: { c: { command: "node", _bridge: { passthrough: "instructions" } } } }), logger);

    expect(logger.warn.mock.calls).toEqual([
      ['passthrough "tools" and "full" now mean true (server "a", server "b"); a search already returns a server\'s tools', { component: "config" }],
    ]);
  });

  it("logs one warning per removed setting, naming every place it is set", () => {
    const logger = spyLogger();
    const config = BridgeConfigSchema.parse({
      mcpServers: {
        a: { command: "node", _bridge: { sharing: "dedicated", reconnect: { maxReconnectAttempts: 3 } } },
        b: { command: "node", _bridge: { sharing: "auto" } },
      },
      _bridge: { daemon: { autoForkDrainTimeoutMs: 5 }, reconnect: { maxReconnectAttempts: 1 } },
    });

    warnAboutConfig(config, logger);

    expect(logger.warn.mock.calls).toEqual([
      [
        `maxReconnectAttempts no longer has any effect and is ignored (_bridge, server "a"); ${RETRIES_FOREVER}`,
        { component: "config" },
      ],
      [`sharing no longer has any effect and is ignored (server "a", server "b"); ${ONE_SHARED_PROCESS}`, { component: "config" }],
      [`daemon.autoForkDrainTimeoutMs no longer has any effect and is ignored (_bridge); ${ONE_SHARED_PROCESS}`, { component: "config" }],
    ]);
  });

  it("logs that a server launching the bridge itself is skipped", () => {
    const logger = spyLogger();

    warnAboutConfig(BridgeConfigSchema.parse({ mcpServers: { self: { command: "npx", args: ["crabeye-mcp-bridge"] } } }), logger);

    expect(logger.info).toHaveBeenCalledWith('skipping server "self": it launches crabeye-mcp-bridge itself', { component: "config" });
  });

  it("logs nothing when no removed setting is set", () => {
    const logger = spyLogger();

    warnAboutConfig(BridgeConfigSchema.parse({ mcpServers: { a: { command: "node" } } }), logger);

    expect(logger.warn).not.toHaveBeenCalled();
  });
});
