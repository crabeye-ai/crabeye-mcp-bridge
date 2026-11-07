import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/client";
import { Server, createMcpHandler } from "@modelcontextprotocol/server";
import { HttpUpstreamClient } from "../../src/upstream/http-client.js";
import { readBody, toWebRequest } from "../_helpers/web-http.js";
import { spyLogger } from "../_helpers/spy-logger.js";

interface ChangingUpstream {
  url: string;
  /** How many `subscriptions/listen` requests arrived. */
  listens(): number;
  /** Replaces the tools, and announces it to open subscriptions. */
  setTools(names: string[]): void;
  /** Cuts every open `subscriptions/listen` stream without a response. */
  cutListenStreams(): void;
  refuseListens(refuse: boolean): void;
  close(): Promise<void>;
}

function methodOf(body: Buffer): string | undefined {
  try {
    return (JSON.parse(body.toString("utf8")) as { method?: string }).method;
  } catch {
    return undefined;
  }
}

async function streamTo(res: http.ServerResponse, body: ReadableStream<Uint8Array>): Promise<void> {
  for await (const chunk of body) res.write(chunk);
}

async function startChangingUpstream({ ttlMs }: { ttlMs?: number } = {}): Promise<ChangingUpstream> {
  let tools = [{ name: "first", inputSchema: { type: "object" as const } }];
  let listens = 0;
  let refusing = false;
  const listenStreams = new Set<http.ServerResponse>();
  const handler = createMcpHandler(() => {
    const server = new Server({ name: "changing", version: "1.0.0" }, { capabilities: { tools: { listChanged: true } } });
    server.setRequestHandler("tools/list", () => ({ tools, ...(ttlMs !== undefined && { ttlMs }) }));
    return server;
  });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    const body = await readBody(req);
    if (methodOf(body) === "subscriptions/listen") {
      listens++;
      if (refusing) {
        res.writeHead(500);
        return res.end();
      }
      listenStreams.add(res);
      res.on("close", () => listenStreams.delete(res));
    }
    const disconnected = new AbortController();
    res.on("close", () => disconnected.abort());
    const response = await handler.fetch(toWebRequest(req, url, body, disconnected.signal));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    const stream = response.body;
    if (stream !== null) await streamTo(res, stream).catch(() => {});
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    listens: () => listens,
    setTools: (names) => {
      tools = names.map((name) => ({ name, inputSchema: { type: "object" as const } }));
      handler.notify.toolsChanged();
    },
    cutListenStreams: () => {
      for (const stream of listenStreams) stream.destroy();
    },
    refuseListens: (refuse) => {
      refusing = refuse;
    },
    close: async () => {
      for (const stream of listenStreams) stream.destroy();
      await handler.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("an HTTP upstream on the 2026-07-28 protocol that announces tool changes", { timeout: 20_000 }, () => {
  let upstream: ChangingUpstream;
  let client: HttpUpstreamClient;

  afterEach(async () => {
    vi.restoreAllMocks();
    await client.close();
    await upstream.close();
  });

  async function connect(options: { ttlMs?: number } = {}): Promise<void> {
    upstream = await startChangingUpstream(options);
    client = new HttpUpstreamClient({ name: "svc", config: { type: "streamable-http", url: upstream.url }, logger: spyLogger(), reconnectBaseDelay: 60_000 });
    await client.connect();
  }

  const toolNames = () => client.tools.map((tool) => tool.name);

  it("hears about tool changes while its subscription is open", async () => {
    await connect();

    upstream.setTools(["second"]);

    await vi.waitFor(() => expect(toolNames()).toEqual(["second"]), { timeout: 5_000 });
    expect(upstream.listens()).toBe(1);
  });

  it("listens again after the server's stream is cut, picking up tools changed meanwhile and later", async () => {
    await connect();

    upstream.cutListenStreams();
    upstream.setTools(["second"]);

    await vi.waitFor(() => expect(toolNames()).toEqual(["second"]), { timeout: 10_000 });
    expect(upstream.listens()).toBe(2);
    expect(client.status).toBe("connected");
    upstream.setTools(["third"]);
    await vi.waitFor(() => expect(toolNames()).toEqual(["third"]), { timeout: 5_000 });

    upstream.cutListenStreams();
    upstream.setTools(["fourth"]);
    await vi.waitFor(() => expect(toolNames()).toEqual(["fourth"]), { timeout: 10_000 });
    expect(upstream.listens()).toBe(3);
  });

  it("picks up tools changed while the stream was cut from a server that lets clients cache its tool list", async () => {
    await connect({ ttlMs: 600_000 });

    upstream.cutListenStreams();
    upstream.setTools(["second"]);

    await vi.waitFor(() => expect(toolNames()).toEqual(["second"]), { timeout: 10_000 });
  });

  it("keeps trying to listen again while the server refuses, and stays connected", async () => {
    await connect();
    upstream.refuseListens(true);

    upstream.cutListenStreams();

    await vi.waitFor(() => expect(upstream.listens()).toBeGreaterThanOrEqual(3), { timeout: 10_000 });
    expect(client.status).toBe("connected");
    upstream.refuseListens(false);
    upstream.setTools(["second"]);
    await vi.waitFor(() => expect(toolNames()).toEqual(["second"]), { timeout: 15_000 });
  });

  it("connects when the server refuses the first subscription, then listens once it accepts", async () => {
    upstream = await startChangingUpstream();
    upstream.refuseListens(true);
    client = new HttpUpstreamClient({ name: "svc", config: { type: "streamable-http", url: upstream.url }, logger: spyLogger(), reconnectBaseDelay: 60_000 });

    await client.connect();

    expect(client.status).toBe("connected");
    expect(toolNames()).toEqual(["first"]);
    upstream.refuseListens(false);
    await vi.waitFor(() => expect(upstream.listens()).toBe(2), { timeout: 5_000 });
    upstream.setTools(["second"]);
    await vi.waitFor(() => expect(toolNames()).toEqual(["second"]), { timeout: 5_000 });
  });

  it("stops listening for a client that was closed", async () => {
    await connect();
    const listen = vi.spyOn(Client.prototype, "listen");

    upstream.cutListenStreams();
    await delay(100);
    await client.close();
    await delay(2_500);

    expect(listen).not.toHaveBeenCalled();
  });
});
