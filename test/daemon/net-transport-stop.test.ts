import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { netTransport } from "../../src/daemon/net-transport.js";
import { FrameDecoder } from "../../src/daemon/protocol.js";
import { until } from "../_helpers/daemon-fixtures.js";
import { ManagerDaemon } from "../../src/daemon/manager.js";
import type { FrameChannel } from "../../src/daemon/transport.js";

const isWindows = process.platform === "win32";

function peerThatNeverCloses(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path, allowHalfOpen: true });
    socket.on("data", () => {});
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

describe.skipIf(isWindows)("stopping the daemon socket server", () => {
  let dir: string;
  const peers: Socket[] = [];

  beforeEach(async () => {
    dir = await mkdtemp("/tmp/cbe-stop-");
  });

  afterEach(async () => {
    for (const peer of peers.splice(0)) peer.destroy();
    await rm(dir, { recursive: true, force: true });
  });

  it("finishes even when a peer never closes its side of the connection", async () => {
    const path = join(dir, "m.sock");
    const channels: FrameChannel[] = [];
    const server = netTransport.createServer({ path, onConnection: (channel) => channels.push(channel) });
    await server.start();
    const peer = await peerThatNeverCloses(path);
    peers.push(peer);
    await until(() => channels.length === 1);
    for (const channel of channels) channel.close();
    const startedAt = Date.now();

    await server.stop();

    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(peer.destroyed || peer.readableEnded).toBe(true);
  });

  it("still delivers a reply written just before stopping to a peer that reads it a moment later", async () => {
    const path = join(dir, "m.sock");
    const channels: FrameChannel[] = [];
    const server = netTransport.createServer({ path, onConnection: (channel) => channels.push(channel) });
    await server.start();
    const peer = await peerThatNeverCloses(path);
    peers.push(peer);
    peer.pause();
    await until(() => channels.length === 1);
    const reply = { id: "last", result: "x".repeat(4 * 1024 * 1024) };
    for (const channel of channels) {
      channel.send(reply);
      channel.close();
    }

    const stopping = server.stop();
    await new Promise((r) => setTimeout(r, 300));
    const decoder = new FrameDecoder();
    const received = new Promise<unknown>((resolve) => {
      peer.removeAllListeners("data");
      peer.on("data", (chunk: Buffer) => {
        decoder.push(chunk);
        const frame = decoder.next();
        if (frame !== null) resolve(frame);
      });
      peer.once("close", () => resolve("closed before the whole reply arrived"));
    });
    peer.resume();

    expect(await received).toEqual(reply);
    await stopping;
  });

  it("lets the daemon stop while a client never closes its connection", async () => {
    const manager = new ManagerDaemon({
      socketPath: join(dir, "m.sock"),
      pidPath: join(dir, "m.pid"),
      lockPath: join(dir, "m.lock"),
      processTrackerPath: join(dir, "processes.json"),
      idleMs: 60_000,
      transport: netTransport,
    });
    await manager.start();
    peers.push(await peerThatNeverCloses(join(dir, "m.sock")));
    const startedAt = Date.now();

    await manager.stop(0);

    expect(await manager.waitForExit()).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });
});
