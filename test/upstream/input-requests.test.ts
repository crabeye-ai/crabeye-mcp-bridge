import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { Client, SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { HttpUpstreamClient } from "../../src/upstream/http-client.js";
import { DaemonStdioClient } from "../../src/upstream/daemon-stdio-client.js";
import type { UpstreamClient } from "../../src/upstream/types.js";
import { ToolRegistry } from "../../src/server/tool-registry.js";
import { ToolSearchService } from "../../src/search/index.js";
import { createTestPair } from "../_helpers/bridge-test-pair.js";
import { INPUT_ASKING_TOOLS, inputAskingServer } from "../_helpers/input-asking-server.js";
import { readBody, sendWebResponse, toWebRequest } from "../_helpers/web-http.js";
import { bundleForSubprocess } from "../_helpers/subprocess-bundle.js";
import { spawnTestManager, type DaemonFixture } from "../_helpers/daemon-fixtures.js";
import { APP_NAME } from "../../src/constants.js";

const isWindows = process.platform === "win32";

const RAW_INPUT_REQUIRED = {
  resultType: "input_required",
  inputRequests: {
    confirm: { method: "elicitation/create", params: { message: "Proceed?", requestedSchema: { type: "object", properties: {} } } },
  },
};

function refusal(requested: string): string {
  return `asked the client for input ("${requested}"), which ${APP_NAME} doesn't support`;
}

async function answerRawAskDirectly(request: Request): Promise<Response | null> {
  const message = JSON.parse(await request.clone().text()) as { id?: unknown; method?: string; params?: { name?: string } };
  if (message.method !== "tools/call" || message.params?.name !== "raw_ask") return null;
  return Response.json({ jsonrpc: "2.0", id: message.id, result: RAW_INPUT_REQUIRED });
}

interface Upstream {
  url: string;
  calls: string[];
  close: () => Promise<void>;
}

async function startInputAskingUpstream(): Promise<Upstream> {
  const calls: string[] = [];
  const handler = createMcpHandler(() => inputAskingServer(calls));
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const request = toWebRequest(req, url, await readBody(req));
    const raw = request.method === "POST" ? await answerRawAskDirectly(request) : null;
    await sendWebResponse(res, raw ?? (await handler.fetch(request)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    calls,
    close: async () => {
      await handler.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("an upstream that asks the client for input", () => {
  const cleanups: Array<() => Promise<unknown>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {});
  });

  async function connectHttp(): Promise<{ client: HttpUpstreamClient; upstream: Upstream }> {
    const upstream = await startInputAskingUpstream();
    cleanups.push(upstream.close);
    const client = new HttpUpstreamClient({ name: "asker", config: { type: "streamable-http", url: upstream.url } });
    cleanups.push(() => client.close());
    await client.connect();
    return { client, upstream };
  }

  describe("over HTTP", () => {
    it.each([
      ["ask", "elicitation"],
      ["sample", "sampling"],
      ["roots", "roots"],
    ])("fails a %s call the upstream refuses for lack of a client capability, naming the capability, without calling the tool again", async (tool, capability) => {
      const { client, upstream } = await connectHttp();

      await expect(client.callTool({ name: tool })).rejects.toThrow(new Error(refusal(capability)));
      expect(upstream.calls).toEqual([tool]);
    });

    it("fails a call whose upstream answers with input_required anyway, naming the capability it asked for", async () => {
      const { client } = await connectHttp();

      await expect(client.callTool({ name: "raw_ask" })).rejects.toThrow(new Error(refusal("elicitation")));
    });

    it.each([
      ["needs_tasks", "Missing required client capabilities: tasks"],
      ["needs_elicitation_and_tasks", "Missing required client capabilities: elicitation, tasks"],
    ])("leaves a missing client capability that is not only about input unchanged (%s)", async (tool, message) => {
      const { client } = await connectHttp();

      await expect(client.callTool({ name: tool })).rejects.toThrow(message);
    });

    it("passes an SDK capability error that names no input request through unchanged", async () => {
      const { client } = await connectHttp();
      const sdkError = new SdkError(SdkErrorCode.CapabilityNotSupported, "Server does not support tools (required for tools/call)");
      vi.spyOn(Client.prototype, "callTool").mockRejectedValueOnce(sdkError);

      try {
        await expect(client.callTool({ name: "ask" })).rejects.toBe(sdkError);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("names the method when the SDK refuses an input request the bridge has no capability name for", async () => {
      const { client } = await connectHttp();
      vi.spyOn(Client.prototype, "callTool").mockRejectedValueOnce(
        new SdkError(SdkErrorCode.CapabilityNotSupported, "Client does not support vendor/ask", { method: `vendor/ask${String.fromCodePoint(0x1b)}[2J` }),
      );

      try {
        await expect(client.callTool({ name: "ask" })).rejects.toThrow(new Error(refusal("vendor/ask\\x1b[2J")));
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("lets a result that only carries request state retry as before", async () => {
      const { client, upstream } = await connectHttp();

      expect((await client.callTool({ name: "resume" })).content).toEqual([{ type: "text", text: "resumed" }]);
      expect(upstream.calls).toEqual(["resume", "resume"]);
    });

    it("reports the refusal to the AI client with the upstream's name", async () => {
      const { client: upstream } = await connectHttp();
      const registry = new ToolRegistry();
      registry.setToolsForSource("asker", INPUT_ASKING_TOOLS);
      const { client, cleanup } = await createTestPair({
        registry,
        toolSearchService: new ToolSearchService(registry),
        getUpstreamClient: (name) => (name === "asker" ? (upstream as UpstreamClient) : undefined),
      });
      cleanups.push(cleanup);

      await expect(
        client.callTool({ name: "run_tool", arguments: { name: "asker__ask", arguments: {} } }),
      ).rejects.toThrow(`Upstream server "asker" error: ${refusal("elicitation")}`);
    });
  });

  describe.skipIf(isWindows)("over STDIO through the daemon", () => {
    let serverScript: string;
    let fx: DaemonFixture | undefined;
    let client: DaemonStdioClient | undefined;

    beforeAll(async () => {
      serverScript = await bundleForSubprocess("test/_helpers/subprocess/input-asking-stdio-server.ts", "input-asking-stdio");
    });

    afterEach(async () => {
      await client?.close();
      client = undefined;
      await fx?.stop();
      fx = undefined;
    });

    it.each([
      ["ask", "elicitation"],
      ["sample", "sampling"],
      ["roots", "roots"],
    ])("fails a call to %s with an error naming the %s capability, and keeps serving", async (tool, capability) => {
      const f = (fx = await spawnTestManager({ manager: { childPingMs: 0 } }));
      client = new DaemonStdioClient({
        name: "asker",
        config: { command: process.execPath, args: [serverScript] },
        resolvedEnv: {},
        _socketPath: f.socketPath,
        _ensureDaemon: async () => {},
      });
      await client.connect();

      await expect(client.callTool({ name: tool })).rejects.toThrow(new Error(refusal(capability)));
      expect((await client.callTool({ name: "resume" })).content).toEqual([{ type: "text", text: "resumed" }]);
    });
  });
});
