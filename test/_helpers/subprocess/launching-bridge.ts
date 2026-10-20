import { detachedDaemonLauncher } from "../../../src/daemon/daemon-launch.js";

process.env.LAUNCHING_BRIDGE_PID = String(process.pid);
const launch = await detachedDaemonLauncher(process.argv[2]);
process.stdout.write(String(await launch({ awaitPredecessorMs: 1_000 })));
if (process.env.HOLD_UNTIL_STDIN_CLOSES === "1") process.stdin.resume().once("end", () => process.exit(0));
