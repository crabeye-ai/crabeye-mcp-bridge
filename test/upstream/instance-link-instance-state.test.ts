import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { encodeFrame, FrameDecoder } from "../../src/daemon/protocol.js";
import type { LogLevel } from "../../src/logging/index.js";
import { ToolRegistry } from "../../src/server/tool-registry.js";
import { InstanceLink } from "../../src/upstream/instance-link.js";
import { UpstreamManager } from "../../src/upstream/upstream-manager.js";
import { recordingLogger, type LoggedLine } from "../_helpers/spy-logger.js";

const SOURCE = { kind: "file", path: "/home/u/bridge.json" } as const;
const TIMINGS = { rpcTimeoutMs: 5_000, heartbeatMs: 60_000, respawnLockWaitMs: 5_000 };

describe.skipIf(process.platform === "win32")("InstanceLink following what its instance reports", () => {
  let dir: string;
  let server: Server;
  let socket: Socket | undefined;
  let attachResult: { upstreams: string[]; logLevel: unknown; description?: unknown };
  let socketPath: string;
  let answerRetry: (sock: Socket, id: string, upstream: string) => void;
  let afterAttach: Array<{ method: string; params: unknown }>;
  let link: InstanceLink;
  let lines: LoggedLine[];
  let levels: LogLevel[];

  const notify = (method: string, params: unknown) => socket!.write(encodeFrame({ method, params }));

  beforeEach(async () => {
    dir = await mkdtemp("/tmp/cbe-link-state-");
    socketPath = join(dir, "d.sock");
    attachResult = { upstreams: ["svc"], logLevel: "warn" };
    afterAttach = [];
    answerRetry = (sock, id, upstream) => sock.write(encodeFrame({ id, result: { name: upstream, status: "connected", tools: [] } }));
    server = createServer((sock) => {
      socket = sock;
      const decoder = new FrameDecoder();
      sock.on("data", (chunk: Buffer) => {
        decoder.push(chunk);
        for (let frame = decoder.next(); frame !== null; frame = decoder.next()) {
          const request = frame as { id: string; method: string; params: { upstream?: string } };
          if (request.method === "RETRY") answerRetry(sock, request.id, request.params.upstream!);
          if (request.method !== "ATTACH") continue;
          const snapshots = attachResult.upstreams.map((name) => ({ method: "UPSTREAM", params: { name, status: "connected", tools: [] } }));
          sock.write(Buffer.concat([...snapshots, { id: request.id, result: attachResult }, ...afterAttach].map(encodeFrame)));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    lines = [];
    levels = [];
    link = new InstanceLink({
      source: SOURCE,
      env: {},
      childEnv: {},
      logger: recordingLogger(lines),
      ...TIMINGS,
      onLogLevel: (level) => levels.push(level),
      _socketPath: socketPath,
      _ensureDaemon: async () => {},
    });
  });

  afterEach(async () => {
    await link.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  it("takes the log level from the attach reply, and a later one from the instance", async () => {
    await link.attach();

    notify("SETTINGS", { logLevel: "debug" });
    await vi.waitFor(() => expect(levels).toEqual(["warn", "debug"]));
  });

  it("keeps a server added and a log level changed just after the instance answered the attach", async () => {
    afterAttach = [
      { method: "SETTINGS", params: { logLevel: "debug" } },
      { method: "UPSTREAM", params: { name: "fresh", status: "connected", tools: [] } },
    ];

    await link.attach();

    expect(link.upstreamNames()).toEqual(["svc", "fresh"]);
    expect(levels.at(-1)).toBe("debug");
  });

  it("ignores settings it can't read", async () => {
    attachResult = { upstreams: ["svc"], logLevel: "loud" };
    await link.attach();
    notify("SETTINGS", { logLevel: 3 });
    notify("SETTINGS", { logLevel: "error" });

    await vi.waitFor(() => expect(levels).toEqual(["error"]));
  });

  it("takes the search description from the attach reply, and a later one from the instance, telling listeners each time", async () => {
    attachResult = { upstreams: ["svc"], logLevel: "warn", description: { text: "first" } };
    let changes = 0;
    link.onStateChanged(() => changes++);
    expect(link.description()).toBeUndefined();

    await link.attach();
    expect([link.description(), changes]).toEqual(["first", 1]);

    notify("DESCRIPTION", { text: 3 });
    notify("DESCRIPTION", { text: "second" });
    await vi.waitFor(() => expect([link.description(), changes]).toEqual(["second", 2]));
  });

  it("keeps a search description sent just after the instance answered the attach", async () => {
    attachResult = { upstreams: ["svc"], logLevel: "warn", description: { text: "from the reply" } };
    afterAttach = [{ method: "DESCRIPTION", params: { text: "later" } }];

    await link.attach();

    await vi.waitFor(() => expect(link.description()).toBe("later"));
  });

  it("writes a log line that isn't about one server under the config component", async () => {
    await link.attach();

    notify("LOG", { level: "warn", message: "failed to reload config", context: { error: "Config validation failed" } });

    await vi.waitFor(() =>
      expect(lines).toContainEqual({ level: "warn", message: "failed to reload config", context: { component: "config", error: "Config validation failed" } }),
    );
  });

  it("lists the upstreams the instance has, telling listeners again on attach and as it adds and removes them", async () => {
    const changes: string[][] = [];
    link.onUpstreamsChanged(() => changes.push(link.upstreamNames()));
    await link.attach();

    notify("UPSTREAM", { name: "fresh", status: "connecting", tools: [] });
    notify("UPSTREAM_REMOVED", { upstream: "svc" });

    await vi.waitFor(() => expect(changes).toEqual([["svc"], ["svc"], ["svc", "fresh"], ["fresh"]]));
  });

  it("lets a bridge drop a server it stood in for that the instance doesn't have, once attached, without reporting it as failed", async () => {
    const manager = new UpstreamManager({ names: ["svc", "gone"], toolRegistry: new ToolRegistry(), logger: recordingLogger(lines), instanceLink: link });

    const result = await manager.connectAll();

    expect([manager.getClient("svc"), manager.getClient("gone")].map((client) => client !== undefined)).toEqual([true, false]);
    expect(result).toEqual({ total: 1, connected: 1, failed: [] });
    expect(lines.filter((line) => line.level === "error")).toEqual([]);
  });

  it("doesn't bring back an upstream the instance removed while retrying it", async () => {
    attachResult = { upstreams: ["svc", "flaky"], logLevel: "warn" };
    answerRetry = (sock, id, upstream) => {
      sock.write(encodeFrame({ method: "UPSTREAM_REMOVED", params: { upstream } }));
      sock.write(encodeFrame({ id, result: { name: upstream, status: "connected", tools: [] } }));
    };
    await link.attach();

    await link.retry("flaky");

    expect(link.upstreamNames()).toEqual(["svc"]);
  });

  it("attaches again after a failed attempt when only the upstream list is followed", async () => {
    let attempts = 0;
    const following = new InstanceLink({
      source: SOURCE,
      env: {},
      childEnv: {},
      ...TIMINGS,
      reconnect: { reconnectBaseDelay: 20, reconnectMaxDelay: 20 },
      _socketPath: socketPath,
      _ensureDaemon: async () => {
        if (++attempts === 1) throw new Error("manager not up yet");
      },
    });
    following.onUpstreamsChanged(() => {});
    const states: Array<[boolean, boolean]> = [];
    following.onStateChanged(() => states.push([following.isAttached, following.isDown]));

    try {
      await following.attach().catch(() => {});
      expect(states).toEqual([[false, true]]);

      await vi.waitFor(() => expect(following.isAttached).toBe(true));
      expect(states).toEqual([[false, true], [true, false]]);
    } finally {
      await following.close();
    }
  });
});
