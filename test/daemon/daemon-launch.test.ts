import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { execFile, fork, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AWAIT_PREDECESSOR_FLAG, MAX_AWAIT_PREDECESSOR_MS, daemonLaunchEnv, successorReport } from "../../src/daemon/daemon-launch.js";
import { DAEMON_LAUNCH_ARGS } from "../../src/daemon/daemon-identity.js";
import { bundleForSubprocess } from "../_helpers/subprocess-bundle.js";
import { until } from "../_helpers/daemon-fixtures.js";

describe("launching a daemon that waits for the one it replaces", () => {
  let successorScript: string;
  let bridgeScript: string;
  const children: ChildProcess[] = [];

  beforeAll(async () => {
    [successorScript, bridgeScript] = await Promise.all([
      bundleForSubprocess("test/_helpers/subprocess/reporting-successor.ts", "reporting-successor"),
      bundleForSubprocess("test/_helpers/subprocess/launching-bridge.ts", "launching-bridge"),
    ]);
  });

  afterEach(() => {
    for (const child of children.splice(0)) child.kill();
  });

  function forkSuccessor(args: string[]): ChildProcess {
    const child = fork(successorScript, args, { stdio: ["ignore", "pipe", "ignore", "ipc"] });
    children.push(child);
    return child;
  }

  function exitOf(child: ChildProcess): Promise<{ code: number | null; stdout: string }> {
    let stdout = "";
    child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    return new Promise((resolve) => child.once("exit", (code) => resolve({ code, stdout })));
  }

  it("reports a successor waiting for its predecessor, ignores its later reports, and closes the channel", async () => {
    const child = forkSuccessor([]);

    expect(await successorReport(child)).toBe("waiting");
    expect(child.connected).toBe(false);
  });

  it("reports a successor that started with nothing in its way as serving", async () => {
    expect(await successorReport(forkSuccessor(["--serving"]))).toBe("serving");
  });

  it("does not take an unrelated message for a report", async () => {
    expect(await successorReport(forkSuccessor(["--other-message"]), 1_000)).toBe("gone");
  });

  it("reports a successor that exits before reporting as gone, without waiting for the timeout", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(3)"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    children.push(child);
    const startedAt = Date.now();

    expect(await successorReport(child, 10_000)).toBe("gone");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("reports a successor that stays silent as gone once the wait runs out", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    children.push(child);

    expect(await successorReport(child, 200)).toBe("gone");
    expect(child.connected).toBe(false);
  });

  it("keeps a successor running when it reports after the bridge has stopped listening", async () => {
    const child = forkSuccessor(["--after-disconnect"]);
    const exit = exitOf(child);

    child.disconnect();

    expect(await exit).toEqual({ code: 0, stdout: "still running" });
  });

  async function withMarker(run: (marker: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "cbe-launch-"));
    try {
      await run(join(dir, "marker"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  function successorStillRunning(marker: string): Promise<void> {
    return until(async () => (await readFile(marker, "utf-8").catch(() => "")) === "still running", 15_000);
  }

  it("leaves a detached successor running after the bridge that launched it exits", { timeout: 20_000 }, () =>
    withMarker(async (marker) => {
      const bridge = await promisify(execFile)(process.execPath, [bridgeScript, successorScript], {
        env: { ...process.env, SUCCESSOR_MARKER: marker },
      });

      expect(bridge.stdout).toBe("waiting");
      await successorStillRunning(marker);
    }));

  it.skipIf(process.platform === "win32")("keeps a successor running after a signal to the exited bridge's whole process group", { timeout: 20_000 }, () =>
    withMarker(async (marker) => {
      const bridge = spawn(process.execPath, [bridgeScript, successorScript], {
        env: { ...process.env, SUCCESSOR_MARKER: marker, HOLD_UNTIL_STDIN_CLOSES: "1" },
        stdio: ["pipe", "pipe", "ignore"],
        detached: true,
      });
      children.push(bridge);
      let reported = "";
      bridge.stdout!.on("data", (chunk: Buffer) => (reported += chunk.toString()));
      await until(() => reported === "waiting", 10_000);
      expect(bridge.exitCode).toBeNull();

      process.kill(-bridge.pid!, "SIGKILL");

      await successorStillRunning(marker);
    }));
});

describe("the environment a bridge launches the daemon with", () => {
  it("is the bridge's own without NODE_OPTIONS", () => {
    expect(daemonLaunchEnv({ NODE_OPTIONS: "--use-system-ca --tls-keylog=/tmp/keys", PATH: "/bin", SSL_CERT_FILE: "/etc/ca.pem" })).toEqual({
      PATH: "/bin",
      SSL_CERT_FILE: "/etc/ca.pem",
    });
  });
});

describe("the hidden flag that makes a launched daemon wait", () => {
  let cliScript: string;

  beforeAll(async () => {
    cliScript = await bundleForSubprocess("src/index.ts", "cli-await-flag");
  });

  it.each(["-1", "1.5", String(MAX_AWAIT_PREDECESSOR_MS + 1), "abc"])("refuses %s before starting anything", async (value) => {
    const dir = await mkdtemp(join(tmpdir(), "cbe-flag-"));
    try {
      const run = promisify(execFile)(process.execPath, [cliScript, ...DAEMON_LAUNCH_ARGS, AWAIT_PREDECESSOR_FLAG, value], {
        env: { ...process.env, HOME: dir, USERPROFILE: dir, LOCALAPPDATA: dir },
      });

      await expect(run).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining(
          `argument '${value}' is invalid. expected a whole number of milliseconds up to ${MAX_AWAIT_PREDECESSOR_MS}`,
        ),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("what a bridge and the daemon it launches agree on across crabeye versions", () => {
  it("keeps the hidden flag and the report messages a bridge of another version may send or expect", async () => {
    expect(AWAIT_PREDECESSOR_FLAG).toBe("--await-predecessor-ms");
    expect(DAEMON_LAUNCH_ARGS).toEqual(["daemon", "--internal-launch"]);
    const reports = await Promise.all(
      ["awaiting-predecessor", "serving-without-predecessor"].map((message) => {
        const child = spawn(process.execPath, ["-e", `process.send(${JSON.stringify(message)}); setTimeout(() => {}, 1000)`], {
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
        return successorReport(child, 5_000).finally(() => child.kill());
      }),
    );

    expect(reports).toEqual(["waiting", "serving"]);
  });
});
