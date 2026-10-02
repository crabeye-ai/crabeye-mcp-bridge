import { describe, it, expect, afterEach, vi } from "vitest";
import { InMemoryTransport, Server } from "@modelcontextprotocol/server";
import {
  AuthorizationServerMismatchError,
  InsecureTokenEndpointError,
  IssuerMismatchError,
  OAuthError as SdkOAuthError,
  OAuthErrorCode,
  SdkErrorCode,
  SdkHttpError,
  SseError,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/client";
import { HttpUpstreamClient } from "../../src/upstream/http-client.js";
import { OAuthError as BridgeOAuthError, ReauthorizationRequiredError } from "../../src/oauth/errors.js";

type Outcome = "ok" | "refused" | "hang" | Error;

const BASE = 100;
const CAP = 1_600;
const CRASH_AFTER_MS = 10;

function failingTransport(error: Error): Transport {
  const transport: Transport = {
    async start() {
      throw error;
    },
    async send() {},
    async close() {
      transport.onclose?.();
    },
  };
  return transport;
}

function hangingTransport(release: Promise<void>): Transport {
  const transport: Transport = {
    async start() {
      await release;
      throw new Error("released");
    },
    async send() {},
    async close() {
      transport.onclose?.();
    },
  };
  return transport;
}

interface ServingOptions {
  gate?: Promise<void>;
  requestFailure?: (method: string) => Error | undefined;
  onClose?: () => void;
}

function servingTransport(options: ServingOptions = {}): Transport {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name: "upstream", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler("tools/list", () => ({ tools: [] }));
  server.setRequestHandler("tools/call", () => ({ content: [] }));
  void server.connect(serverSide);
  const start = clientSide.start.bind(clientSide);
  const send = clientSide.send.bind(clientSide);
  const close = clientSide.close.bind(clientSide);
  clientSide.start = async () => {
    await options.gate;
    await start();
  };
  clientSide.send = async (message: JSONRPCMessage, sendOptions) => {
    const failure = "method" in message ? options.requestFailure?.(message.method) : undefined;
    if (failure) throw failure;
    await send(message, sendOptions);
  };
  clientSide.close = async () => {
    options.onClose?.();
    await close();
  };
  return clientSide;
}

function scriptedClient(script: () => Outcome) {
  const attemptsAt: number[] = [];
  let open: Transport | undefined;
  let release: () => void = () => {};
  const client = new HttpUpstreamClient({
    name: "flaky",
    config: { type: "streamable-http", url: "http://localhost:9999" },
    reconnectBaseDelay: BASE,
    reconnectMaxDelay: CAP,
    _transportFactory: () => {
      attemptsAt.push(Date.now());
      const outcome = script();
      if (outcome === "ok") return (open = servingTransport());
      if (outcome === "hang") return hangingTransport(new Promise<void>((r) => (release = r)));
      return failingTransport(outcome === "refused" ? new Error("connection refused") : outcome);
    },
  });
  return {
    client,
    attemptsAt,
    dropConnection: () => open?.onclose?.(),
    releaseHangingAttempt: () => release(),
  };
}

function singleConnectionClient(options: ServingOptions) {
  return new HttpUpstreamClient({
    name: "flaky",
    config: { type: "streamable-http", url: "http://localhost:9999" },
    reconnectBaseDelay: BASE,
    _transportFactory: () => servingTransport(options),
  });
}

function gaps(times: number[]): number[] {
  return times.slice(1).map((t, i) => t - times[i]!);
}

describe("upstream reconnect policy", () => {
  let client: HttpUpstreamClient | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
    vi.useRealTimers();
  });

  it("retries an upstream that was down when the bridge started", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const scripted = scriptedClient(() => (++calls <= 3 ? "refused" : "ok"));
    client = scripted.client;

    await client.connect().catch(() => {});
    await vi.advanceTimersByTimeAsync(1_000);

    expect(client.status).toBe("connected");
    expect(scripted.attemptsAt).toHaveLength(4);
  });

  it("keeps backing off toward the cap instead of ever giving up", async () => {
    vi.useFakeTimers();
    const scripted = scriptedClient(() => "refused");
    client = scripted.client;

    await client.connect().catch(() => {});
    await vi.advanceTimersByTimeAsync(20_000);

    const delays = gaps(scripted.attemptsAt);
    expect(delays.slice(0, 5)).toEqual([100, 200, 400, 800, 1_600]);
    expect(delays.slice(5).every((d) => d === CAP)).toBe(true);
    expect(client.status).toBe("disconnected");
  });

  it("keeps backing off for an upstream that crashes right after connecting", async () => {
    vi.useFakeTimers();
    const scripted = scriptedClient(() => "ok");
    client = scripted.client;
    client.onStatusChange((event) => {
      if (event.current === "connected") setTimeout(() => scripted.dropConnection(), CRASH_AFTER_MS);
    });

    await client.connect();
    await vi.advanceTimersByTimeAsync(5_000);

    const delays = gaps(scripted.attemptsAt).map((d) => d - CRASH_AFTER_MS);
    expect(delays.slice(0, 4)).toEqual([100, 200, 400, 800]);
  });

  async function crashLoopThenRecover() {
    let calls = 0;
    const scripted = scriptedClient(() => ([1, 4].includes(++calls) ? "ok" : "refused"));
    client = scripted.client;
    let connectedAt = 0;
    client.onStatusChange((event) => {
      if (event.current === "connected") connectedAt = Date.now();
    });
    await client.connect();
    scripted.dropConnection();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.status).toBe("connected");
    return { scripted, connectedAt: () => connectedAt };
  }

  it.each([
    { uptime: 60_000, nextDelay: BASE },
    { uptime: 59_999, nextDelay: 8 * BASE },
  ])("a connection that stayed up $uptime ms is retried after $nextDelay ms when it drops", async ({ uptime, nextDelay }) => {
    vi.useFakeTimers();
    const { scripted, connectedAt } = await crashLoopThenRecover();

    await vi.advanceTimersByTimeAsync(connectedAt() + uptime - Date.now());
    scripted.dropConnection();
    const droppedAt = Date.now();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(scripted.attemptsAt.find((t) => t > droppedAt)! - droppedAt).toBe(nextDelay);
  });

  it.each([
    { uptime: 60_000, nextDelay: BASE },
    { uptime: 1_000, nextDelay: 8 * BASE },
  ])("reconnect() after a connection that stayed up $uptime ms retries after $nextDelay ms on failure", async ({ uptime, nextDelay }) => {
    vi.useFakeTimers();
    const { scripted, connectedAt } = await crashLoopThenRecover();
    await vi.advanceTimersByTimeAsync(connectedAt() + uptime - Date.now());

    await client!.reconnect().catch(() => {});
    const failedAt = Date.now();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(scripted.attemptsAt.find((t) => t > failedAt)! - failedAt).toBe(nextDelay);
  });

  it("reconnect() waits for an in-flight attempt before replacing it", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const scripted = scriptedClient(() => (++calls === 1 ? "refused" : calls === 2 ? "hang" : "ok"));
    client = scripted.client;
    await client.connect().catch(() => {});
    await vi.advanceTimersByTimeAsync(BASE);

    const reconnecting = client.reconnect();
    scripted.releaseHangingAttempt();
    await reconnecting;

    expect(client.status).toBe("connected");
    expect(scripted.attemptsAt).toHaveLength(3);
  });

  it("reconnect() on a closed client does nothing", async () => {
    vi.useFakeTimers();
    const scripted = scriptedClient(() => "ok");
    client = scripted.client;
    await client.connect();
    await client.close();

    await client.reconnect();

    expect(client.status).toBe("disconnected");
    expect(scripted.attemptsAt).toHaveLength(1);
  });

  it("reconnect() does not reconnect when closed while it shuts the old connection down", async () => {
    let releaseClose: () => void = () => {};
    const closeGate = new Promise<void>((r) => (releaseClose = r));
    let closing = false;
    let transports = 0;
    client = new HttpUpstreamClient({
      name: "flaky",
      config: { type: "streamable-http", url: "http://localhost:9999" },
      _transportFactory: () => {
        transports++;
        const transport = servingTransport();
        const close = transport.close.bind(transport);
        transport.close = async () => {
          closing = true;
          await closeGate;
          await close();
        };
        return transport;
      },
    });
    await client.connect();

    const reconnecting = client.reconnect();
    await vi.waitFor(() => expect(closing).toBe(true));
    const closingClient = client.close();
    releaseClose();
    await Promise.all([reconnecting, closingClient]);

    expect(client.status).toBe("disconnected");
    expect(transports).toBe(1);
  });

  it("reconnect() does not revive a client closed while it waited", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const scripted = scriptedClient(() => (++calls === 1 ? "refused" : calls === 2 ? "hang" : "ok"));
    client = scripted.client;
    await client.connect().catch(() => {});
    await vi.advanceTimersByTimeAsync(BASE);

    const reconnecting = client.reconnect();
    await client.close();
    scripted.releaseHangingAttempt();
    await reconnecting;

    expect(client.status).toBe("disconnected");
    expect(scripted.attemptsAt).toHaveLength(2);
  });

  it("retryNow connects immediately during a backoff without resetting it", async () => {
    vi.useFakeTimers();
    const scripted = scriptedClient(() => "refused");
    client = scripted.client;

    await client.connect().catch(() => {});
    await vi.advanceTimersByTimeAsync(600);
    expect(scripted.attemptsAt).toHaveLength(3);

    await client.retryNow();
    expect(scripted.attemptsAt).toHaveLength(4);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(gaps(scripted.attemptsAt)[3]).toBe(8 * BASE);
  });

  it("retryNow within the base delay of the last attempt waits for the scheduled retry instead", async () => {
    vi.useFakeTimers();
    const scripted = scriptedClient(() => "refused");
    client = scripted.client;
    await client.connect().catch(() => {});

    await vi.advanceTimersByTimeAsync(BASE - 1);
    await client.retryNow();
    expect(scripted.attemptsAt).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(scripted.attemptsAt).toHaveLength(2);
  });

  it("retryNow does nothing on a closed client", async () => {
    vi.useFakeTimers();
    const scripted = scriptedClient(() => "refused");
    client = scripted.client;
    await client.connect().catch(() => {});
    await client.close();
    await vi.advanceTimersByTimeAsync(10 * BASE);

    await client.retryNow();

    expect(scripted.attemptsAt).toHaveLength(1);
    expect(client.status).toBe("disconnected");
  });

  it("concurrent retryNow calls share one connection attempt", async () => {
    vi.useFakeTimers();
    const scripted = scriptedClient(() => "refused");
    client = scripted.client;
    await client.connect().catch(() => {});
    await vi.advanceTimersByTimeAsync(2 * BASE);

    await Promise.all([client.retryNow(), client.retryNow(), client.retryNow()]);

    expect(scripted.attemptsAt).toHaveLength(3);
  });

  it("retryNow during a scheduled attempt joins it rather than starting another", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const scripted = scriptedClient(() => (++calls === 1 ? "refused" : "hang"));
    client = scripted.client;
    await client.connect().catch(() => {});
    await vi.advanceTimersByTimeAsync(BASE);
    expect(scripted.attemptsAt).toHaveLength(2);

    const joined = client.retryNow();
    scripted.releaseHangingAttempt();
    await joined;

    expect(scripted.attemptsAt).toHaveLength(2);
  });

  it.each([
    ["the bridge's re-authorization error", new ReauthorizationRequiredError("Run: crabeye-mcp-bridge auth flaky")],
    ["the SDK's unauthorized error", new UnauthorizedError("Authentication failed")],
    ["an HTTP 401 from the upstream", new SdkHttpError(SdkErrorCode.ClientHttpAuthentication, "HTTP 401", { status: 401 })],
    ["a wrapped auth error", new Error("probe failed", { cause: new UnauthorizedError("nope") })],
    ["a doubly wrapped auth error", new Error("outer", { cause: new Error("inner", { cause: new UnauthorizedError("nope") }) })],
    ["the bridge's issuer-mismatch refusal", new BridgeOAuthError("issuer_mismatch", "authorization server changed")],
    ["the SDK's issuer mismatch", new IssuerMismatchError("metadata", "https://a.example", "https://b.example")],
    ["a permanent OAuth error", new SdkOAuthError(OAuthErrorCode.InvalidScope, "scope not allowed")],
    ["the SDK's authorization-server mismatch", new AuthorizationServerMismatchError("https://a.example", "https://b.example")],
    ["an insecure token endpoint", new InsecureTokenEndpointError("http://as.example/token")],
    ["an HTTP 401 reported under another SDK code", new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, "Error POSTing", { status: 401 })],
    ["an SSE 401", new SseError(401, "Non-200 status code (401)", new Event("error") as never)],
  ])("pauses without background retries on %s, and resumes on retryNow", async (_label, authError) => {
    vi.useFakeTimers();
    let authorized = false;
    const scripted = scriptedClient(() => (authorized ? "ok" : authError));
    client = scripted.client;

    await client.connect().catch(() => {});
    expect(client.status).toBe("auth_required");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scripted.attemptsAt).toHaveLength(1);

    await client.retryNow();
    expect(client.status).toBe("auth_required");
    expect(scripted.attemptsAt).toHaveLength(2);

    authorized = true;
    await vi.advanceTimersByTimeAsync(BASE);
    await client.retryNow();
    expect(client.status).toBe("connected");
  });

  const selfCaused = new Error("loops");
  (selfCaused as { cause?: unknown }).cause = selfCaused;

  it.each([
    ["an HTTP 403", new SdkHttpError(SdkErrorCode.ClientHttpForbidden, "HTTP 403", { status: 403 })],
    ["a temporary OAuth server error", new SdkOAuthError(OAuthErrorCode.ServerError, "try later")],
    ["a temporarily unavailable OAuth server", new SdkOAuthError(OAuthErrorCode.TemporarilyUnavailable, "busy")],
    ["an SSE 503", new SseError(503, "Non-200 status code (503)", new Event("error") as never)],
    ["an error whose cause refers to itself", selfCaused],
  ])("keeps retrying in the background on %s", async (_label, error) => {
    vi.useFakeTimers();
    const scripted = scriptedClient(() => error);
    client = scripted.client;

    await client.connect().catch(() => {});
    await vi.advanceTimersByTimeAsync(BASE);

    expect(client.status).toBe("disconnected");
    expect(scripted.attemptsAt).toHaveLength(2);
  });

  it.each([
    ["tool call", "tools/call", (c: HttpUpstreamClient) => c.callTool({ name: "anything" })],
    ["health ping", "ping", (c: HttpUpstreamClient) => c.ping()],
  ])("pauses a connected upstream whose %s fails authorization, closing its connection", async (_label, method, request) => {
    let expired = false;
    let closed = 0;
    client = singleConnectionClient({
      requestFailure: (m) => (expired && m === method ? new UnauthorizedError("token expired") : undefined),
      onClose: () => closed++,
    });
    await client.connect();
    expired = true;

    await expect(request(client)).rejects.toThrow("token expired");

    expect(client.status).toBe("auth_required");
    await vi.waitFor(() => expect(closed).toBeGreaterThan(0));
  });

  it.each([
    ["tool call", "tools/call", (c: HttpUpstreamClient) => c.callTool({ name: "anything" })],
    ["health ping", "ping", (c: HttpUpstreamClient) => c.ping()],
  ])("stays connected when a %s fails for another reason", async (_label, method, request) => {
    let failing = false;
    client = singleConnectionClient({
      requestFailure: (m) => (failing && m === method ? new Error("socket hiccup") : undefined),
    });
    await client.connect();
    failing = true;

    await expect(request(client)).rejects.toThrow("socket hiccup");

    expect(client.status).toBe("connected");
  });

  it.each([
    { window: "before the transport opens", transportsOpened: 0 },
    { window: "while the handshake is in flight", transportsOpened: 1 },
  ])("close $window leaves nothing connected or scheduled", async ({ transportsOpened }) => {
    let openGate: () => void = () => {};
    const gate = new Promise<void>((r) => (openGate = r));
    let attempts = 0;
    client = new HttpUpstreamClient({
      name: "flaky",
      config: { type: "streamable-http", url: "http://localhost:9999" },
      reconnectBaseDelay: BASE,
      _transportFactory: () => {
        attempts++;
        return servingTransport({ gate });
      },
    });
    const statuses: string[] = [];
    client.onStatusChange((event) => statuses.push(event.current));

    const attempt = client.connect().catch(() => {});
    if (transportsOpened > 0) await vi.waitFor(() => expect(attempts).toBe(1));
    await client.close();
    openGate();
    await attempt;
    await new Promise((r) => setTimeout(r, 3 * BASE));

    expect(client.status).toBe("disconnected");
    expect(statuses).not.toContain("connected");
    expect(attempts).toBe(transportsOpened);
  });

  it("close cancels pending retries", async () => {
    vi.useFakeTimers();
    const scripted = scriptedClient(() => "refused");
    client = scripted.client;
    await client.connect().catch(() => {});

    await client.close();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(scripted.attemptsAt).toHaveLength(1);
  });
});
