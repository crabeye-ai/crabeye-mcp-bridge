import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isServing, netTransport } from "../../src/daemon/net-transport.js";
import { ensureDaemonRunning, isDaemonReachable } from "../../src/daemon/bootstrap.js";
import {
  SOCKET_PATH_LIMIT,
  SocketAliasRefusedError,
  SocketPathTooLongError,
  socketAddress,
} from "../../src/daemon/socket-address.js";
import { DAEMON_LAUNCH_ARGS } from "../../src/daemon/daemon-identity.js";
import { getDaemonSocketPath } from "../../src/daemon/paths.js";
import { runDaemonCommand, runRestartUpstream } from "../../src/commands/daemon.js";
import type { DaemonServer } from "../../src/daemon/transport.js";

vi.mock("node:child_process", async (importOriginal) => {
  const { promisify } = await import("node:util");
  const actual = await importOriginal<typeof import("node:child_process")>();
  const realExecFileAsync = promisify(actual.execFile) as (file: string, ...rest: unknown[]) => Promise<unknown>;
  return {
    ...actual,
    execFile: Object.assign(actual.execFile.bind(null), {
      [promisify.custom]: (file: string, ...rest: unknown[]) =>
        file === "/usr/bin/getconf"
          ? Promise.reject(new Error("getconf is not available in this test"))
          : realExecFileAsync(file, ...rest),
    }),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: (path: string) =>
      path.startsWith("/run/user/") ? Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })) : actual.stat(path),
  };
});

describe.skipIf(process.platform === "win32")("daemon sockets beyond the path limit", () => {
  let root: string;
  let privateDir: string;
  let runDir: string;
  let server: DaemonServer | null;
  let children: ChildProcess[];

  beforeEach(() => {
    root = mkdtempSync("/tmp/cbe-alias-");
    privateDir = join(root, "p");
    mkdirSync(privateDir, { mode: 0o700 });
    runDir = join(root, "home", "h".repeat(120), ".crabeye", "run");
    mkdirSync(join(runDir, ".."), { recursive: true });
    vi.stubEnv("TMPDIR", privateDir);
    vi.stubEnv("XDG_RUNTIME_DIR", privateDir);
    server = null;
    children = [];
  });

  afterEach(async () => {
    try {
      await server?.stop();
    } finally {
      for (const child of children) child.kill("SIGKILL");
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });

  const tooLong = new RegExp(`over the ${SOCKET_PATH_LIMIT}-byte limit, and no private temporary directory is available`);
  const socketPath = (): string => join(runDir, "manager.sock");
  const alias = (): string => join(privateDir, readdirSync(privateDir).find((name) => name.startsWith("crabeye-"))!);

  function useTempHome(home: string): void {
    vi.stubEnv("HOME", home);
    if (!getDaemonSocketPath().startsWith(`${root}/`)) {
      throw new Error(`refusing to run a daemon command: HOME did not reach the daemon paths (${getDaemonSocketPath()})`);
    }
  }

  function capture(stream: NodeJS.WriteStream): () => string {
    let out = "";
    vi.spyOn(stream, "write").mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });
    return () => out;
  }

  function recordLiveDaemon(): ChildProcess {
    mkdirSync(runDir, { recursive: true });
    const recorded = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)", ...DAEMON_LAUNCH_ARGS], { stdio: "ignore" });
    children.push(recorded);
    writeFileSync(join(runDir, "manager.lock"), `${recorded.pid}\ntoken\n`);
    return recorded;
  }

  async function startServer(): Promise<void> {
    server = netTransport.createServer({ path: socketPath(), onConnection: () => {} });
    await server.start();
  }

  const unusableAddress = [
    ["no private dir is usable", SocketPathTooLongError, tooLong, async () => chmodSync(privateDir, 0o755)],
    [
      "the alias is refused",
      SocketAliasRefusedError,
      /refusing to use .* as the daemon socket alias/,
      async () => {
        await socketAddress(socketPath());
        const planted = alias();
        rmSync(planted);
        writeFileSync(planted, "");
      },
    ],
  ] as const;

  it("serves through the alias with the socket file in the real run dir", async () => {
    await startServer();

    expect(lstatSync(socketPath()).isSocket()).toBe(true);
    expect(await isServing(socketPath())).toBe(true);
    const channel = await netTransport.connect({ path: socketPath() });
    expect(channel.remote).toBe(socketPath());
    channel.close();
  });

  it("reports nothing serving when no daemon listens behind the alias", async () => {
    mkdirSync(runDir, { recursive: true });

    expect(await isServing(socketPath())).toBe(false);
  });

  it("keeps serving and reconnects after the alias is deleted", async () => {
    await startServer();
    rmSync(alias());

    const channel = await netTransport.connect({ path: socketPath() });
    channel.close();
    expect(lstatSync(alias()).isSymbolicLink()).toBe(true);
    expect(await server!.isPublished()).toBe(true);
  });

  it("still refuses a run dir that is a symlink", async () => {
    const realRunDir = join(root, "elsewhere", "e".repeat(120));
    mkdirSync(realRunDir, { recursive: true });
    symlinkSync(realRunDir, runDir);

    server = netTransport.createServer({ path: socketPath(), onConnection: () => {} });

    await expect(server.start()).rejects.toThrow(/symlinked daemon run dir/);
  });

  it("names the real socket path when nothing listens behind the alias", async () => {
    mkdirSync(runDir, { recursive: true });

    const attempt = netTransport.connect({ path: socketPath() });

    await expect(attempt).rejects.toThrow(/ENOENT|ECONNREFUSED/);
    await expect(attempt).rejects.toThrow(socketPath());
    await expect(attempt).rejects.not.toThrow(privateDir);
  });

  it.each(unusableAddress)("fails the daemon start at once, without launching, when %s", async (_label, type, _reason, make) => {
    await make();
    const launch = vi.fn();
    const startedAt = Date.now();

    await expect(ensureDaemonRunning({ socketPath: socketPath(), launch })).rejects.toBeInstanceOf(type);

    expect(launch).not.toHaveBeenCalled();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("fails at once instead of waiting out a recorded live daemon it cannot reach", async () => {
    const recorded = recordLiveDaemon();
    chmodSync(privateDir, 0o755);
    const launch = vi.fn();
    const startedAt = Date.now();

    await expect(
      ensureDaemonRunning({ socketPath: socketPath(), launch, _startingDaemonWaitMs: 30_000 }),
    ).rejects.toBeInstanceOf(SocketPathTooLongError);

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(launch).not.toHaveBeenCalled();
    expect(recorded.exitCode).toBeNull();
    expect(recorded.signalCode).toBeNull();
  });

  it.each(unusableAddress)("reports why a daemon is unreachable when %s", async (_label, type, _reason, make) => {
    await make();

    await expect(isDaemonReachable(socketPath())).rejects.toBeInstanceOf(type);
  });

  it.each(unusableAddress)("makes `daemon restart-upstream` report why when %s", async (_label, _type, reason, make) => {
    await make();
    const stderr = capture(process.stderr);

    expect(await runRestartUpstream({ all: true, _socketPath: socketPath() })).toBe(1);
    expect(stderr()).toMatch(reason);
    expect(stderr()).not.toMatch(/not running/);
  });

  it("makes `daemon start` exit non-zero with the reason", async () => {
    useTempHome(join(runDir, "..", ".."));
    chmodSync(privateDir, 0o755);
    const stderr = capture(process.stderr);

    expect(await runDaemonCommand("start")).toBe(1);
    expect(stderr()).toMatch(tooLong);
    expect(stderr()).not.toMatch(/something accepts connections/);
  });

  it("makes `daemon status` exit non-zero with the reason", async () => {
    useTempHome(join(runDir, "..", ".."));
    chmodSync(privateDir, 0o755);
    const stderr = capture(process.stderr);
    const stdout = capture(process.stdout);

    expect(await runDaemonCommand("status")).toBe(1);
    expect(stderr()).toMatch(tooLong);
    expect(stdout()).toBe("");
  });

  it("keeps `daemon status` reporting a stopped daemon when the address is fine", async () => {
    useTempHome(join(root, "short-home"));
    const stderr = capture(process.stderr);
    const stdout = capture(process.stdout);

    expect(await runDaemonCommand("status")).toBe(0);
    expect(JSON.parse(stdout())).toEqual({ running: false });
    expect(stderr()).toBe("");
  });

  it("lets `daemon stop` still stop the recorded daemon, reporting why it could not ask it to exit", async () => {
    useTempHome(join(runDir, "..", ".."));
    const recorded = recordLiveDaemon();
    const exited = new Promise((resolve) => recorded.once("exit", resolve));
    chmodSync(privateDir, 0o755);
    const stderr = capture(process.stderr);

    expect(await runDaemonCommand("stop")).toBe(0);
    await exited;
    expect(stderr()).toMatch(tooLong);
  });

  it("refuses to start a daemon server when no alias is possible", async () => {
    chmodSync(privateDir, 0o755);

    server = netTransport.createServer({ path: socketPath(), onConnection: () => {} });

    await expect(server.start()).rejects.toBeInstanceOf(SocketPathTooLongError);
    expect(existsSync(runDir)).toBe(false);
  });
});
