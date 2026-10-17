import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bundleForSubprocess } from "../_helpers/subprocess-bundle.js";
import { daemonPidsRunning, exited, waitUntil } from "../_helpers/processes.js";
import { startHeaderRecordingUpstream, type HeaderRecordingUpstream } from "../_helpers/header-recording-upstream.js";

const isWindows = process.platform === "win32";
const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};
const VERSION_PROBE = { jsonrpc: "2.0", id: "probe", method: "server/discover", params: { _meta: META } };
const LIST_TOOLS = { jsonrpc: "2.0", id: "list", method: "tools/list", params: { _meta: META } };
const RUN_PLAIN = {
  jsonrpc: "2.0",
  id: "call",
  method: "tools/call",
  params: { _meta: META, name: "run_tool", arguments: { name: "rec__plain", arguments: {} } },
};
const STUB_STDIO_SERVER = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const reply = (id, body) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...body }) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined || msg.method === undefined) return;
  if (msg.method === "initialize") {
    reply(msg.id, { result: { protocolVersion: msg.params.protocolVersion, serverInfo: { name: "stub", version: "0" }, capabilities: { tools: {} } } });
  } else if (msg.method === "tools/list") {
    reply(msg.id, { result: { tools: [{ name: "plain", inputSchema: { type: "object" } }] } });
  } else if (msg.method === "tools/call") {
    reply(msg.id, { result: { content: [{ type: "text", text: "called " + msg.params.name }] } });
  } else {
    reply(msg.id, { error: { code: -32601, message: "Method not found" } });
  }
});
`;

describe.skipIf(isWindows)("bridge process: upstream connections wait for the client's session", () => {
  let cliScript: string;
  let dir: string;
  let upstream: HeaderRecordingUpstream;
  let bridge: ChildProcessWithoutNullStreams | undefined;
  let sdkClient: Client | undefined;
  let replies: Map<unknown, Record<string, unknown>>;

  beforeAll(async () => {
    cliScript = await bundleForSubprocess("src/index.ts", "cli-session");
  });

  afterEach(async () => {
    await sdkClient?.close();
    sdkClient = undefined;
    if (bridge && bridge.exitCode === null) {
      bridge.kill("SIGKILL");
      await exited(bridge, 5_000);
    }
    bridge = undefined;
    for (const pid of daemonPidsRunning(cliScript)) process.kill(pid, "SIGTERM");
    await waitUntil(() => daemonPidsRunning(cliScript).length === 0, 5_000);
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }, 20_000);

  async function prepareWorkspace(upstreamKind: "http" | "stdio"): Promise<string> {
    dir = await mkdtemp("/tmp/cbe-session-");
    upstream = await startHeaderRecordingUpstream({ era: "modern" });
    const stub = join(dir, "stub.cjs");
    await writeFile(stub, STUB_STDIO_SERVER);
    const rec = upstreamKind === "http"
      ? { type: "streamable-http", url: upstream.url }
      : { command: process.execPath, args: [stub] };
    const configPath = join(dir, "client.json");
    await writeFile(configPath, JSON.stringify({ mcpServers: { rec } }));
    return configPath;
  }

  async function startBridge(upstreamKind: "http" | "stdio" = "http"): Promise<void> {
    const configPath = await prepareWorkspace(upstreamKind);
    const child = spawn(process.execPath, [cliScript, "--config", configPath], {
      stdio: "pipe",
      env: { ...process.env, HOME: dir },
    });
    bridge = child;
    replies = new Map();
    let pending = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const lines = (pending + chunk.toString()).split("\n");
      pending = lines.pop() ?? "";
      for (const raw of lines.filter(Boolean)) {
        const message = JSON.parse(raw) as Record<string, unknown>;
        replies.set(message.id, message);
      }
    });
  }

  async function request(message: { id: string }): Promise<Record<string, unknown>> {
    bridge!.stdin.write(`${JSON.stringify(message)}\n`);
    await waitUntil(() => replies.has(message.id), 10_000);
    expect(replies.has(message.id)).toBe(true);
    return replies.get(message.id)!;
  }

  it("sends nothing upstream when the client only probes the version and leaves", async () => {
    await startBridge();

    expect(await request(VERSION_PROBE)).toMatchObject({ result: expect.any(Object) });
    await waitUntil(() => upstream.requests().length > 0, 1_000);
    bridge!.stdin.end();

    expect(await exited(bridge!, 10_000)).toBe(0);
    expect(upstream.requests()).toEqual([]);
  }, 15_000);

  it("connects upstreams once the client sends its first request after the probe", async () => {
    await startBridge();

    await request(VERSION_PROBE);
    await request(LIST_TOOLS);
    await waitUntil(() => upstream.requests().some((r) => r.method === "tools/list"), 10_000);

    expect(upstream.requests().map((r) => r.method)).toEqual(expect.arrayContaining(["server/discover", "tools/list"]));
  }, 15_000);

  it.each(["http", "stdio"] as const)("runs a tool on a %s upstream when run_tool is the client's first request after the probe", async (upstreamKind) => {
    await startBridge(upstreamKind);

    await request(VERSION_PROBE);
    const reply = await request(RUN_PLAIN);

    expect(reply.result).toMatchObject({ content: [{ type: "text", text: "called plain" }] });
  }, 20_000);

  it("gives a modern SDK client over stdio one upstream connection, not one per process it starts", async () => {
    const configPath = await prepareWorkspace("http");
    sdkClient = new Client({ name: "sdk-client", version: "1" }, { versionNegotiation: { mode: "auto" } });

    await sdkClient.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cliScript, "--config", configPath],
        env: { ...process.env, HOME: dir },
        stderr: "ignore",
      }),
    );
    expect(sdkClient.getProtocolEra()).toBe("modern");
    const result = await sdkClient.callTool({ name: "run_tool", arguments: { name: "rec__plain", arguments: {} } });
    expect(result.content).toEqual([{ type: "text", text: "called plain" }]);
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(upstream.requests().filter((r) => r.method === "server/discover")).toHaveLength(1);
  }, 20_000);
});
