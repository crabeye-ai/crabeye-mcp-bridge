import { join, dirname } from "node:path";
import { ManagerDaemon } from "../../../src/daemon/manager.js";
import { netTransport } from "../../../src/daemon/net-transport.js";

const socketPath = process.argv.at(-1)!;
const dir = dirname(socketPath);
const manager = new ManagerDaemon({
  socketPath,
  pidPath: join(dir, "m.pid"),
  lockPath: join(dir, "m.lock"),
  idleMs: 60_000,
  transport: netTransport,
  processTrackerPath: join(dir, "processes.json"),
});

try {
  await manager.start();
  process.stdout.write("serving\n");
  process.once("SIGTERM", () => void manager.stop(0).then(() => process.exit(0)));
} catch (err) {
  process.stdout.write(`lost: ${(err as Error).name}\n`);
  process.exit(0);
}
