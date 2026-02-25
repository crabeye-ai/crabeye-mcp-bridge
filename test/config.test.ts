import { describe, it, expect, afterEach } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BridgeConfigSchema,
  StdioServerConfigSchema,
  HttpServerConfigSchema,
  GlobalBridgeConfigSchema,
  isHttpServer,
  isStdioServer,
  resolveUpstreams,
  type ServerConfig,
  type BridgeConfig,
} from "../src/config/schema.js";
import {
  resolveConfigPath,
  loadConfig,
  ConfigError,
} from "../src/config/loader.js";
import { generateJsonSchema } from "../src/config/json-schema.js";

// --- Schema validation ---

describe("schema validation", () => {
  it("accepts a valid full config", () => {
    const input = {
      mcpServers: {
        myStdio: {
          command: "node",
          args: ["server.js"],
          env: { FOO: "bar" },
          _bridge: { auth: { type: "oauth2", clientId: "abc", endpoints: { authorization: "https://auth.example.com/authorize", token: "https://auth.example.com/token" }, scopes: ["read"] } },
        },
        myHttp: {
          type: "streamable-http",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer tok" },
        },
      },
      _bridge: {
        port: 8080,
        logLevel: "debug",
        maxUpstreamConnections: 10,
        connectionTimeout: 15,
        idleTimeout: 300,
      },
    };

    const result = BridgeConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data._bridge.port).toBe(8080);
      expect(Object.keys(result.data.mcpServers)).toHaveLength(2);
    }
  });

  it("accepts a minimal STDIO server config", () => {
    const input = { mcpServers: { s: { command: "node" } } };
    const result = BridgeConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mcpServers.s).toEqual({ command: "node" });
    }
  });

  it("accepts an HTTP streamable-http server", () => {
    const input = {
      mcpServers: { h: { type: "streamable-http", url: "https://example.com/mcp" } },
    };
    const result = BridgeConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("accepts an SSE server with OAuth", () => {
    const input = {
      mcpServers: {
        h: {
          type: "sse",
          url: "https://example.com/sse",
          _bridge: {
            auth: {
              type: "oauth2",
              clientId: "client-123",
              endpoints: {
                authorization: "https://auth.example.com/authorize",
                token: "https://auth.example.com/token",
              },
              scopes: ["read", "write"],
            },
          },
        },
      },
    };
    const result = BridgeConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("accepts a bare-URL HTTP server (Cursor-style)", () => {
    const input = {
      mcpServers: { h: { url: "https://example.com/mcp" } },
    };
    const result = BridgeConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mcpServers.h).toMatchObject({
        type: "streamable-http",
        url: "https://example.com/mcp",
      });
    }
  });

  it("accepts a STDIO server with type: stdio (Cursor-style)", () => {
    const input = {
      mcpServers: {
        s: { type: "stdio", command: "node", args: ["server.js"], env: {} },
      },
    };
    const result = BridgeConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mcpServers.s).toEqual({
        command: "node",
        args: ["server.js"],
        env: {},
      });
    }
  });

  it("applies defaults when _bridge is omitted", () => {
    const input = { mcpServers: { s: { command: "node" } } };
    const result = BridgeConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data._bridge).toEqual({
        port: 19875,
        logLevel: "info",
        maxUpstreamConnections: 20,
        connectionTimeout: 30,
        idleTimeout: 600,
      });
    }
  });

  it("applies defaults for partial _bridge", () => {
    const input = {
      mcpServers: { s: { command: "node" } },
      _bridge: { port: 3000 },
    };
    const result = BridgeConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data._bridge.port).toBe(3000);
      expect(result.data._bridge.logLevel).toBe("info");
    }
  });
});

// --- Invalid configs ---

describe("invalid configs", () => {
  it("rejects server with neither command nor type", () => {
    const input = { mcpServers: { bad: { args: ["foo"] } } };
    const result = BridgeConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects HTTP server with bad URL", () => {
    const result = HttpServerConfigSchema.safeParse({
      type: "streamable-http",
      url: "not-a-url",
    });
    expect(result.success).toBe(false);
  });

  it("rejects port out of range", () => {
    const result = GlobalBridgeConfigSchema.safeParse({ port: 99999 });
    expect(result.success).toBe(false);
  });

  it("rejects unknown logLevel", () => {
    const result = GlobalBridgeConfigSchema.safeParse({ logLevel: "verbose" });
    expect(result.success).toBe(false);
  });

  it("rejects extra keys in strict _bridge (server-level)", () => {
    const result = StdioServerConfigSchema.safeParse({
      command: "node",
      _bridge: { auth: undefined, unknownKey: true },
    });
    expect(result.success).toBe(false);
  });

  it("rejects extra keys in strict _bridge (global)", () => {
    const input = {
      mcpServers: { s: { command: "node" } },
      _bridge: { port: 3000, unknownGlobal: true },
    };
    const result = BridgeConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

// --- Credential template passthrough ---

describe("credential template passthrough", () => {
  it("accepts ${credential:key} in headers as plain string", () => {
    const input = {
      mcpServers: {
        h: {
          type: "streamable-http" as const,
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer ${credential:my-token}" },
        },
      },
    };
    const result = BridgeConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(
        (result.data.mcpServers.h as { headers?: Record<string, string> }).headers?.Authorization,
      ).toBe("Bearer ${credential:my-token}");
    }
  });
});

// --- Type guards ---

describe("type guards", () => {
  it("isHttpServer returns true for HTTP config", () => {
    const config: ServerConfig = {
      type: "streamable-http",
      url: "https://example.com/mcp",
    };
    expect(isHttpServer(config)).toBe(true);
    expect(isStdioServer(config)).toBe(false);
  });

  it("isStdioServer returns true for STDIO config", () => {
    const config: ServerConfig = { command: "node" };
    expect(isStdioServer(config)).toBe(true);
    expect(isHttpServer(config)).toBe(false);
  });
});

// --- Flexible upstream config keys ---

describe("flexible upstream config keys", () => {
  it("accepts config with only mcpUpstreams", () => {
    const input = {
      mcpUpstreams: { s: { command: "node" } },
    };
    const result = BridgeConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("accepts config with only servers", () => {
    const input = {
      servers: { s: { command: "node" } },
    };
    const result = BridgeConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("accepts config with both mcpUpstreams and mcpServers", () => {
    const input = {
      mcpUpstreams: { a: { command: "node" } },
      mcpServers: { b: { command: "python" } },
    };
    const result = BridgeConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("accepts config with none of the server keys (empty upstreams)", () => {
    const input = {};
    const result = BridgeConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mcpServers).toEqual({});
    }
  });
});

// --- resolveUpstreams ---

describe("resolveUpstreams", () => {
  function parsed(input: Record<string, unknown>): BridgeConfig {
    const result = BridgeConfigSchema.parse(input);
    return result;
  }

  it("merges all three sources into a union", () => {
    const config = parsed({
      mcpUpstreams: { a: { command: "node" } },
      servers: { b: { command: "python" } },
      mcpServers: { c: { command: "ruby" } },
    });
    const upstreams = resolveUpstreams(config);
    expect(Object.keys(upstreams).sort()).toEqual(["a", "b", "c"]);
  });

  it("mcpUpstreams wins over servers and mcpServers on duplicate names", () => {
    const config = parsed({
      mcpUpstreams: { s: { command: "from-upstreams" } },
      servers: { s: { command: "from-servers" } },
      mcpServers: { s: { command: "from-mcp" } },
    });
    const upstreams = resolveUpstreams(config);
    expect((upstreams.s as { command: string }).command).toBe("from-upstreams");
  });

  it("servers wins over mcpServers on duplicate names", () => {
    const config = parsed({
      servers: { s: { command: "from-servers" } },
      mcpServers: { s: { command: "from-mcp" } },
    });
    const upstreams = resolveUpstreams(config);
    expect((upstreams.s as { command: string }).command).toBe("from-servers");
  });

  it("reads from mcpServers when it is the only source", () => {
    const config = parsed({
      mcpServers: { s: { command: "node" } },
    });
    const upstreams = resolveUpstreams(config);
    expect(Object.keys(upstreams)).toEqual(["s"]);
  });

  it("excludes entries with crabeye-mcp-bridge in command from mcpServers", () => {
    const config = parsed({
      mcpServers: {
        bridge: { command: "npx crabeye-mcp-bridge", args: ["--config", "c.json"] },
        real: { command: "node", args: ["server.js"] },
        httpServer: { type: "streamable-http", url: "https://example.com/mcp" },
      },
    });
    const upstreams = resolveUpstreams(config);
    expect(Object.keys(upstreams).sort()).toEqual(["httpServer", "real"]);
  });

  it("excludes entries with crabeye-mcp-bridge in args from mcpServers", () => {
    const config = parsed({
      mcpServers: {
        bridge: { command: "npx", args: ["-y", "crabeye-mcp-bridge", "--config", "c.json"] },
        real: { command: "node", args: ["server.js"] },
      },
    });
    const upstreams = resolveUpstreams(config);
    expect(Object.keys(upstreams)).toEqual(["real"]);
  });

  it("does not apply self-exclusion to mcpUpstreams or servers", () => {
    const config = parsed({
      mcpUpstreams: { bridge1: { command: "npx crabeye-mcp-bridge" } },
      servers: { bridge2: { command: "npx", args: ["crabeye-mcp-bridge"] } },
    });
    const upstreams = resolveUpstreams(config);
    expect(Object.keys(upstreams).sort()).toEqual(["bridge1", "bridge2"]);
  });

  it("returns empty object when no server keys are provided", () => {
    const config = parsed({});
    const upstreams = resolveUpstreams(config);
    expect(upstreams).toEqual({});
  });

  it("returns empty object when no server keys are provided", () => {
    const config = parsed({});
    const upstreams = resolveUpstreams(config);
    expect(upstreams).toEqual({});
  });
});

// --- Path resolution ---

describe("resolveConfigPath", () => {
  const originalEnv = process.env.MCP_BRIDGE_CONFIG;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.MCP_BRIDGE_CONFIG;
    } else {
      process.env.MCP_BRIDGE_CONFIG = originalEnv;
    }
  });

  it("uses CLI flag when provided", () => {
    process.env.MCP_BRIDGE_CONFIG = "/env/path.json";
    const result = resolveConfigPath({ configPath: "/cli/path.json" });
    expect(result).toBe("/cli/path.json");
  });

  it("falls back to env var", () => {
    process.env.MCP_BRIDGE_CONFIG = "/env/path.json";
    const result = resolveConfigPath();
    expect(result).toBe("/env/path.json");
  });

  it("throws ConfigError when no path available", () => {
    delete process.env.MCP_BRIDGE_CONFIG;
    expect(() => resolveConfigPath()).toThrow(ConfigError);
  });
});

// --- loadConfig with temp files ---

describe("loadConfig", () => {
  const testDir = join(tmpdir(), `crabeye-mcp-bridge-test-${process.pid}`);

  async function writeConfig(name: string, content: string): Promise<string> {
    await mkdir(testDir, { recursive: true });
    const p = join(testDir, name);
    await writeFile(p, content, "utf-8");
    return p;
  }

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("loads and validates a config file", async () => {
    const validConfig = {
      mcpServers: { s: { command: "node", args: ["server.js"] } },
    };
    const p = await writeConfig("valid.json", JSON.stringify(validConfig));

    const config = await loadConfig({ configPath: p });
    expect(config.mcpServers.s).toEqual({ command: "node", args: ["server.js"] });
    expect(config._bridge.port).toBe(19875);
  });

  it("throws ConfigError for ENOENT", async () => {
    const p = join(testDir, "nonexistent.json");

    await expect(loadConfig({ configPath: p })).rejects.toThrow(ConfigError);
    await expect(loadConfig({ configPath: p })).rejects.toThrow(/not found/);
  });

  it("throws ConfigError for invalid JSON", async () => {
    const p = await writeConfig("bad.json", "not json {{{");

    await expect(loadConfig({ configPath: p })).rejects.toThrow(ConfigError);
    await expect(loadConfig({ configPath: p })).rejects.toThrow(/Invalid JSON/);
  });

  it("throws ConfigError with issues for validation failure", async () => {
    const p = await writeConfig(
      "invalid.json",
      JSON.stringify({ mcpServers: { bad: { args: ["x"] } } }),
    );

    try {
      await loadConfig({ configPath: p });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).issues.length).toBeGreaterThan(0);
    }
  });
});

// --- JSON Schema ---

describe("generateJsonSchema", () => {
  it("produces a schema with expected structure", () => {
    const schema = generateJsonSchema();
    expect(schema).toHaveProperty("definitions");
    expect(schema).toHaveProperty("$ref");
  });
});
