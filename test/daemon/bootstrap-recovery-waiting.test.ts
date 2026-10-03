import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const identityReads = vi.hoisted(() => ({ count: 0 }));

vi.mock("../../src/process/process-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/process/process-utils.js")>();
  return {
    ...actual,
    readProcessInfo: async (pid: number) => {
      identityReads.count++;
      return actual.readProcessInfo(pid);
    },
  };
});

const { DaemonUnreachableError, ensureDaemonRunning } = await import("../../src/daemon/bootstrap.js");
const { DAEMON_LAUNCH_ARGS } = await import("../../src/daemon/daemon-identity.js");

const SILENT_SERVER = `require("node:net").createServer(() => {}).listen(process.argv[1]);`;

describe.skipIf(process.platform === "win32")("a bridge waiting on another bridge's recovery", { timeout: 60_000 }, () => {
  let dir: string;
  const children: ChildProcess[] = [];

  beforeEach(async () => {
    dir = await mkdtemp("/tmp/cbe-bootw-");
    vi.stubEnv("HOME", dir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const child of children.splice(0)) child.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  });

  it("stops inspecting processes while the other bridge recovers, then launches once it is done", async () => {
    const socketPath = join(dir, "manager.sock");
    const lockPath = join(dir, "manager.lock");
    const wedged = spawn(process.execPath, ["-e", SILENT_SERVER, socketPath, ...DAEMON_LAUNCH_ARGS], { stdio: "ignore" });
    const otherBridge = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { stdio: "ignore" });
    children.push(wedged, otherBridge);
    await vi.waitFor(() => stat(socketPath), { timeout: 5_000 });
    await writeFile(lockPath, `${wedged.pid}\ntoken\n`);
    let launches = 0;

    const attempt = ensureDaemonRunning({ socketPath, _startingDaemonWaitMs: 400, launch: () => launches++ });
    await vi.waitFor(() => expect(identityReads.count).toBeGreaterThan(0), { timeout: 10_000 });
    await writeFile(`${lockPath}.recover`, `${otherBridge.pid}\nrecovering\n`);
    await new Promise((r) => setTimeout(r, 2_500));
    const readsWhileWaiting = identityReads.count;
    await new Promise((r) => setTimeout(r, 4_000));

    expect(identityReads.count).toBe(readsWhileWaiting);
    expect(launches).toBe(0);

    wedged.kill("SIGKILL");
    await unlink(`${lockPath}.recover`);
    await expect(attempt).rejects.toBeInstanceOf(DaemonUnreachableError);
    expect(launches).toBe(1);
  });
});
