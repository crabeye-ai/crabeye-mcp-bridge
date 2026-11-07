import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, type ProtocolEra } from "@modelcontextprotocol/client";
import { HttpUpstreamClient } from "../../src/upstream/http-client.js";
import type { StatusChangeEvent } from "../../src/upstream/types.js";
import { ECHOED, startCountingUpstream, type CountingUpstream } from "../_helpers/counting-http-upstream.js";
import { spyLogger } from "../_helpers/spy-logger.js";

type Intercept = (method: string | undefined, sessionId: string | null, send: () => Promise<Response>) => Response | Promise<Response> | undefined;

interface HeldRequest {
  arrived(): boolean;
  /** Answers the held request with `response`, or sends it on to the server. */
  release(response?: Response): void;
}

const endedSession = () => new Response("session not found", { status: 404 });
const nextMacrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

class TestClient extends HttpUpstreamClient {
  failNextConnect = false;

  protected override async _prepareConnect(): Promise<void> {
    if (!this.failNextConnect) return super._prepareConnect();
    this.failNextConnect = false;
    throw new Error("credentials unavailable");
  }
}

function methodOf(init: RequestInit | undefined): string | undefined {
  try {
    return (JSON.parse(String(init?.body)) as { method?: string }).method;
  } catch {
    return undefined;
  }
}

describe("an HTTP upstream's ended session", () => {
  let server: CountingUpstream | undefined;
  let client: TestClient | undefined;
  let intercept: Intercept = () => undefined;

  afterEach(async () => {
    intercept = () => undefined;
    vi.restoreAllMocks();
    await (client?.close() ?? Promise.resolve()).finally(() => server?.close());
    client = undefined;
    server = undefined;
  });

  async function connect(era: ProtocolEra = "legacy"): Promise<{ server: CountingUpstream; client: TestClient }> {
    server = await startCountingUpstream({ era });
    client = new TestClient({
      name: "svc",
      config: { type: "streamable-http", url: server.url },
      logger: spyLogger(),
      reconnectBaseDelay: 50,
      fetch: async (input, init) => {
        const send = () => fetch(input, init);
        return (await intercept(methodOf(init), new Headers(init?.headers).get("mcp-session-id"), send)) ?? send();
      },
    });
    await client.connect();
    return { server, client };
  }

  function holdNext(method: string): HeldRequest {
    let release: (response?: Response) => void = () => {};
    let arrived = false;
    const previous = intercept;
    intercept = (sent, sessionId, send) => {
      if (sent !== method || arrived) return previous(sent, sessionId, send);
      arrived = true;
      return new Promise<Response | undefined>((resolve) => (release = resolve)).then((response) => response ?? send());
    };
    return { arrived: () => arrived, release: (response) => release(response) };
  }

  const call = (name = "echo", signal?: AbortSignal) => client!.callTool({ name }, { signal }).then((result) => result.content);
  const closes = () => vi.spyOn(Client.prototype, "close");

  async function startSlowCall(server: CountingUpstream): Promise<{ slow: Promise<unknown>; stop: AbortController }> {
    const stop = new AbortController();
    const slow = call("slow", stop.signal);
    await vi.waitFor(() => expect(server.count("tools/call")).toBe(1));
    return { slow, stop };
  }

  it("sends the next call again on a new session, and closes the ended one", async () => {
    const { server, client } = await connect();
    const statuses: StatusChangeEvent[] = [];
    client.onStatusChange((event) => statuses.push(event));
    const closed = closes();

    await server.endSessions();

    expect(await call()).toEqual(ECHOED);
    expect(server.sessions()).toBe(2);
    expect(server.count("initialize")).toBe(2);
    expect(statuses.filter((event) => event.error !== undefined)).toEqual([]);
    expect(client.status).toBe("connected");
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("starts one new session for calls that find the session ended at once", async () => {
    const { server } = await connect();

    await server.endSessions();

    expect(await Promise.all([call(), call(), call()])).toEqual([ECHOED, ECHOED, ECHOED]);
    expect(server.count("initialize")).toBe(2);
  });

  it.each([
    ["while the new session starts", true],
    ["after the new session started", false],
  ])("sends a call that finds the session ended %s on that same new session", async (_case, duringRenewal) => {
    const { server } = await connect();
    await server.endSessions();
    const late = holdNext("tools/call");
    const lateCall = call();
    await vi.waitFor(() => expect(late.arrived()).toBe(true));
    const newSession = duringRenewal ? holdNext("initialize") : undefined;

    const firstCall = call();
    if (newSession) {
      await vi.waitFor(() => expect(newSession.arrived()).toBe(true));
      late.release(endedSession());
      await nextMacrotask();
      newSession.release();
    } else {
      await firstCall;
      late.release(endedSession());
    }

    expect(await Promise.all([firstCall, lateCall])).toEqual([ECHOED, ECHOED]);
    expect(server.count("initialize")).toBe(2);
  });

  it("sends a call that finds an older session ended on the newest one, without starting another", async () => {
    const { server } = await connect();
    await server.endSessions();
    const late = holdNext("tools/call");
    const lateCall = call();
    await vi.waitFor(() => expect(late.arrived()).toBe(true));
    expect(await call()).toEqual(ECHOED);
    await server.endSessions();
    expect(await call()).toEqual(ECHOED);

    late.release(endedSession());

    expect(await lateCall).toEqual(ECHOED);
    expect(server.count("initialize")).toBe(3);
  });

  it("sends a call that finds an older session ended while a newer one is replaced on the session that replaces it", async () => {
    const { server } = await connect();
    await server.endSessions();
    const late = holdNext("tools/call");
    const lateCall = call();
    await vi.waitFor(() => expect(late.arrived()).toBe(true));
    expect(await call()).toEqual(ECHOED);
    await server.endSessions();
    const newestSession = holdNext("initialize");
    const renewing = call();
    await vi.waitFor(() => expect(newestSession.arrived()).toBe(true));

    late.release(endedSession());
    await nextMacrotask();
    newestSession.release();

    expect(await Promise.all([renewing, lateCall])).toEqual([ECHOED, ECHOED]);
    expect(server.count("initialize")).toBe(3);
  });

  it("keeps the ended session open, without sending again, for a call the server was still handling", async () => {
    const { server } = await connect();
    const { slow, stop } = await startSlowCall(server);
    const closed = closes();

    await server.endSessions();
    expect(await call()).toEqual(ECHOED);

    expect(closed).not.toHaveBeenCalled();
    stop.abort();
    await expect(slow).rejects.toThrow();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(server.count("tools/call")).toBe(3);
  });

  it("keeps the new session open for a call sent again on it when that session ends too", async () => {
    const { server } = await connect();
    await server.endSessions();
    const stop = new AbortController();
    const slow = call("slow", stop.signal);
    await vi.waitFor(() => expect(server.count("tools/call")).toBe(2));
    const closed = closes();

    await server.endSessions();
    expect(await call()).toEqual(ECHOED);

    expect(closed).not.toHaveBeenCalled();
    stop.abort();
    await expect(slow).rejects.toThrow();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("keeps the ended session open for a call still running when the new session can't connect", async () => {
    const { server, client } = await connect();
    const { slow, stop } = await startSlowCall(server);
    const closed = closes();

    await server.endSessions();
    client.failNextConnect = true;

    await expect(call()).rejects.toThrow("session not found");
    expect(closed).not.toHaveBeenCalled();
    stop.abort();
    await expect(slow).rejects.toThrow();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("closes an ended session still waiting for a call when the client closes", async () => {
    const { server, client } = await connect();
    const { slow } = await startSlowCall(server);
    await server.endSessions();
    expect(await call()).toEqual(ECHOED);
    const closed = closes();

    await client.close();

    await expect(slow).rejects.toThrow();
    expect(closed).toHaveBeenCalledTimes(2);
  });

  it.each([500, 404])("fails the call with the session's error when the new session's initialize gets %i, then connects as before", async (status) => {
    const { server, client } = await connect();
    await server.endSessions();
    intercept = (method) => (method === "initialize" ? new Response("no new session", { status }) : undefined);

    await expect(call()).rejects.toThrow("session not found");
    expect(client.status).toBe("disconnected");

    intercept = () => undefined;
    await vi.waitFor(() => expect(client.status).toBe("connected"), { timeout: 5_000 });
    expect(await call()).toEqual(ECHOED);
  });

  it("starts a new session only once for a call that finds the new one ended too, failing with the second error", async () => {
    const { server } = await connect();
    let answered = 0;
    intercept = (method, sessionId) =>
      method === "tools/call" && sessionId !== null ? new Response(++answered === 1 ? "session not found" : "new session not found", { status: 404 }) : undefined;

    await expect(call()).rejects.toThrow("new session not found");
    expect(server.count("initialize")).toBe(2);
  });

  it("answers a health check on a new session", async () => {
    const { server, client } = await connect();

    await server.endSessions();

    await expect(client.ping()).resolves.toBeUndefined();
    expect(server.sessions()).toBe(2);
  });

  it("reports another HTTP error to a request on a live session as before", async () => {
    const { server } = await connect();
    intercept = (method, sessionId) => (method === "tools/call" && sessionId !== null ? new Response("broken", { status: 500 }) : undefined);

    await expect(call()).rejects.toThrow("broken");
    expect(server.count("initialize")).toBe(1);
  });

  it("reports a 404 to a request with no session as before", async () => {
    const { server, client } = await connect("modern");
    const discovers = server.count("server/discover");
    intercept = (method) => (method === "tools/call" ? new Response("not found", { status: 404 }) : undefined);

    await expect(call()).rejects.toThrow("not found");
    expect(server.count("initialize")).toBe(0);
    expect(server.count("server/discover")).toBe(discovers);
    expect(client.status).toBe("connected");
  });
});
