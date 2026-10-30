import { describe, expect, it } from "vitest";
import {
  parseAttachParams,
  parseCallToolParams,
  parseCancelToolParams,
  parseRetryParams,
} from "../../../src/daemon/instances/params.js";

const attach = {
  bridgeProtocolVersion: 3,
  source: { kind: "file", path: "/home/u/bridge.json" },
  env: { MCP_BRIDGE_MASTER_KEY: "k", NOTION_OAUTH_SECRET: "s" },
};

describe("parseAttachParams", () => {
  it("accepts a config source and the instance variables", () => {
    expect(parseAttachParams(attach)).toEqual(attach);
  });

  it("accepts the merged default with no variables", () => {
    const merged = { ...attach, source: { kind: "merged", path: "/home/u/.crabeye-mcp-bridge/config.json" }, env: {} };
    expect(parseAttachParams(merged)).toEqual(merged);
  });

  it.each([
    ["no params", undefined],
    ["an array", []],
    ["a missing protocol version", { ...attach, bridgeProtocolVersion: undefined }],
    ["a fractional protocol version", { ...attach, bridgeProtocolVersion: 2.5 }],
    ["an unknown source kind", { ...attach, source: { kind: "url", path: "/x" } }],
    ["a relative path", { ...attach, source: { kind: "file", path: "bridge.json" } }],
    ["an empty path", { ...attach, source: { kind: "file", path: "" } }],
    ["a NUL in the path", { ...attach, source: { kind: "file", path: "/home/u/a\0b.json" } }],
    ["a path over 4096 bytes", { ...attach, source: { kind: "file", path: `/${"a".repeat(4096)}` } }],
    ["an env that isn't an object", { ...attach, env: ["MCP_BRIDGE_MASTER_KEY"] }],
    ["a variable outside the allowlist", { ...attach, env: { HOME: "/home/u" } }],
    ["a prototype key", { ...attach, env: JSON.parse('{"__proto__": "x"}') }],
    ["a non-string value", { ...attach, env: { MCP_BRIDGE_MASTER_KEY: 1 } }],
    ["a NUL in a value", { ...attach, env: { MCP_BRIDGE_MASTER_KEY: "a\0b" } }],
    ["a relative certificate file", { ...attach, env: { NODE_EXTRA_CA_CERTS: "certs/ca.pem" } }],
    ["a value over 64 KiB", { ...attach, env: { MCP_BRIDGE_MASTER_KEY: "a".repeat(65_537) } }],
    ["more than 64 variables", { ...attach, env: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`V${i}_OAUTH`, "x"])) }],
  ])("refuses %s", (_label, params) => {
    expect(parseAttachParams(params)).toBeNull();
  });
});

describe("parseCallToolParams", () => {
  const call = { callId: "c1", upstream: "svc", name: "search", arguments: { q: "x" } };

  it("accepts a call with and without arguments", () => {
    expect(parseCallToolParams(call)).toEqual(call);
    expect(parseCallToolParams({ ...call, arguments: undefined })).toEqual({ callId: "c1", upstream: "svc", name: "search" });
  });

  it.each([
    ["no callId", { ...call, callId: undefined }],
    ["an empty callId", { ...call, callId: "" }],
    ["a callId over 64 bytes", { ...call, callId: "c".repeat(65) }],
    ["no upstream", { ...call, upstream: undefined }],
    ["an upstream name over 256 bytes", { ...call, upstream: "u".repeat(257) }],
    ["no tool name", { ...call, name: undefined }],
    ["arguments that are an array", { ...call, arguments: [1] }],
    ["arguments that are a string", { ...call, arguments: "x" }],
  ])("refuses %s", (_label, params) => {
    expect(parseCallToolParams(params)).toBeNull();
  });
});

describe("parseRetryParams and parseCancelToolParams", () => {
  it("accept their one field", () => {
    expect(parseRetryParams({ upstream: "svc" })).toEqual({ upstream: "svc" });
    expect(parseCancelToolParams({ callId: "c1" })).toEqual({ callId: "c1" });
  });

  it("refuse anything else", () => {
    expect(parseRetryParams({ upstream: "" })).toBeNull();
    expect(parseRetryParams(undefined)).toBeNull();
    expect(parseCancelToolParams({ callId: 1 })).toBeNull();
    expect(parseCancelToolParams(null)).toBeNull();
  });
});
