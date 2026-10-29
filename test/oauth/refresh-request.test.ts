import { describe, expect, it } from "vitest";
import { refreshRequestOf } from "../../src/oauth/refresh-request.js";

const refreshBody = () => new URLSearchParams({ grant_type: "refresh_token", refresh_token: "rt-1", client_id: "c" });

describe("refresh token requests", () => {
  it("recognises a form-encoded refresh request and reads its refresh token", () => {
    expect(refreshRequestOf({ method: "POST", body: refreshBody() })).toEqual({ refreshToken: "rt-1" });
  });

  it("matches the method whatever its case", () => {
    expect(refreshRequestOf({ method: "post", body: refreshBody() })).toEqual({ refreshToken: "rt-1" });
  });

  it("decodes an encoded refresh token", () => {
    const body = new URLSearchParams("grant_type=refresh_token&refresh_token=a%2Bb%2Fc%3D");
    expect(refreshRequestOf({ method: "POST", body })).toEqual({ refreshToken: "a+b/c=" });
  });

  it("reports no refresh token when a refresh request doesn't carry one", () => {
    expect(refreshRequestOf({ method: "POST", body: new URLSearchParams({ grant_type: "refresh_token" }) })).toEqual({
      refreshToken: undefined,
    });
  });

  it("ignores other grants, other methods and missing bodies", () => {
    expect(refreshRequestOf({ method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", refresh_token: "rt-1" }) })).toBeUndefined();
    expect(refreshRequestOf({ method: "GET", body: refreshBody() })).toBeUndefined();
    expect(refreshRequestOf({ method: "POST" })).toBeUndefined();
    expect(refreshRequestOf(undefined)).toBeUndefined();
  });

  it("never takes a string body for a refresh, even an MCP request whose arguments look like one", () => {
    const toolCall = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { arguments: { q: "&grant_type=refresh_token&refresh_token=X&" } } });
    expect(refreshRequestOf({ method: "POST", body: toolCall })).toBeUndefined();
    expect(refreshRequestOf({ method: "POST", body: "grant_type=refresh_token&refresh_token=rt-1" })).toBeUndefined();
  });
});
