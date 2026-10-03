import { UPSTREAM_MARKER_ENV } from "../constants.js";
import { parsePid, readParentPid } from "../process/process-utils.js";

const MAX_ANCESTRY_DEPTH = 16;

export async function launchedByAnotherBridge(
  env: NodeJS.ProcessEnv = process.env,
  parentOf: (pid: number) => Promise<number | null> = readParentPid,
  startFrom: number = process.ppid,
): Promise<boolean> {
  const daemonPid = parsePid(env[UPSTREAM_MARKER_ENV] ?? "");
  if (daemonPid === null || daemonPid === 1) return false;
  let pid: number | null = startFrom;
  for (let depth = 0; pid !== null && pid > 1 && depth < MAX_ANCESTRY_DEPTH; depth++) {
    if (pid === daemonPid) return true;
    pid = await parentOf(pid);
  }
  return false;
}
