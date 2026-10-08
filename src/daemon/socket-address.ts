import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, readlink, rename, stat, symlink, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { DAEMON_BASE } from "../constants.js";

export const SOCKET_PATH_LIMIT = 100;
const ALIAS_HASH_LENGTH = 12;
const GETCONF = "/usr/bin/getconf";
const GETCONF_TIMEOUT_MS = 1_000;
const execFileAsync = promisify(execFile);

type DirSource = () => string | undefined | Promise<string | undefined>;

let darwinTempDir: Promise<string | undefined> | undefined;

export class SocketPathTooLongError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(
      `daemon socket path ${path} is ${Buffer.byteLength(path)} bytes, over the ${SOCKET_PATH_LIMIT}-byte limit, ` +
        `and ${reason}; use a shorter home directory`,
    );
    this.name = "SocketPathTooLongError";
  }
}

export class SocketAliasRefusedError extends Error {
  constructor(readonly alias: string) {
    super(`refusing to use ${alias} as the daemon socket alias: it is not a symlink you own; remove it`);
    this.name = "SocketAliasRefusedError";
  }
}

export function isSocketAddressError(err: unknown): err is SocketPathTooLongError | SocketAliasRefusedError {
  return err instanceof SocketPathTooLongError || err instanceof SocketAliasRefusedError;
}

export interface SocketAddressOptions {
  platform?: NodeJS.Platform;
  privateDir?: string;
  uid?: number;
}

export async function socketAddress(path: string, opts: SocketAddressOptions = {}): Promise<string> {
  const platform = opts.platform ?? process.platform;
  if (platform === "win32" || fitsLimit(path)) return path;
  const uid = opts.uid ?? process.getuid!();
  const sources = opts.privateDir === undefined ? privateDirSources(platform, uid) : [() => opts.privateDir];
  const privateDir = await firstPrivateDir(sources, uid);
  if (privateDir === undefined) {
    throw new SocketPathTooLongError(path, "no private temporary directory is available for a short alias");
  }
  const runDir = dirname(path);
  const alias = join(privateDir, aliasName(runDir));
  const address = join(alias, basename(path));
  if (!fitsLimit(address)) throw new SocketPathTooLongError(path, `its short alias ${address} is too long as well`);
  await ensureAlias(alias, runDir, uid);
  return address;
}

function privateDirSources(platform: NodeJS.Platform, uid: number): DirSource[] {
  if (platform === "darwin") return [() => process.env.TMPDIR, darwinUserTempDir];
  if (platform === "linux") return [() => process.env.XDG_RUNTIME_DIR, () => `/run/user/${uid}`];
  return [];
}

async function firstPrivateDir(sources: DirSource[], uid: number): Promise<string | undefined> {
  for (const source of sources) {
    const dir = await source();
    if (dir && (await isPrivateDir(dir, uid))) return dir;
  }
  return undefined;
}

function darwinUserTempDir(): Promise<string | undefined> {
  darwinTempDir ??= execFileAsync(GETCONF, ["DARWIN_USER_TEMP_DIR"], { timeout: GETCONF_TIMEOUT_MS }).then(
    ({ stdout }) => stdout.trim() || undefined,
    () => {
      darwinTempDir = undefined;
      return undefined;
    },
  );
  return darwinTempDir;
}

async function isPrivateDir(dir: string, uid: number): Promise<boolean> {
  try {
    const st = await stat(dir);
    return st.isDirectory() && st.uid === uid && (st.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function aliasName(runDir: string): string {
  const digest = createHash("sha256").update(runDir).digest("hex").slice(0, ALIAS_HASH_LENGTH);
  return `${DAEMON_BASE}-${digest}`;
}

async function ensureAlias(alias: string, target: string, uid: number): Promise<void> {
  const current = await lstat(alias).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (current !== null) {
    if (!current.isSymbolicLink() || current.uid !== uid) throw new SocketAliasRefusedError(alias);
    if ((await readlink(alias)) === target) return;
  }
  const staged = `${alias}.${randomBytes(4).toString("hex")}`;
  await symlink(target, staged);
  try {
    await rename(staged, alias);
  } catch (err) {
    await unlink(staged).catch(() => {});
    throw err;
  }
}

function fitsLimit(path: string): boolean {
  return Buffer.byteLength(path) <= SOCKET_PATH_LIMIT;
}
