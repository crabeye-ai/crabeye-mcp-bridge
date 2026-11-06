import { describe, expect, it } from "vitest";
import { listedStatus, providerStatus, renderServerList, withoutCredentials } from "../../src/server/server-list.js";

describe("renderServerList", () => {
  it("lists every server in order, with its category, and the status of each that isn't connected", () => {
    expect(
      renderServerList([
        { name: "linear", status: "connected", category: "issues" },
        { name: "github", status: "connecting" },
        { name: "notion", status: "auth_required", category: "docs" },
        { name: "jira", status: "disconnected" },
      ]),
    ).toBe(
      [
        "Servers (search by provider name):",
        "- linear [issues]",
        "- github: starting",
        "- notion [docs]: needs authorization; the user runs: crabeye-mcp-bridge auth notion, or updates its credentials if it doesn't use OAuth",
        "- jira: not connected",
      ].join("\n"),
    );
  });

  it("is empty when there are no servers", () => {
    expect(renderServerList([])).toBe("");
  });

  it("escapes control, invisible and direction-changing characters in names and categories", () => {
    expect(renderServerList([{ name: "evil\n- linear", status: "auth_required", category: "a\u202eb" }])).toBe(
      "Servers (search by provider name):\n- evil\\n- linear [a\\u202eb]: needs authorization; the user runs: crabeye-mcp-bridge auth 'evil\\n- linear', or updates its credentials if it doesn't use OAuth",
    );
  });
});

describe("listedStatus", () => {
  it.each([
    ["connected", undefined, "connected"],
    ["auth_required", "denied", "auth_required"],
    ["connecting", undefined, "connecting"],
    ["connecting", "connect ECONNREFUSED", "disconnected"],
    ["disconnected", "connect ECONNREFUSED", "disconnected"],
    ["disconnected", undefined, "connecting"],
  ] as const)("shows %s with error %s as %s", (status, error, shown) => {
    expect(listedStatus(status, error)).toBe(shown);
  });
});

describe("providerStatus", () => {
  it.each([
    ["starting", "connecting", undefined, false, '"linear" is starting; search again shortly.'],
    ["reconnecting", "connecting", undefined, true, '"linear" is reconnecting; a call to its tools waits for it to be back.'],
    ["not connected", "disconnected", "connect ECONNREFUSED", false, '"linear" is not connected: connect ECONNREFUSED'],
    ["not connected, with no error", "disconnected", undefined, false, '"linear" is not connected.'],
    [
      "needing authorization",
      "auth_required",
      undefined,
      false,
      'Upstream server "linear" needs re-authorization. Run: crabeye-mcp-bridge auth linear (or update its configured credentials if it does not use OAuth).',
    ],
  ] as const)("says a server is %s", (_name, status, error, hasTools, message) => {
    expect(providerStatus("linear", status, error, hasTools).message).toBe(message);
  });

  it("names the status a search shows", () => {
    expect((["connecting", "disconnected", "auth_required"] as const).map((status) => providerStatus("a", status, undefined, false).status)).toEqual([
      "starting",
      "not_connected",
      "needs_authorization",
    ]);
  });

  it("escapes the name and the error", () => {
    expect(providerStatus("li\u202enear", "disconnected", "bad\x1b[31m", false).message).toBe('"li\\u202enear" is not connected: bad\\x1b[31m');
  });
});

describe("withoutCredentials", () => {
  it.each([
    ["an authorization header", "rejected Authorization: Bearer abc.def.ghi, retrying", "rejected Authorization: [redacted], retrying"],
    ["a bearer token", "sent bearer eyJhbGciOiJIUzI1NiJ9.x", "sent bearer [redacted]"],
    ["a URL's user and password", "GET https://user:hunter2@host/mcp failed", "GET https://[redacted]@host/mcp failed"],
    ["a URL's user alone", "clone https://ghp_abcdef@github.com/x", "clone https://[redacted]@github.com/x"],
    ["query parameters", "https://host/mcp?api_key=k123&access_token=t9&x=1", "https://host/mcp?api_key=[redacted]&access_token=[redacted]&x=1"],
    ["environment-style names", "GITHUB_TOKEN=ghp_x MY_SECRET=s X_API_KEY=k", "GITHUB_TOKEN=[redacted] MY_SECRET=[redacted] X_API_KEY=[redacted]"],
    ["token and key headers, each to the end of its line", "X-Auth-Token: abc123 sent\nx-goog-api-key: AIza9", "X-Auth-Token: [redacted]\nx-goog-api-key: [redacted]"],
    ["a proxy authorization header", "Proxy-Authorization: Basic dXNlcjpwYXNzd29yZA==", "Proxy-Authorization: [redacted]"],
    ["every cookie in a cookie header", "Cookie: sid=abc; csrftoken=xyz", "Cookie: [redacted]"],
    ["a basic credential", "tried basic dXNlcjE6cGFzczE= first", "tried basic [redacted] first"],
    ["a long bearer token of letters alone", "sent Bearer abcdefghijklmnopqrst", "sent Bearer [redacted]"],
    ["a set-cookie header", "Set-Cookie: sid=abc; Path=/", "Set-Cookie: [redacted]"],
    ["quoted JSON values, spaces and all", '{"client_secret": "s3 cr3t", "password":"pw"}', '{"client_secret": [redacted], "password":[redacted]}'],
  ])("replaces %s", (_name, text, shown) => {
    expect(withoutCredentials(text)).toBe(shown);
  });

  it.each([
    "server only supports basic authentication.",
    "Bearer token-based auth failed (HTTP 401)",
    "Invalid token: signature mismatch",
    "too many tokens requested",
    "subtoken=5 and keytoken=6",
    "connect ECONNREFUSED 127.0.0.1:8080",
  ])("leaves ordinary text alone: %s", (text) => {
    expect(withoutCredentials(text)).toBe(text);
  });

  it("takes time in proportion to the text, even on text built to make it backtrack", () => {
    const started = performance.now();

    for (const text of ["a-".repeat(100_000), "bearer ".repeat(30_000), 'token="'.repeat(30_000), "//".repeat(100_000)]) withoutCredentials(text);

    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
