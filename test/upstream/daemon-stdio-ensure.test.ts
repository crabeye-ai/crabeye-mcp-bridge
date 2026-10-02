import { describe, it, expect, vi } from "vitest";

const ensureCalls = vi.hoisted(() => [] as unknown[]);

vi.mock("../../src/daemon/bootstrap.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/daemon/bootstrap.js")>();
  return {
    ...actual,
    ensureDaemonRunning: async (opts: unknown) => {
      ensureCalls.push(opts);
    },
  };
});

const { DaemonStdioClient } = await import("../../src/upstream/daemon-stdio-client.js");

describe("DaemonStdioClient default daemon ensure", () => {
  it("forwards a fresh-attempt request from the respawn path", async () => {
    const client = new DaemonStdioClient({
      name: "notes",
      config: { command: "node", args: ["server.js"] } as never,
      resolvedEnv: {},
      _socketPath: "/tmp/cbe-ensure.sock",
    });
    const ensure = (client as unknown as { _ensureDaemon: (o?: object) => Promise<void> })._ensureDaemon;

    await ensure({ freshAttempt: true });

    expect(ensureCalls).toEqual([{ socketPath: "/tmp/cbe-ensure.sock", freshAttempt: true }]);
  });
});
