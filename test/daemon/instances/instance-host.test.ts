import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeConfigSchema } from "../../../src/config/schema.js";
import { ConfigError } from "../../../src/config/loader.js";
import type { CredentialStore } from "../../../src/credentials/credential-store.js";
import { InstanceHost } from "../../../src/daemon/instances/instance-host.js";
import type { DaemonResponse, InstanceSource } from "../../../src/daemon/protocol.js";
import type { FrameChannel } from "../../../src/daemon/transport.js";
import { MAX_INFLIGHT_PER_SESSION } from "../../../src/daemon/protocol.js";
import { ScriptedUpstreamClient, tool } from "../../_helpers/scripted-upstream-client.js";
import { spyLogger } from "../../_helpers/spy-logger.js";

interface FakeChannel extends FrameChannel {
  sent: unknown[];
}

function fakeChannel(): FakeChannel {
  const channel = new EventEmitter() as FakeChannel;
  channel.sent = [];
  channel.send = (payload) => {
    channel.sent.push(payload);
    return true;
  };
  channel.close = () => {};
  Object.defineProperty(channel, "remote", { value: "test" });
  return channel;
}

const fileSource: InstanceSource = { kind: "file", path: "/home/u/bridge.json" };
const attachParams = (overrides: Record<string, unknown> = {}) => ({ bridgeProtocolVersion: 3, source: fileSource, env: {}, ...overrides });

describe("InstanceHost", () => {
  let configs: Map<string, unknown>;
  let loads: number;
  let loadGate: Promise<void>;
  let clients: ScriptedUpstreamClient[];
  let onIdle: Mock<() => void>;
  let host: InstanceHost;

  function makeHost(idleMs = 60_000): InstanceHost {
    return new InstanceHost({
      idleMs,
      logger: spyLogger(),
      onIdle,
      loadConfig: async (source) => {
        loads++;
        await loadGate;
        const config = configs.get(source.path);
        if (config instanceof Error) throw config;
        if (config === undefined) throw new ConfigError(`Config file not found: ${source.path}`);
        return { config: BridgeConfigSchema.parse(config), watchPaths: [] };
      },
      createCredentialStore: () => ({}) as CredentialStore,
      createClient: (name) => {
        const client = new ScriptedUpstreamClient(name);
        client.tools = [tool(`${name}_tool`)];
        clients.push(client);
        return client;
      },
    });
  }

  /** Holds config loads until the returned function is called. */
  function holdLoads(): () => void {
    let open!: () => void;
    loadGate = new Promise((resolve) => (open = resolve));
    return open;
  }

  async function attach(channel: FakeChannel, params: Record<string, unknown> = attachParams()): Promise<DaemonResponse> {
    return host.handleAttach("a1", params, channel);
  }

  beforeEach(() => {
    configs = new Map([[fileSource.path, { mcpServers: { svc: { url: "https://svc.example.com/mcp" }, local: { command: "node" } } }]]);
    loads = 0;
    loadGate = Promise.resolve();
    clients = [];
    onIdle = vi.fn();
    host = makeHost();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await host.close();
  });

  describe("ATTACH", () => {
    it("sends a snapshot of each daemon-hosted server, then answers with their names", async () => {
      const channel = fakeChannel();

      expect(await attach(channel)).toEqual({ id: "a1", result: { upstreams: ["svc"] } });
      expect(channel.sent).toEqual([
        { method: "UPSTREAM", params: { name: "svc", status: "connected", tools: [tool("svc_tool")] } },
      ]);
      expect(host.statusInstances()).toEqual([{ source: fileSource, bridges: 1, upstreams: ["svc"] }]);
      expect(host.statusHttpUpstreams()).toEqual([{ serverName: "svc", status: "connected", instances: 1 }]);
    });

    it("creates one instance for two bridges attaching at once", async () => {
      const open = holdLoads();
      const [a, b] = [fakeChannel(), fakeChannel()];

      const both = Promise.all([attach(a), attach(b)]);
      open();
      await both;

      expect(loads).toBe(1);
      expect(clients).toHaveLength(1);
      expect(host.statusInstances()).toEqual([{ source: fileSource, bridges: 2, upstreams: ["svc"] }]);
    });

    it("gives a bridge with another master key its own instance and connection", async () => {
      await attach(fakeChannel());
      await attach(fakeChannel(), attachParams({ env: { MCP_BRIDGE_MASTER_KEY: "k" } }));

      expect(host.statusInstances()).toHaveLength(2);
      expect(clients).toHaveLength(2);
    });

    it("shares the connection of a server another config names the same way", async () => {
      configs.set("/home/u/other.json", { mcpServers: { svc: { url: "https://svc.example.com/mcp" } } });
      await attach(fakeChannel());
      await attach(fakeChannel(), attachParams({ source: { kind: "file", path: "/home/u/other.json" } }));

      expect(host.statusInstances()).toHaveLength(2);
      expect(clients).toHaveLength(1);
      expect(host.statusHttpUpstreams()).toEqual([{ serverName: "svc", status: "connected", instances: 2 }]);
    });

    it.each([
      ["malformed params", { source: fileSource }, "invalid_params"],
      ["a bridge protocol older than instances", attachParams({ bridgeProtocolVersion: 2 }), "bridge_unsupported"],
    ])("refuses %s", async (_label, params, code) => {
      expect((await attach(fakeChannel(), params)).error?.code).toBe(code);
    });

    it("refuses a second ATTACH on the same connection, also while the first is loading", async () => {
      const open = holdLoads();
      const channel = fakeChannel();
      const first = attach(channel);

      expect((await attach(channel)).error?.code).toBe("already_attached");
      open();
      await first;
      expect((await attach(channel)).error?.code).toBe("already_attached");
    });

    it("reports a config that doesn't load with its issues, and loads it again on the next attach", async () => {
      configs.set(fileSource.path, new ConfigError("Config validation failed", [{ path: "mcpServers.svc.url", message: "Invalid url" }]));

      expect((await attach(fakeChannel())).error).toEqual({
        code: "instance_load_failed",
        message: "Config validation failed: mcpServers.svc.url: Invalid url",
      });
      expect(host.isEmpty).toBe(true);
      expect(onIdle).toHaveBeenCalledTimes(1);

      configs.set(fileSource.path, { mcpServers: {} });
      expect(await attach(fakeChannel())).toEqual({ id: "a1", result: { upstreams: [] } });
      expect(loads).toBe(2);
    });

    it("doesn't attach a connection that closed while the instance was loading, and lets the instance go idle", async () => {
      vi.useFakeTimers();
      host = makeHost(1_000);
      const open = holdLoads();
      const channel = fakeChannel();
      const attaching = attach(channel);
      host.channelClosed(channel);
      open();

      expect((await attaching).error?.code).toBe("not_attached");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(host.isEmpty).toBe(true);
      expect(clients[0]!.closed).toBe(true);
    });

    it("reloads the config for each further bridge, so an edit the instance doesn't watch for reaches every bridge", async () => {
      const first = fakeChannel();
      await attach(first);
      configs.set(fileSource.path, { mcpServers: { svc: { url: "https://svc.example.com/mcp" }, fresh: { url: "https://fresh.example.com/mcp" } } });

      expect(await attach(fakeChannel())).toEqual({ id: "a1", result: { upstreams: ["svc", "fresh"] } });
      expect(loads).toBe(2);
      expect(first.sent).toContainEqual({ method: "UPSTREAM", params: expect.objectContaining({ name: "fresh" }) });
    });

    it("refuses a new config once the instance cap is reached, but still attaches to an existing one", async () => {
      for (let i = 0; i < 64; i++) configs.set(`/home/u/c${i}.json`, { mcpServers: {} });
      for (let i = 0; i < 64; i++) await attach(fakeChannel(), attachParams({ source: { kind: "file", path: `/home/u/c${i}.json` } }));

      expect((await attach(fakeChannel())).error?.code).toBe("too_many_instances");
      expect((await attach(fakeChannel(), attachParams({ source: { kind: "file", path: "/home/u/c0.json" } }))).error).toBeUndefined();
    });

    it("refuses once the host is closing", async () => {
      await host.close();
      expect((await attach(fakeChannel())).error?.code).toBe("daemon_stopping");
    });
  });

  describe("idle", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      host = makeHost(1_000);
    });

    it("closes an instance idleMs after its last bridge leaves, with its connections", async () => {
      const [a, b] = [fakeChannel(), fakeChannel()];
      await attach(a);
      await attach(b);
      host.channelClosed(a);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(host.isEmpty).toBe(false);

      host.channelClosed(b);
      await vi.advanceTimersByTimeAsync(999);
      expect(host.isEmpty).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(host.isEmpty).toBe(true);
      expect(clients[0]!.closed).toBe(true);
      expect(onIdle).toHaveBeenCalledTimes(1);
    });

    it("keeps an idling instance while it reloads the config for a bridge attaching to it", async () => {
      const a = fakeChannel();
      await attach(a);
      host.channelClosed(a);
      await vi.advanceTimersByTimeAsync(900);
      const open = holdLoads();

      const attaching = attach(fakeChannel());
      await vi.advanceTimersByTimeAsync(500);
      open();

      expect((await attaching).result).toEqual({ upstreams: ["svc"] });
      expect(host.statusInstances()).toEqual([{ source: fileSource, bridges: 1, upstreams: ["svc"] }]);
      expect(clients[0]!.closed).toBe(false);
    });

    it("still idles out after a bridge attached while another left during the reload for it", async () => {
      const b = fakeChannel();
      await attach(b);
      const open = holdLoads();
      const a = fakeChannel();
      const attaching = attach(a);
      await vi.advanceTimersByTimeAsync(5);
      host.channelClosed(b);
      open();
      expect((await attaching).error).toBeUndefined();

      await vi.advanceTimersByTimeAsync(2_000);
      expect(host.statusInstances()).toHaveLength(1);
      host.channelClosed(a);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(host.isEmpty).toBe(true);
      expect(onIdle).toHaveBeenCalledTimes(1);
    });

    it("serves a bridge whose attach reload outlasts idleMs, instead of attaching it to a closed instance", async () => {
      const b = fakeChannel();
      await attach(b);
      const open = holdLoads();
      const a = fakeChannel();
      const attaching = attach(a);
      await vi.advanceTimersByTimeAsync(5);
      host.channelClosed(b);
      await vi.advanceTimersByTimeAsync(3_000);
      open();

      expect((await attaching).result).toEqual({ upstreams: ["svc"] });
      expect(await host.handleRetry("r", { upstream: "svc" }, a)).toMatchObject({ result: { status: "connected" } });
      expect(clients[0]!.closed).toBe(false);
    });

    it("keeps the instance and its connection for a bridge that attaches before then", async () => {
      const a = fakeChannel();
      await attach(a);
      host.channelClosed(a);
      await vi.advanceTimersByTimeAsync(500);

      await attach(fakeChannel());
      await vi.advanceTimersByTimeAsync(5_000);

      expect(host.statusInstances()).toEqual([{ source: fileSource, bridges: 1, upstreams: ["svc"] }]);
      expect(clients).toHaveLength(1);
      expect(clients[0]!.closed).toBe(false);
    });
  });

  describe("CALL_TOOL", () => {
    let channel: FakeChannel;

    beforeEach(async () => {
      channel = fakeChannel();
      await attach(channel);
    });

    it("calls the tool on the shared connection", async () => {
      const reply = await host.handleCallTool("c", { callId: "1", upstream: "svc", name: "search", arguments: { q: "x" } }, channel);

      expect(reply).toEqual({ id: "c", result: { content: [{ type: "text", text: "called search" }] } });
      expect(clients[0]!.calls).toMatchObject([{ name: "search", arguments: { q: "x" } }]);
    });

    it("returns the upstream's error message", async () => {
      clients[0]!.answer = () => Promise.reject(new Error("MCP error -32602: bad arguments"));

      expect((await host.handleCallTool("c", { callId: "1", upstream: "svc", name: "search" }, channel)).error).toEqual({
        code: "upstream_error",
        message: "MCP error -32602: bad arguments",
      });
    });

    it("reloads before refusing a server it doesn't have", async () => {
      expect((await host.handleCallTool("c", { callId: "1", upstream: "nope", name: "x" }, channel)).error).toEqual({
        code: "unknown_upstream",
        message: '"nope" is not in the configuration the manager loaded',
      });
      expect(loads).toBe(2);
    });

    it("refuses a call from a connection that hasn't attached, and malformed params", async () => {
      expect((await host.handleCallTool("c", { callId: "1", upstream: "svc", name: "x" }, fakeChannel())).error?.code).toBe("not_attached");
      expect((await host.handleCallTool("c", { upstream: "svc" }, channel)).error?.code).toBe("invalid_params");
    });

    it("aborts the call when the bridge cancels it or its connection closes, saying why", async () => {
      clients[0]!.answer = (call) =>
        new Promise((_, reject) => call.signal!.addEventListener("abort", () => reject(new Error("aborted"))));
      const cancelled = host.handleCallTool("c", { callId: "1", upstream: "svc", name: "slow" }, channel);
      const dropped = host.handleCallTool("d", { callId: "2", upstream: "svc", name: "slow" }, channel);
      await vi.waitFor(() => expect(clients[0]!.calls).toHaveLength(2));

      host.handleCancelTool({ callId: "1" }, channel);
      expect((await cancelled).error?.message).toBe("Request cancelled");
      expect(clients[0]!.calls[1]!.signal!.aborted).toBe(false);
      host.channelClosed(channel);
      expect((await dropped).error?.message).toBe("bridge disconnected");
    });

    it("fails calls in flight with the daemon shutting down when it closes", async () => {
      clients[0]!.answer = (call) =>
        new Promise((_, reject) => call.signal!.addEventListener("abort", () => reject(new Error("aborted"))));
      const running = host.handleCallTool("c", { callId: "1", upstream: "svc", name: "slow" }, channel);
      await vi.waitFor(() => expect(clients[0]!.calls).toHaveLength(1));

      await host.close();

      expect((await running).error).toEqual({ code: "upstream_error", message: "daemon shutdown" });
    });

    it("ignores a cancel for a call it doesn't know", () => {
      expect(() => host.handleCancelTool({ callId: "unknown" }, channel)).not.toThrow();
      expect(() => host.handleCancelTool({}, fakeChannel())).not.toThrow();
    });

    it("refuses a callId already in flight, and more calls than the in-flight cap", async () => {
      clients[0]!.answer = () => new Promise(() => {});
      for (let i = 0; i < MAX_INFLIGHT_PER_SESSION; i++) {
        void host.handleCallTool(`c${i}`, { callId: String(i), upstream: "svc", name: "slow" }, channel);
      }
      await vi.waitFor(() => expect(clients[0]!.calls).toHaveLength(MAX_INFLIGHT_PER_SESSION));

      expect((await host.handleCallTool("d", { callId: "0", upstream: "svc", name: "slow" }, channel)).error?.code).toBe("invalid_params");
      expect((await host.handleCallTool("e", { callId: "new", upstream: "svc", name: "slow" }, channel)).error?.code).toBe("too_many_calls");
    });
  });

  describe("RETRY", () => {
    it("tries the server now and answers where it stands", async () => {
      const channel = fakeChannel();
      await attach(channel);
      clients[0]!.setStatus("disconnected", new Error("reset"));

      expect(await host.handleRetry("r", { upstream: "svc" }, channel)).toEqual({
        id: "r",
        result: { name: "svc", status: "connected", tools: [tool("svc_tool")] },
      });
      expect(clients[0]!.retries).toBe(1);
    });

    it("refuses an unknown server, an unattached connection and malformed params", async () => {
      const channel = fakeChannel();
      await attach(channel);
      expect((await host.handleRetry("r", { upstream: "nope" }, channel)).error?.code).toBe("unknown_upstream");
      expect((await host.handleRetry("r", { upstream: "svc" }, fakeChannel())).error?.code).toBe("not_attached");
      expect((await host.handleRetry("r", {}, channel)).error?.code).toBe("invalid_params");
    });
  });

  it("closes every instance and connection on close", async () => {
    await attach(fakeChannel());
    await host.close();
    expect(host.isEmpty).toBe(true);
    expect(clients[0]!.closed).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")("InstanceHost loading a config itself", () => {
  let dir: string;
  let host: InstanceHost;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cbe-host-"));
    host = new InstanceHost({ idleMs: 60_000, logger: spyLogger(), onIdle: () => {} });
  });

  afterEach(async () => {
    await host.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses a config path that isn't a regular file, such as a FIFO, instead of waiting on it", async () => {
    const fifo = join(dir, "bridge.json");
    execFileSync("mkfifo", [fifo]);

    const response = await host.handleAttach("a1", { bridgeProtocolVersion: 3, source: { kind: "file", path: fifo }, env: {} }, fakeChannel());

    expect(response).toEqual({ id: "a1", error: { code: "instance_load_failed", message: `Config file is not a regular file: ${fifo}` } });
  });
});
