import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const constructed = vi.hoisted(() => ({ opts: [] as Record<string, unknown>[] }));

vi.mock("../../src/daemon/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/daemon/index.js")>();
  const { EventEmitter } = await import("node:events");
  class RecordingSupervisor extends EventEmitter {
    constructor(opts: Record<string, unknown>) {
      super();
      constructed.opts.push(opts);
    }
  }
  return { ...actual, DaemonLivenessSupervisor: RecordingSupervisor };
});

const { DaemonStdioClient } = await import("../../src/upstream/daemon-stdio-client.js");

describe.skipIf(process.platform === "win32")("DaemonStdioClient daemon files", () => {
  it("gives its liveness supervisor the lock and pidfile that sit next to its socket", () => {
    const socketPath = join("/tmp/cbe-files-example", "manager.sock");
    const client = new DaemonStdioClient({
      name: "local",
      config: { command: "node" } as never,
      resolvedEnv: {},
      _socketPath: socketPath,
      _ensureDaemon: async () => {},
    });

    (client as unknown as { _buildTransport(): unknown })._buildTransport();

    expect(constructed.opts.at(-1)).toMatchObject({
      socketPath,
      lockPath: join("/tmp/cbe-files-example", "manager.lock"),
      pidPath: join("/tmp/cbe-files-example", "manager.pid"),
    });
  });
});
