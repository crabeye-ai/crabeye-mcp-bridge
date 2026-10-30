import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthorizedError } from "@modelcontextprotocol/client";
import { HttpUpstreamClient } from "../../src/upstream/http-client.js";
import { ConnectionSupersededError } from "../../src/upstream/types.js";
import { hangingTransport, servingTransport } from "../_helpers/upstream-transports.js";

describe("reconnect() replacing a connect in flight", () => {
  let client: HttpUpstreamClient | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  function clientWithHeldFirstAttempt(error: Error): { client: HttpUpstreamClient; release: () => void; attempts: () => number } {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let attempts = 0;
    client = new HttpUpstreamClient({
      name: "flaky",
      config: { type: "streamable-http", url: "http://localhost:9999" },
      reconnectBaseDelay: 100,
      _transportFactory: () => (++attempts > 1 ? servingTransport() : hangingTransport(gate, error)),
    });
    return { client, release, attempts: () => attempts };
  }

  it("doesn't report the attempt it replaced as paused when that attempt then fails for authorization", async () => {
    const held = clientWithHeldFirstAttempt(new UnauthorizedError("Server returned 401 after re-authentication"));
    const statuses: string[] = [];
    held.client.onStatusChange((event) => statuses.push(event.current));
    void held.client.connect().catch(() => {});
    await vi.waitFor(() => expect(held.attempts()).toBe(1));

    const reconnecting = held.client.reconnect();
    held.release();
    await reconnecting;

    expect(held.client.status).toBe("connected");
    expect(statuses).not.toContain("auth_required");
    expect(held.attempts()).toBe(2);
  });

  it("fails the attempt it replaced as superseded for whoever awaits it, whatever that attempt's own error", async () => {
    const held = clientWithHeldFirstAttempt(new UnauthorizedError("Server returned 401 after re-authentication"));
    const first = held.client.connect();
    await vi.waitFor(() => expect(held.attempts()).toBe(1));

    const reconnecting = held.client.reconnect();
    held.release();

    await expect(first).rejects.toThrow(ConnectionSupersededError);
    await reconnecting;
  });

  it("shares the attempt that replaces it among concurrent calls", async () => {
    const held = clientWithHeldFirstAttempt(new Error("connection refused"));
    void held.client.connect().catch(() => {});
    await vi.waitFor(() => expect(held.attempts()).toBe(1));

    const reconnecting = [held.client.reconnect(), held.client.reconnect()];
    held.release();
    await Promise.all(reconnecting);

    expect(held.client.status).toBe("connected");
    expect(held.attempts()).toBe(2);
  });
});
