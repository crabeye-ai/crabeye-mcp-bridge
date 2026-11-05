import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFrame } from "../../src/daemon/protocol.js";
import { wrapSocket, type FrameChannel } from "../../src/daemon/transport.js";
import { closeServer, INVALID_JSON_FRAME } from "../_helpers/frame-server.js";

describe("framed connections", () => {
  let dir: string;
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await closeServer(server);
    rmSync(dir, { recursive: true, force: true });
  });

  function accept(onChannel: (channel: FrameChannel) => void): Promise<string> {
    dir = mkdtempSync(join(tmpdir(), "cbe-ws-"));
    const path = process.platform === "win32" ? `\\\\.\\pipe\\cbe-ws-${process.pid}-${Date.now()}` : join(dir, "s");
    server = createServer((socket) => onChannel(wrapSocket(socket, path)));
    return new Promise((resolve) => server!.listen(path, () => resolve(path)));
  }

  it("ignores frames that follow in the same write once the channel is closed, broken ones included", async () => {
    const received: unknown[] = [];
    const path = await accept((channel) => {
      channel.on("message", (msg) => {
        received.push(msg);
        channel.close();
      });
    });

    const client = createConnection(path);
    client.on("error", () => {});
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));
    client.write(Buffer.concat([encodeFrame({ first: true }), encodeFrame({ second: true }), INVALID_JSON_FRAME]));
    client.resume();
    await new Promise<void>((resolve) => client.once("close", () => resolve()));

    expect(received).toEqual([{ first: true }]);
  });
});
