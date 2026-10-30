import { describe, expect, it } from "vitest";
import { HttpServerConfigSchema, type HttpServerConfig } from "../../../src/config/schema.js";
import { httpUpstreamIdentity, instanceKey } from "../../../src/daemon/instances/identity.js";

const merged = { kind: "merged" as const, path: "/home/u/.crabeye-mcp-bridge/config.json" };
const http = (server: Record<string, unknown>): HttpServerConfig => HttpServerConfigSchema.parse(server);
const masterKeyEnv = (masterKey: string) => ({ MCP_BRIDGE_MASTER_KEY: masterKey });
const httpUpstreamKey = (name: string, config: HttpServerConfig, env: Record<string, string>) => httpUpstreamIdentity(name, config, env).key;

describe("instanceKey", () => {
  it("is the same for the same config and environment, whatever order the variables come in", () => {
    const a = instanceKey(merged, { MCP_BRIDGE_MASTER_KEY: "k", NOTION_OAUTH_SECRET: "s" });
    const b = instanceKey({ ...merged }, { NOTION_OAUTH_SECRET: "s", MCP_BRIDGE_MASTER_KEY: "k" });
    expect(a).toBe(b);
  });

  it.each([
    ["another config file", { kind: "file" as const, path: merged.path }, {}],
    ["another path", { kind: "merged" as const, path: "/other/config.json" }, {}],
    ["a master key", merged, { MCP_BRIDGE_MASTER_KEY: "k" }],
    ["a client secret variable", merged, { NOTION_OAUTH_SECRET: "s" }],
    ["a proxy", merged, { NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: "http://proxy:3128" }],
    ["certificate checks turned off", merged, { NODE_TLS_REJECT_UNAUTHORIZED: "0" }],
    ["the system's certificates", merged, { NODE_USE_SYSTEM_CA: "1" }],
    ["a certificate file", merged, { SSL_CERT_FILE: "/etc/ssl/cert.pem" }],
  ])("differs for %s", (_label, source, env) => {
    expect(instanceKey(source, env)).not.toBe(instanceKey(merged, {}));
  });

  it("only counts the variables that identify an instance", () => {
    expect(instanceKey(merged, { MCP_BRIDGE_MASTER_KEY: "k", PATH: "/usr/bin", HOME: "/home/u" })).toBe(instanceKey(merged, { MCP_BRIDGE_MASTER_KEY: "k" }));
  });

  it.each([
    ["proxies without NODE_USE_ENV_PROXY", { HTTPS_PROXY: "http://proxy:3128", NO_PROXY: "localhost" }],
    ["certificate checks left on", { NODE_TLS_REJECT_UNAUTHORIZED: "1" }],
    ["NODE_TLS_REJECT_UNAUTHORIZED set to something other than 0", { NODE_TLS_REJECT_UNAUTHORIZED: "false" }],
    ["NODE_USE_SYSTEM_CA set to something other than 1", { NODE_USE_SYSTEM_CA: "0" }],
  ])("ignores network variables that don't change a connection: %s", (_label, env) => {
    expect(instanceKey(merged, env)).toBe(instanceKey(merged, {}));
  });
});

describe("httpUpstreamIdentity", () => {
  const base = http({ url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer ${credential:token}" } });

  it("treats the streamable HTTP spellings as one transport", () => {
    const keys = ["http", "streamable-http", "streamableHttp"].map((type) => httpUpstreamKey("svc", { ...base, type: type as HttpServerConfig["type"] }, masterKeyEnv("k")));
    expect(new Set(keys).size).toBe(1);
  });

  it("ignores settings that only tune timing or the bridge's view", () => {
    const tuned = http({
      ...base,
      _bridge: { reconnect: { reconnectBaseDelay: 500 }, category: "work", toolPolicy: "never", passthrough: "full" },
    });
    expect(httpUpstreamKey("svc", tuned, masterKeyEnv("k"))).toBe(httpUpstreamKey("svc", base, masterKeyEnv("k")));
  });

  it("ignores client-secret variables the upstream's clientSecret doesn't name", () => {
    const named = http({ ...base, _bridge: { auth: { type: "oauth2", clientSecret: "${NOTION_OAUTH_SECRET}" } } });
    const inline = http({ ...base, _bridge: { auth: { type: "oauth2", clientSecret: "plain-secret" } } });
    const env = { ...masterKeyEnv("k"), NOTION_OAUTH_SECRET: "s" };
    expect(httpUpstreamKey("svc", base, { ...env, OTHER_OAUTH: "x" })).toBe(httpUpstreamKey("svc", base, masterKeyEnv("k")));
    expect(httpUpstreamKey("svc", inline, { ...env, OTHER_OAUTH: "x" })).toBe(httpUpstreamKey("svc", inline, masterKeyEnv("k")));
    expect(httpUpstreamKey("svc", named, { ...env, OTHER_OAUTH: "x" })).toBe(httpUpstreamKey("svc", named, env));
  });

  it("hands the connection the variable its clientSecret names, and no other", () => {
    const named = http({ ...base, _bridge: { auth: { type: "oauth2", clientSecret: "${NOTION_OAUTH_SECRET}" } } });
    const env = { ...masterKeyEnv("k"), NOTION_OAUTH_SECRET: "s", OTHER_OAUTH: "o" };
    expect(httpUpstreamIdentity("svc", named, env).env).toEqual({ NOTION_OAUTH_SECRET: "s" });
    expect(httpUpstreamIdentity("svc", named, masterKeyEnv("k")).env).toEqual({});
    expect(httpUpstreamIdentity("svc", base, env).env).toEqual({});
  });

  it("differs for another value, or no value, of the variable the upstream's clientSecret names", () => {
    const named = http({ ...base, _bridge: { auth: { type: "oauth2", clientSecret: "${NOTION_OAUTH_SECRET}" } } });
    const key = (value?: string) => httpUpstreamKey("svc", named, { ...masterKeyEnv("k"), ...(value !== undefined && { NOTION_OAUTH_SECRET: value }) });
    expect(new Set([key("s"), key("t"), key()]).size).toBe(3);
  });

  it("ignores a proxy the client doesn't use, and takes the lowercase proxy variables first", () => {
    expect(httpUpstreamKey("svc", base, { ...masterKeyEnv("k"), HTTPS_PROXY: "http://proxy:3128" })).toBe(httpUpstreamKey("svc", base, masterKeyEnv("k")));
    const proxied = { ...masterKeyEnv("k"), NODE_USE_ENV_PROXY: "1" };
    for (const name of ["http_proxy", "https_proxy", "no_proxy"]) {
      expect(httpUpstreamKey("svc", base, { ...proxied, [name]: "http://a:1", [name.toUpperCase()]: "http://b:1" })).toBe(
        httpUpstreamKey("svc", base, { ...proxied, [name]: "http://a:1" }),
      );
    }
  });

  it("describes the connection with the same settings it is keyed by", () => {
    expect(httpUpstreamIdentity("svc", base, { ...masterKeyEnv("k"), NODE_USE_ENV_PROXY: "1", http_proxy: "http://p:1", NODE_EXTRA_CA_CERTS: "/etc/ca.pem" }).network).toEqual({
      rejectUnauthorized: true,
      useSystemCa: false,
      extraCaFile: "/etc/ca.pem",
      certFile: null,
      proxy: { http: "http://p:1", https: "", noProxy: "" },
    });
  });

  it.each([
    ["another server name", "other", base, masterKeyEnv("k")],
    ["SSE", "svc", { ...base, type: "sse" as const }, masterKeyEnv("k")],
    ["another URL", "svc", { ...base, url: "https://mcp.example.com/other" }, masterKeyEnv("k")],
    ["another header template", "svc", { ...base, headers: { Authorization: "Bearer ${credential:other}" } }, masterKeyEnv("k")],
    ["no headers", "svc", { ...base, headers: undefined }, masterKeyEnv("k")],
    ["another master key", "svc", base, masterKeyEnv("k2")],
    ["the OS keychain instead of a master key", "svc", base, {}],
    ["certificate checks turned off", "svc", base, { ...masterKeyEnv("k"), NODE_TLS_REJECT_UNAUTHORIZED: "0" }],
    ["extra certificates", "svc", base, { ...masterKeyEnv("k"), NODE_EXTRA_CA_CERTS: "/etc/ca.pem" }],
    ["a proxy", "svc", base, { ...masterKeyEnv("k"), NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: "http://proxy:3128" }],
    ["the system's certificates", "svc", base, { ...masterKeyEnv("k"), NODE_USE_SYSTEM_CA: "1" }],
    ["a certificate file", "svc", base, { ...masterKeyEnv("k"), SSL_CERT_FILE: "/etc/ssl/cert.pem" }],
    ["_bridge.auth", "svc", http({ ...base, _bridge: { auth: { type: "oauth2" } } }), masterKeyEnv("k")],
  ])("differs for %s", (_label, name, config, env) => {
    expect(httpUpstreamKey(name, config as HttpServerConfig, env)).not.toBe(httpUpstreamKey("svc", base, masterKeyEnv("k")));
  });
});
