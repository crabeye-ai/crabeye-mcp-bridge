import { describe, it, expect, afterAll, vi } from "vitest";

const realPlatform = process.platform;
Object.defineProperty(process, "platform", { value: "win32" });

vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  return {
    ...actual,
    createServer: (...args: Parameters<typeof actual.createServer>) => {
      const server = actual.createServer(...args);
      server.listen = function listen(this: typeof server) {
        queueMicrotask(() =>
          this.emit("error", Object.assign(new Error("address in use"), { code: "EADDRINUSE" })),
        );
        return this;
      } as typeof server.listen;
      return server;
    },
  };
});

const { netTransport } = await import("../../src/daemon/net-transport.js");
const { SocketInUseError } = await import("../../src/daemon/transport.js");

describe("daemon pipe on Windows", () => {
  afterAll(() => {
    Object.defineProperty(process, "platform", { value: realPlatform });
  });

  it("reports a pipe another daemon already owns as in use", async () => {
    const server = netTransport.createServer({
      path: "\\\\.\\pipe\\crabeye-test",
      onConnection: () => {},
    });

    await expect(server.start()).rejects.toBeInstanceOf(SocketInUseError);
  });
});
