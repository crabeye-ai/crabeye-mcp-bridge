import { acquireLock, LockBusyError } from "../../../src/daemon/lockfile.js";

const [lockPath] = process.argv.slice(2);

try {
  const lock = await acquireLock(lockPath!);
  process.stdout.write("held\n");
  process.stdin.resume();
  process.stdin.once("end", () => void lock.release().then(() => process.exit(0)));
} catch (err) {
  process.stdout.write(err instanceof LockBusyError ? "busy\n" : `error: ${(err as Error).message}\n`);
}
