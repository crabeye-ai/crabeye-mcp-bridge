import { spawn } from "node:child_process";
import { ensureDaemonRunning } from "../../../src/daemon/bootstrap.js";
import { DAEMON_LAUNCH_ARGS } from "../../../src/daemon/daemon-identity.js";

const [socketPath, cliScript, waitMs] = process.argv.slice(2);

let launches = 0;
const launch = () => {
  launches++;
  const child = spawn(process.execPath, [cliScript!, ...DAEMON_LAUNCH_ARGS], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
};

try {
  await ensureDaemonRunning({ socketPath: socketPath!, launch, _startingDaemonWaitMs: Number(waitMs) });
  process.stdout.write(`ok ${launches}\n`);
} catch (err) {
  process.stdout.write(`error: ${(err as Error).message}\n`);
}
