import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/process/process-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/process/process-utils.js")>()),
  readProcessInfo: async () => null,
}));

const { DaemonUnresponsiveError, ensureDaemonRunning } = await import("../../src/daemon/bootstrap.js");
const { processExists } = await import("../../src/process/process-utils.js");

const SILENT_SERVER = `require("node:net").createServer(() => {}).listen(process.argv[1]);`;

describe.skipIf(process.platform === "win32")("ensureDaemonRunning when the recorded process cannot be identified", { timeout: 60_000 }, () => {
  let dir: string;
  const children: ChildProcess[] = [];

  beforeEach(async () => {
    dir = await mkdtemp("/tmp/cbe-bootu-");
    vi.stubEnv("HOME", dir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const child of children.splice(0)) child.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  });

  it("leaves it running, says how to recover, and frees the recovery guard", async () => {
    const socketPath = join(dir, "manager.sock");
    const lockPath = join(dir, "manager.lock");
    const unidentified = spawn(process.execPath, ["-e", SILENT_SERVER, socketPath], { stdio: "ignore" });
    children.push(unidentified);
    await vi.waitFor(() => stat(socketPath), { timeout: 5_000 });
    await writeFile(lockPath, `${unidentified.pid}\ntoken\n`);
    let launches = 0;

    const attempt = ensureDaemonRunning({ socketPath, _startingDaemonWaitMs: 1_000, launch: () => launches++ });

    await expect(attempt).rejects.toBeInstanceOf(DaemonUnresponsiveError);
    await expect(attempt).rejects.toMatchObject({ reason: "unconfirmed", pid: unidentified.pid });
    await expect(attempt).rejects.toThrow(/crabeye-mcp-bridge daemon stop/);
    expect(processExists(unidentified.pid!)).toBe(true);
    expect(launches).toBe(0);
    await expect(stat(`${lockPath}.recover`)).rejects.toThrow();
  });
});
