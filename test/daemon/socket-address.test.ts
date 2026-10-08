import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getconfReplies = vi.hoisted((): Array<Error | string> => []);

vi.mock("node:child_process", async (importOriginal) => {
  const { promisify } = await import("node:util");
  const actual = await importOriginal<typeof import("node:child_process")>();
  const realExecFileAsync = promisify(actual.execFile) as (file: string, ...rest: unknown[]) => Promise<unknown>;
  const scripted = (reply: Error | string): Promise<unknown> =>
    reply instanceof Error ? Promise.reject(reply) : Promise.resolve({ stdout: reply, stderr: "" });
  return {
    ...actual,
    execFile: Object.assign(actual.execFile.bind(null), {
      [promisify.custom]: (file: string, ...rest: unknown[]) => {
        const reply = file === "/usr/bin/getconf" ? getconfReplies.shift() : undefined;
        return reply === undefined ? realExecFileAsync(file, ...rest) : scripted(reply);
      },
    }),
  };
});
import { createServer } from "node:net";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  SOCKET_PATH_LIMIT,
  SocketAliasRefusedError,
  SocketPathTooLongError,
  socketAddress,
} from "../../src/daemon/socket-address.js";

const pathOfBytes = (dir: string, bytes: number): string => join(dir, "s".repeat(bytes - dir.length - 1));
const unavailable = new RegExp(`over the ${SOCKET_PATH_LIMIT}-byte limit, and no private temporary directory is available`);

describe.skipIf(process.platform === "win32")("socketAddress", () => {
  let root: string;
  let privateDir: string;
  let runDir: string;

  beforeEach(() => {
    root = mkdtempSync("/tmp/cbe-addr-");
    privateDir = join(root, "p");
    mkdirSync(privateDir, { mode: 0o700 });
    runDir = join(root, "home", "r".repeat(120), ".crabeye", "run");
    mkdirSync(runDir, { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const longSocket = (): string => join(runDir, "manager.sock");
  const socketOfBytes = (bytes: number): string => {
    const dir = join(root, "d".repeat(bytes - root.length - "/manager.sock".length - 1));
    mkdirSync(dir);
    return join(dir, "manager.sock");
  };
  const aliases = (): string[] => readdirSync(privateDir).filter((name) => name.startsWith("crabeye-"));

  it.each([SOCKET_PATH_LIMIT - 1, SOCKET_PATH_LIMIT])("returns a %i-byte path unchanged without touching the private dir", async (bytes) => {
    const path = pathOfBytes(root, bytes);
    expect(await socketAddress(path, { privateDir: join(root, "missing") })).toBe(path);
  });

  it("can bind a socket at exactly the limit", async () => {
    const path = pathOfBytes(root, SOCKET_PATH_LIMIT);
    const server = createServer();
    await new Promise<void>((resolve, reject) => server.once("error", reject).listen(path, resolve));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("aliases a path one byte over the limit", async () => {
    const path = socketOfBytes(SOCKET_PATH_LIMIT + 1);
    expect(Buffer.byteLength(path)).toBe(SOCKET_PATH_LIMIT + 1);
    const address = await socketAddress(path, { privateDir });
    expect(address).not.toBe(path);
    expect(Buffer.byteLength(address)).toBeLessThanOrEqual(SOCKET_PATH_LIMIT);
  });

  it("reaches an over-long path through a symlink to its directory", async () => {
    const address = await socketAddress(longSocket(), { privateDir });

    const [alias] = aliases();
    expect(address).toBe(join(privateDir, alias!, "manager.sock"));
    expect(lstatSync(join(privateDir, alias!)).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(privateDir, alias!))).toBe(runDir);
  });

  it("reuses a correct alias", async () => {
    const first = await socketAddress(longSocket(), { privateDir });
    const inode = lstatSync(join(privateDir, aliases()[0]!)).ino;

    expect(await socketAddress(longSocket(), { privateDir })).toBe(first);
    expect(lstatSync(join(privateDir, aliases()[0]!)).ino).toBe(inode);
  });

  it("repoints an alias of ours that points elsewhere", async () => {
    await socketAddress(longSocket(), { privateDir });
    const alias = join(privateDir, aliases()[0]!);
    rmSync(alias);
    symlinkSync(root, alias);

    await socketAddress(longSocket(), { privateDir });

    expect(readlinkSync(alias)).toBe(runDir);
  });

  it.each([
    ["a regular file", (alias: string) => writeFileSync(alias, "")],
    ["a directory", (alias: string) => mkdirSync(alias)],
  ])("refuses an alias that is %s", async (_label, plant) => {
    await socketAddress(longSocket(), { privateDir });
    const alias = join(privateDir, aliases()[0]!);
    rmSync(alias);
    plant(alias);

    const attempt = socketAddress(longSocket(), { privateDir });

    await expect(attempt).rejects.toBeInstanceOf(SocketAliasRefusedError);
    await expect(attempt).rejects.toThrow(`refusing to use ${alias}`);
  });

  it("recreates an alias that was deleted", async () => {
    const address = await socketAddress(longSocket(), { privateDir });
    rmSync(join(privateDir, aliases()[0]!));

    expect(await socketAddress(longSocket(), { privateDir })).toBe(address);
    expect(aliases()).toHaveLength(1);
  });

  it("gives each run dir its own alias", async () => {
    const otherRunDir = join(root, "other", "o".repeat(120), ".crabeye", "run");
    mkdirSync(otherRunDir, { recursive: true });

    const first = await socketAddress(longSocket(), { privateDir });
    const second = await socketAddress(join(otherRunDir, "manager.sock"), { privateDir });

    expect(first).not.toBe(second);
    expect(aliases()).toHaveLength(2);
  });

  it("measures the path in bytes", async () => {
    const multiByteRunDir = join(root, "é".repeat(40));
    mkdirSync(multiByteRunDir);
    const path = join(multiByteRunDir, "manager.sock");
    expect(path.length).toBeLessThanOrEqual(SOCKET_PATH_LIMIT);

    expect(await socketAddress(path, { privateDir })).not.toBe(path);
  });

  it("leaves one alias when many callers race to create it", async () => {
    const addresses = await Promise.all(Array.from({ length: 8 }, () => socketAddress(longSocket(), { privateDir })));

    expect(new Set(addresses).size).toBe(1);
    expect(readdirSync(privateDir)).toEqual(aliases());
    expect(aliases()).toHaveLength(1);
  });

  describe("picks the private dir by platform", () => {
    let otherDir: string;

    beforeEach(() => {
      otherDir = join(root, "other-private");
      mkdirSync(otherDir, { mode: 0o700 });
    });

    it.each([
      ["darwin", "TMPDIR", "XDG_RUNTIME_DIR"],
      ["linux", "XDG_RUNTIME_DIR", "TMPDIR"],
    ] as const)("on %s it uses $%s", async (platform, used, ignored) => {
      vi.stubEnv(used, privateDir);
      vi.stubEnv(ignored, otherDir);

      expect(await socketAddress(longSocket(), { platform })).toMatch(new RegExp(`^${privateDir}/crabeye-`));
      expect(readdirSync(otherDir)).toEqual([]);
    });
  });

  describe("without the private dir variable in the environment", () => {
    const created: string[] = [];

    afterEach(() => {
      for (const alias of created.splice(0)) rmSync(alias, { force: true });
    });

    async function addressOutsideTest(): Promise<string> {
      const address = await socketAddress(longSocket());
      created.push(dirname(address));
      return address;
    }

    it.skipIf(process.platform !== "darwin")("asks macOS when $TMPDIR is set but not private", async () => {
      vi.stubEnv("TMPDIR", "/tmp");
      const address = await addressOutsideTest();
      expect(realpathSync(dirname(address))).toBe(realpathSync(runDir));
    });

    it.skipIf(process.platform !== "darwin")("asks macOS for the user's temporary directory", async () => {
      vi.stubEnv("TMPDIR", "");
      const address = await addressOutsideTest();
      expect(realpathSync(dirname(address))).toBe(realpathSync(runDir));
    });

    it.skipIf(process.platform !== "linux" || !existsSync(`/run/user/${process.getuid?.()}`))(
      "falls back to /run/user/<uid> on Linux",
      async () => {
        vi.stubEnv("XDG_RUNTIME_DIR", "");
        expect(await addressOutsideTest()).toMatch(new RegExp(`^/run/user/${process.getuid!()}/crabeye-`));
      },
    );
  });

  it("asks macOS again after a failed lookup instead of caching the failure", async () => {
    vi.resetModules();
    const fresh = await import("../../src/daemon/socket-address.js");
    vi.stubEnv("TMPDIR", "");
    getconfReplies.push(new Error("getconf timed out"), `${privateDir}/\n`);

    await expect(fresh.socketAddress(longSocket(), { platform: "darwin" })).rejects.toBeInstanceOf(
      fresh.SocketPathTooLongError,
    );
    expect(await fresh.socketAddress(longSocket(), { platform: "darwin" })).toMatch(new RegExp(`^${privateDir}/crabeye-`));
    expect(getconfReplies).toEqual([]);
  });

  it("leaves Windows pipe names alone", async () => {
    const pipe = `\\\\.\\pipe\\${"p".repeat(200)}`;
    expect(await socketAddress(pipe, { platform: "win32" })).toBe(pipe);
  });

  describe("fails fast when no usable private dir exists", () => {
    it.each([
      ["the private dir is missing", () => join(root, "missing")],
      ["the private dir is a file", () => {
        writeFileSync(join(root, "file"), "", { mode: 0o600 });
        return join(root, "file");
      }],
      ["the group can read the private dir", () => {
        chmodSync(privateDir, 0o750);
        return privateDir;
      }],
      ["others can read the private dir", () => {
        chmodSync(privateDir, 0o705);
        return privateDir;
      }],
    ])("when %s", async (_label, dir) => {
      const attempt = socketAddress(longSocket(), { privateDir: dir() });

      await expect(attempt).rejects.toBeInstanceOf(SocketPathTooLongError);
      await expect(attempt).rejects.toThrow(unavailable);
    });

    it("on a platform without a private dir", async () => {
      await expect(socketAddress(longSocket(), { platform: "freebsd" })).rejects.toThrow(unavailable);
    });

    it("when the private dir belongs to another user", async () => {
      const attempt = socketAddress(longSocket(), { privateDir, uid: process.getuid!() + 1 });

      await expect(attempt).rejects.toBeInstanceOf(SocketPathTooLongError);
      expect(aliases()).toEqual([]);
    });

    it("when the alias itself would be too long", async () => {
      const deepPrivateDir = join(root, "d".repeat(90));
      mkdirSync(deepPrivateDir, { mode: 0o700 });

      await expect(socketAddress(longSocket(), { privateDir: deepPrivateDir })).rejects.toThrow(
        /its short alias .*crabeye-[0-9a-f]{12}\/manager\.sock is too long as well; use a shorter home directory/,
      );
      expect(readdirSync(deepPrivateDir)).toEqual([]);
    });
  });
});
