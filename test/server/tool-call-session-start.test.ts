import { describe, it, expect, afterEach } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolRequest } from "@modelcontextprotocol/client";
import { BridgeServer } from "../../src/server/bridge-server.js";
import { transportKeepingFirstMessageHandler } from "../_helpers/transports.js";
import { spyLogger } from "../_helpers/spy-logger.js";

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("tool calls as a modern client's first request when the transport drops the session watcher", () => {
  let server: BridgeServer | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    await server?.close();
    client = undefined;
    server = undefined;
  });

  async function connectModern(): Promise<{ client: Client; started: () => boolean; clientsLogged: () => number }> {
    const logger = spyLogger();
    const bridge = new BridgeServer({ logger });
    server = bridge;
    let started = false;
    void bridge.sessionStarted().then(() => {
      started = true;
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await bridge.connect(transportKeepingFirstMessageHandler(serverSide));
    const modern = new Client({ name: "modern", version: "1" }, { versionNegotiation: { mode: "auto" } });
    client = modern;
    await modern.connect(clientSide);
    await settle();
    expect(modern.getProtocolEra()).toBe("modern");
    return {
      client: modern,
      started: () => started,
      clientsLogged: () => logger.info.mock.calls.filter(([message]) => message === "client connected").length,
    };
  }

  it("starts the session and logs the client once when the first request is search_tools", async () => {
    const { client, started, clientsLogged } = await connectModern();
    expect(started()).toBe(false);
    const search = { name: "search_tools", arguments: { queries: [{ provider: "linear" }] } };

    expect((await client.callTool(search)).isError).toBeUndefined();
    await client.callTool(search);
    await settle();

    expect(started()).toBe(true);
    expect(clientsLogged()).toBe(1);
  });

  it.each<[string, CallToolRequest["params"], string]>([
    ["an unknown tool", { name: "linear__create_issue", arguments: {} }, "protocol error"],
    ["run_tool with arguments its schema refuses", { name: "run_tool", arguments: { name: 5 } }, "error result"],
    ["search_tools with arguments its schema refuses", { name: "search_tools", arguments: {} }, "error result"],
  ])("neither starts the session nor logs the client for %s", async (_case, params, outcome) => {
    const { client, started, clientsLogged } = await connectModern();

    const answer = await client.callTool(params).then(
      (result) => (result.isError ? "error result" : "success"),
      () => "protocol error",
    );
    await settle();

    expect(answer).toBe(outcome);
    expect(started()).toBe(false);
    expect(clientsLogged()).toBe(0);
  });
});
