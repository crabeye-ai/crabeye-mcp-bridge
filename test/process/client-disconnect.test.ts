import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { onClientDisconnect } from "../../src/process/client-disconnect.js";

function streams() {
  const input = new PassThrough({ autoDestroy: false });
  const output = new PassThrough();
  const disconnected = vi.fn();
  onClientDisconnect(input, output, disconnected);
  input.resume();
  return { input, output, disconnected };
}

describe("onClientDisconnect", () => {
  it("fires when the client closes its end of stdin", async () => {
    const { input, disconnected } = streams();

    input.end();
    await new Promise((r) => setImmediate(r));

    expect(disconnected).toHaveBeenCalled();
  });

  it("fires when stdin is destroyed without ending", async () => {
    const { input, disconnected } = streams();

    input.destroy();
    await new Promise((r) => setImmediate(r));

    expect(disconnected).toHaveBeenCalled();
  });

  it("fires when writing to the client fails", () => {
    const { output, disconnected } = streams();

    output.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));

    expect(disconnected).toHaveBeenCalled();
  });

  it("stays quiet while the client is connected and sending", async () => {
    const { input, disconnected } = streams();

    input.write('{"jsonrpc":"2.0","method":"ping","id":1}\n');
    await new Promise((r) => setImmediate(r));

    expect(disconnected).not.toHaveBeenCalled();
  });
});
