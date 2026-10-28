import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "../../src/logging/index.js";
import { DaemonStoppedWhileStartingError, ManagerDaemon, type ManagerOptions } from "../../src/daemon/manager.js";
import { netTransport } from "../../src/daemon/net-transport.js";

const hooks: { beforePidWrite?: () => void } = {};

vi.mock("../../src/daemon/pidfile.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/daemon/pidfile.js")>();
  return {
    ...actual,
    writePidFile: async (path: string, pid: number) => {
      hooks.beforePidWrite?.();
      return actual.writePidFile(path, pid);
    },
  };
});

const messages: string[] = [];

function recordingLogger(): Logger {
  const record = (message: string) => void messages.push(message);
  return { debug: record, info: record, warn: record, error: record, setLevel: () => {}, child: () => recordingLogger() };
}

describe.skipIf(process.platform === "win32")("stopping a daemon while it starts", () => {
  let dir: string;
  let manager: ManagerDaemon | undefined;

  afterEach(async () => {
    hooks.beforePidWrite = undefined;
    await manager?.stop(0, "test cleanup");
    manager = undefined;
    await rm(dir, { recursive: true, force: true });
    messages.length = 0;
  });

  async function startable(opts: Partial<ManagerOptions> = {}): Promise<ManagerDaemon> {
    dir = await mkdtemp("/tmp/cbe-fix-");
    manager = new ManagerDaemon({
      socketPath: join(dir, "m.sock"),
      pidPath: join(dir, "m.pid"),
      lockPath: join(dir, "m.lock"),
      idleMs: 60_000,
      transport: netTransport,
      processTrackerPath: join(dir, "processes.json"),
      logger: recordingLogger(),
      ...opts,
    });
    return manager;
  }

  it("surfaces a real start failure that happens while stopping", async () => {
    let releaseServer!: () => void;
    const serverHeld = new Promise<void>((resolve) => (releaseServer = resolve));
    const daemon = await startable({
      transport: {
        ...netTransport,
        createServer: (opts) => {
          const server = netTransport.createServer(opts);
          return {
            address: server.address,
            start: async () => {
              await serverHeld;
              throw new Error("bind exploded");
            },
            stop: () => server.stop(),
            isPublished: () => server.isPublished(),
          };
        },
      },
    });

    const outcome = daemon.start().catch((err: unknown) => err);
    setTimeout(releaseServer, 50);
    await daemon.stop(0, "signal SIGTERM");

    const err = await outcome;
    expect(err).not.toBeInstanceOf(DaemonStoppedWhileStartingError);
    expect(err).toMatchObject({ message: "bind exploded" });
  });

  it("doesn't log serving when stopped while writing its pidfile", async () => {
    const daemon = await startable();
    let stopping: Promise<void> | undefined;
    hooks.beforePidWrite = () => {
      stopping = daemon.stop(0, "signal SIGTERM");
    };

    await daemon.start().catch(() => {});
    await stopping;

    expect(messages).toContain("daemon stopping");
    expect(messages).not.toContain("serving");
  });
});
