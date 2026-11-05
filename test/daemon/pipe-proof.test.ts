import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { closeServer, INVALID_JSON_FRAME } from "../_helpers/frame-server.js";
import type { DaemonServer, FrameChannel } from "../../src/daemon/transport.js";

const realPlatform = process.platform;
Object.defineProperty(process, "platform", { value: "win32" });

const { netTransport } = await import("../../src/daemon/net-transport.js");
const { DaemonClient } = await import("../../src/daemon/client.js");
const { daemonStatus, ensureDaemonRunning } = await import("../../src/daemon/bootstrap.js");
const { ForeignPipeServerError } = await import("../../src/daemon/pipe-proof.js");
const { getDaemonKeyPath, getDaemonPidPath } = await import("../../src/daemon/paths.js");
const { processExists } = await import("../../src/process/process-utils.js");
const { DAEMON_LAUNCH_ARGS } = await import("../../src/daemon/daemon-identity.js");
const { until } = await import("../_helpers/daemon-fixtures.js");
const { encodeFrame, FrameDecoder } = await import("../../src/daemon/protocol.js");

const HEX_64 = /^[0-9a-f]{64}$/;

describe("manager pipe proof on Windows", () => {
  let dir: string;
  let path: string;
  const servers: DaemonServer[] = [];
  const squatters: Server[] = [];
  const children: ChildProcess[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cbe-pp-"));
    path = realPlatform === "win32" ? `\\\\.\\pipe\\cbe-pp-${randomBytes(6).toString("hex")}` : join(dir, "s");
    vi.stubEnv("LOCALAPPDATA", join(dir, "local"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const child of children.splice(0)) child.kill();
    await Promise.all(servers.splice(0).map((server) => server.stop()));
    await Promise.all(squatters.splice(0).map(closeServer));
    rmSync(dir, { recursive: true, force: true });
  });

  afterAll(() => {
    Object.defineProperty(process, "platform", { value: realPlatform });
  });

  async function startManager(opts: { onConnection?: () => void; challengeTimeoutMs?: number } = {}): Promise<DaemonServer> {
    const server = netTransport.createServer({
      path,
      _challengeTimeoutMs: opts.challengeTimeoutMs,
      onConnection: (channel) => {
        opts.onConnection?.();
        channel.on("message", (msg: { id: string }) => channel.send({ id: msg.id, result: { pong: true } }));
      },
    });
    await server.start();
    servers.push(server);
    return server;
  }

  function writeKey(text = randomBytes(32).toString("hex")): void {
    mkdirSync(dirname(getDaemonKeyPath()), { recursive: true });
    writeFileSync(getDaemonKeyPath(), text);
  }

  async function squat(
    respond: (frame: unknown, socket: Socket) => void = () => {},
  ): Promise<{ frames: unknown[]; bytes: () => number; closed: () => number }> {
    const frames: unknown[] = [];
    let bytes = 0;
    let closed = 0;
    const server = createServer((socket) => {
      const decoder = new FrameDecoder();
      socket.on("error", () => {});
      socket.on("close", () => closed++);
      socket.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        decoder.push(chunk);
        for (let frame = decoder.next(); frame !== null; frame = decoder.next()) {
          frames.push(frame);
          respond(frame, socket);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    squatters.push(server);
    return { frames, bytes: () => bytes, closed: () => closed };
  }

  function connect(connectTimeoutMs = 1_000): Promise<FrameChannel> {
    return netTransport.connect({ path, connectTimeoutMs });
  }

  function rawConnection(): Promise<{ socket: Socket; received: () => number; closed: Promise<void> }> {
    return new Promise((resolve, reject) => {
      let received = 0;
      const socket = createConnection(path);
      const closed = new Promise<void>((done) => socket.once("close", () => done()));
      socket.on("data", (chunk: Buffer) => (received += chunk.length));
      socket.once("error", reject);
      socket.once("connect", () => resolve({ socket, received: () => received, closed }));
    });
  }

  async function expectReachable(): Promise<void> {
    const client = new DaemonClient({ socketPath: path, transport: netTransport });
    await expect(client.call("STATUS")).resolves.toEqual({ pong: true });
    client.close();
  }

  it("connects to the user's manager once it proves it holds the key, and keeps the key across starts", async () => {
    const first = await startManager();
    const key = readFileSync(getDaemonKeyPath(), "utf8");
    expect(key).toMatch(HEX_64);
    await expectReachable();
    await first.stop();

    await startManager();
    expect(readFileSync(getDaemonKeyPath(), "utf8")).toBe(key);
    await expectReachable();
  });

  it("uses a new key once the manager replaces a missing one", async () => {
    const first = await startManager();
    await expectReachable();
    await first.stop();
    unlinkSync(getDaemonKeyPath());

    await startManager();

    expect(readFileSync(getDaemonKeyPath(), "utf8")).toMatch(HEX_64);
    await expectReachable();
  });

  it.each(["", "not a key", "ab".repeat(31), `${"ab".repeat(32)}\n`])("replaces a malformed key file (%j) when the manager starts", async (text) => {
    writeKey(text);

    await startManager();

    expect(readFileSync(getDaemonKeyPath(), "utf8")).toMatch(HEX_64);
    (await connect()).close();
  });

  it("sends only a challenge to a server that answers without the proof, and refuses it naming the pipe", async () => {
    writeKey();
    const squatter = await squat((_frame, socket) => socket.write(encodeFrame({ proof: "ab".repeat(32) })));

    const err = await connect().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ForeignPipeServerError);
    expect((err as Error).message).toContain(path);
    expect(squatter.frames).toEqual([{ challenge: expect.stringMatching(HEX_64) }]);
    await until(() => squatter.closed() === 1);
  });

  it("refuses a server that follows a wrong proof with a broken frame in the same write, without crashing", async () => {
    writeKey();
    const squatter = await squat((_frame, socket) => socket.write(Buffer.concat([encodeFrame({ proof: "ab".repeat(32) }), INVALID_JSON_FRAME])));

    await expect(connect()).rejects.toBeInstanceOf(ForeignPipeServerError);
    await until(() => squatter.closed() === 1);
  });

  it.each([
    ["a proof that isn't a string", { proof: 7 }],
    ["a proof shorter than 32 bytes", { proof: "abcd" }],
    ["a proof that isn't hex", { proof: "zz".repeat(32) }],
    ["a reply to a request", { id: "1", result: {} }],
  ])("refuses a server that answers with %s", async (_label, reply) => {
    writeKey();
    await squat((_frame, socket) => socket.write(encodeFrame(reply)));

    await expect(connect()).rejects.toBeInstanceOf(ForeignPipeServerError);
  });

  it("refuses a server whose answer isn't a valid frame", async () => {
    writeKey();
    await squat((_frame, socket) => socket.write(INVALID_JSON_FRAME));

    await expect(connect()).rejects.toBeInstanceOf(ForeignPipeServerError);
  });

  it("refuses a server when there is no key, sending it nothing", async () => {
    const squatter = await squat();

    const err = await connect().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ForeignPipeServerError);
    expect((err as Error).message).toContain(getDaemonKeyPath());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(squatter.bytes()).toBe(0);
  });

  it("treats a server that closes before the proof as unreachable, not as foreign", async () => {
    writeKey();
    await squat((_frame, socket) => socket.destroy());

    const err = await connect().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ForeignPipeServerError);
    await expect(daemonStatus(path)).resolves.toBeNull();
  });

  it("treats a server that never answers the challenge as unreachable, not as foreign", async () => {
    writeKey();
    await squat();

    const err = await connect(300).catch((e: unknown) => e);

    expect((err as Error).message).toContain("timed out");
    expect(err).not.toBeInstanceOf(ForeignPipeServerError);
    await expect(daemonStatus(path)).resolves.toBeNull();
  });

  it("reports a foreign server from a status probe instead of treating it as no manager", async () => {
    writeKey();
    await squat((_frame, socket) => socket.write(encodeFrame({ proof: "cd".repeat(32) })));

    await expect(daemonStatus(path)).rejects.toBeInstanceOf(ForeignPipeServerError);
  });

  it("refuses a foreign server at once, without launching a manager or stopping the recorded one", async () => {
    await squat();
    const recorded = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", ...DAEMON_LAUNCH_ARGS], { stdio: "ignore" });
    children.push(recorded);
    mkdirSync(dirname(getDaemonPidPath()), { recursive: true });
    writeFileSync(getDaemonPidPath(), `${recorded.pid}\n`);
    const launch = vi.fn();
    const startedAt = Date.now();

    await expect(ensureDaemonRunning({ socketPath: path, launch, _startingDaemonWaitMs: 30_000 })).rejects.toBeInstanceOf(
      ForeignPipeServerError,
    );

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(launch).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(processExists(recorded.pid!)).toBe(true);
  });

  it("closes a connection that sends no challenge without handing it to the manager", async () => {
    const onConnection = vi.fn();
    await startManager({ onConnection, challengeTimeoutMs: 100 });

    const raw = await rawConnection();
    await raw.closed;

    expect(onConnection).not.toHaveBeenCalled();
    expect(raw.received()).toBe(0);
  });

  it.each([
    ["a request", encodeFrame({ id: "1", method: "STATUS" })],
    ["not valid JSON", INVALID_JSON_FRAME],
    ["a request followed by a broken frame in the same write", Buffer.concat([encodeFrame({ id: "1", method: "STATUS" }), INVALID_JSON_FRAME])],
  ])("closes a connection whose first frame is %s, without answering it", async (_label, frame) => {
    const onConnection = vi.fn();
    await startManager({ onConnection, challengeTimeoutMs: 60_000 });

    const raw = await rawConnection();
    raw.socket.write(frame);
    await raw.closed;

    expect(onConnection).not.toHaveBeenCalled();
    expect(raw.received()).toBe(0);
    await expectReachable();
  });
});
