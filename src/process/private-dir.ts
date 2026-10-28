import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { chmod, lstat, mkdir } from "node:fs/promises";

const isWindows = process.platform === "win32";

export async function ensurePrivateDir(dir: string, description: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (isWindows) return;
  if ((await lstat(dir)).isSymbolicLink()) throw symlinkedDirError(dir, description);
  await chmod(dir, 0o700);
}

export function ensurePrivateDirSync(dir: string, description: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (isWindows) return;
  if (lstatSync(dir).isSymbolicLink()) throw symlinkedDirError(dir, description);
  chmodSync(dir, 0o700);
}

function symlinkedDirError(dir: string, description: string): Error {
  return new Error(`refusing to use symlinked ${description}: ${dir}`);
}
