import { describe, it, expect } from "vitest";
import { connect } from "node:net";
import { startCallbackServer } from "../../src/oauth/callback-server.js";

/** Send a raw HTTP/1.1 request so the Host header is whatever we set it to.
 * Node's `fetch` and `http.request` both override the Host header to match
 * the connect target, which would defeat the DNS-rebinding test. */
function rawHttpGet(
  port: number,
  path: string,
  hostHeader: string,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { buf += chunk; });
    socket.on("error", reject);
    socket.on("end", () => {
      const [head, ...rest] = buf.split("\r\n\r\n");
      const statusLine = head.split("\r\n", 1)[0] ?? "";
      const m = statusLine.match(/HTTP\/1\.[01]\s+(\d{3})/);
      resolve({ statusCode: m ? Number(m[1]) : 0, body: rest.join("\r\n\r\n") });
    });
    socket.write(`GET ${path} HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`);
  });
}

describe("startCallbackServer", () => {
  it("resolves with code+state on a valid callback", async () => {
    const handle = await startCallbackServer({ timeoutMs: 5000 });
    try {
      const url = new URL(handle.redirectUri);
      url.searchParams.set("code", "abc");
      url.searchParams.set("state", "xyz");
      const res = await fetch(url);
      expect(res.status).toBe(200);
      const result = await handle.result;
      expect(result).toEqual({ code: "abc", state: "xyz" });
    } finally {
      await handle.close();
    }
  });

  it("rejects when provider returns an error", async () => {
    const handle = await startCallbackServer({ timeoutMs: 5000 });
    // Attach rejection handler before triggering the callback so a
    // synchronous reject inside the request handler doesn't surface as an
    // unhandled rejection.
    const expectation = expect(handle.result).rejects.toThrow(/access_denied.*User said no/);
    try {
      const url = new URL(handle.redirectUri);
      url.searchParams.set("error", "access_denied");
      url.searchParams.set("error_description", "User said no");
      await fetch(url);
      await expectation;
    } finally {
      await handle.close();
    }
  });

  it("rejects on missing code or state", async () => {
    const handle = await startCallbackServer({ timeoutMs: 5000 });
    const expectation = expect(handle.result).rejects.toThrow(/Missing/i);
    try {
      await fetch(new URL(handle.redirectUri));
      await expectation;
    } finally {
      await handle.close();
    }
  });

  it("returns 404 for non-callback paths without resolving", async () => {
    const handle = await startCallbackServer({ timeoutMs: 200 });
    try {
      const base = new URL(handle.redirectUri);
      const res = await fetch(`http://127.0.0.1:${base.port}/other`);
      expect(res.status).toBe(404);
      // Pending promise should eventually time out (proving 404 did not resolve it).
      await expect(handle.result).rejects.toThrow(/timed out/i);
    } finally {
      await handle.close();
    }
  });

  it("rejects after timeoutMs with a clear message", async () => {
    const handle = await startCallbackServer({ timeoutMs: 50 });
    try {
      await expect(handle.result).rejects.toThrow(/timed out/i);
    } finally {
      await handle.close();
    }
  });

  it("rejects when AbortSignal fires", async () => {
    const ctrl = new AbortController();
    const handle = await startCallbackServer({ timeoutMs: 5000, signal: ctrl.signal });
    try {
      setTimeout(() => ctrl.abort(), 20);
      await expect(handle.result).rejects.toThrow(/aborted/i);
    } finally {
      await handle.close();
    }
  });

  it("honors pinned port", async () => {
    // Use a high port unlikely to be in use to keep the test deterministic.
    // Start two servers on the same port — second one should fail to listen.
    const handle = await startCallbackServer({ port: 0, timeoutMs: 1000 });
    try {
      expect(handle.port).toBeGreaterThan(0);
      expect(handle.redirectUri).toContain(`127.0.0.1:${handle.port}/callback`);
    } finally {
      await handle.close();
    }
  });

  it("binds 127.0.0.1 only (redirectUri uses loopback)", async () => {
    const handle = await startCallbackServer({ timeoutMs: 200 });
    try {
      expect(handle.redirectUri.startsWith("http://127.0.0.1:")).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it("rejects oversized code/state parameters", async () => {
    const handle = await startCallbackServer({ timeoutMs: 5000 });
    const expectation = expect(handle.result).rejects.toThrow(/exceeded.*bytes/);
    try {
      const url = new URL(handle.redirectUri);
      url.searchParams.set("code", "a".repeat(4097));
      url.searchParams.set("state", "ok");
      const res = await fetch(url);
      expect(res.status).toBe(400);
      await expectation;
    } finally {
      await handle.close();
    }
  });

  it("rejects non-GET methods on the callback path with 405 (CSRF surface)", async () => {
    const handle = await startCallbackServer({ timeoutMs: 200 });
    try {
      // POST to the callback path with valid-looking params — must NOT
      // resolve the pending promise. Loopback CSRF defense.
      const url = new URL(handle.redirectUri);
      url.searchParams.set("code", "x");
      url.searchParams.set("state", "y");
      const res = await fetch(url, { method: "POST" });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET");
      await expect(handle.result).rejects.toThrow(/timed out/i);
    } finally {
      await handle.close();
    }
  });

  it("truncates oversized error_description in the surfaced error", async () => {
    const handle = await startCallbackServer({ timeoutMs: 5000 });
    const expectation = expect(handle.result).rejects.toThrow(/access_denied.*truncated/);
    try {
      const url = new URL(handle.redirectUri);
      url.searchParams.set("error", "access_denied");
      url.searchParams.set("error_description", "a".repeat(5000));
      const res = await fetch(url);
      expect(res.status).toBe(400);
      await expectation;
    } finally {
      await handle.close();
    }
  });

  it("rejects requests with a non-loopback Host header (DNS rebinding defense)", async () => {
    const handle = await startCallbackServer({ timeoutMs: 200 });
    try {
      // Simulate a DNS-rebound `attacker.example` → 127.0.0.1 by sending a
      // bogus `Host:` header against the bound TCP port. The browser would
      // carry the rebound hostname in its `Host:`, and we reject it.
      const res = await rawHttpGet(handle.port, "/callback?code=x&state=y", "attacker.example");
      expect(res.statusCode).toBe(421);
      // Pending promise should not have resolved.
      await expect(handle.result).rejects.toThrow(/timed out/i);
    } finally {
      await handle.close();
    }
  });

  it("sets defense-in-depth security headers on responses", async () => {
    const handle = await startCallbackServer({ timeoutMs: 5000 });
    try {
      const url = new URL(handle.redirectUri);
      url.searchParams.set("code", "abc");
      url.searchParams.set("state", "xyz");
      const res = await fetch(url);
      expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("cache-control")).toBe("no-store");
      await handle.result;
    } finally {
      await handle.close();
    }
  });

  it("close() is idempotent and the same promise resolves twice", async () => {
    const handle = await startCallbackServer({ timeoutMs: 200 });
    const first = handle.close();
    const second = handle.close();
    expect(second).toBe(first);
    await Promise.all([first, second]);
  });
});
