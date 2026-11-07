import { describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describeError } from "../../src/logging/index.js";
import { HttpUpstreamClient } from "../../src/upstream/http-client.js";

async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function connectFailure(url: string): Promise<unknown> {
  const client = new HttpUpstreamClient({ name: "svc", config: { type: "streamable-http", url }, reconnectBaseDelay: 60_000 });
  try {
    await client.connect();
    return undefined;
  } catch (err) {
    return err;
  } finally {
    await client.close();
  }
}

describe("describeError", () => {
  it("is the message alone for an error without a cause", () => {
    expect(describeError(new Error("broken"))).toBe("broken");
    expect(describeError("plain text")).toBe("plain text");
  });

  it("adds the causes the message doesn't already include", () => {
    const network = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
    const fetchFailed = new TypeError("fetch failed", { cause: network });
    const probe = new Error("Version negotiation probe failed: fetch failed", { cause: fetchFailed });

    expect(describeError(probe)).toBe("Version negotiation probe failed: fetch failed (connect ECONNREFUSED 127.0.0.1:1)");
  });

  it("stops after a few causes, and on a cause that refers back to an earlier one", () => {
    const loop = new Error("a");
    loop.cause = new Error("b", { cause: loop });
    expect(describeError(loop)).toBe("a (b)");

    let deep: Error = new Error("cause 9");
    for (let n = 8; n >= 0; n--) deep = new Error(`cause ${n}`, { cause: deep });
    expect(describeError(deep)).toBe("cause 0 (cause 1: cause 2: cause 3: cause 4)");
  });

  it("names a cause without a message by its code", () => {
    const refused = Object.assign(new AggregateError([], ""), { code: "ECONNREFUSED" });

    expect(describeError(new TypeError("fetch failed", { cause: refused }))).toBe("fetch failed (ECONNREFUSED)");
  });

  it.each([
    ["a refused connection to an address", async () => `http://127.0.0.1:${await closedPort()}/mcp`, /ECONNREFUSED/],
    ["a refused connection to localhost", async () => `http://localhost:${await closedPort()}/mcp`, /ECONNREFUSED/],
    ["a host name that doesn't resolve", async () => "http://no-such-host.invalid/mcp", /ENOTFOUND|EAI_AGAIN/],
  ])("names the network error for %s", async (_case, url, code) => {
    const err = await connectFailure(await url());

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toMatch(code);
    expect(describeError(err)).toMatch(code);
  });
});
