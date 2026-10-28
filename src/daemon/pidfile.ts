import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile, unlink } from "node:fs/promises";
import { parsePid } from "../process/process-utils.js";

const isWindows = process.platform === "win32";

export async function readPidFile(path: string): Promise<number | null> {
  try {
    return parsePid(await readFile(path, "utf-8"));
  } catch {
    return null;
  }
}

export async function writePidFile(path: string, pid: number): Promise<void> {
  const flags =
    fsConstants.O_CREAT |
    fsConstants.O_EXCL |
    fsConstants.O_WRONLY |
    (isWindows ? 0 : fsConstants.O_NOFOLLOW);
  let fh;
  try {
    fh = await open(path, flags, 0o600);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      try {
        const st = await lstat(path);
        if (st.isSymbolicLink()) {
          throw new Error(`refusing to write pidfile: ${path} is a symlink`);
        }
      } catch (lstatErr) {
        if ((lstatErr as NodeJS.ErrnoException).code !== "ENOENT") throw lstatErr;
      }
      await unlink(path).catch(() => {});
      fh = await open(path, flags, 0o600);
    } else {
      throw err;
    }
  }
  try {
    await fh.writeFile(`${pid}\n`, "utf-8");
  } finally {
    await fh.close();
  }
}
