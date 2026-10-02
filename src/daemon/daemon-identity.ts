import { readProcessInfo } from "../process/process-utils.js";

export const DAEMON_LAUNCH_ARGS = ["daemon", "--internal-launch"] as const;

const DAEMON_LAUNCH_PATTERN = new RegExp(`(^|\\s)${DAEMON_LAUNCH_ARGS.join("\\s+")}(\\s|$)`);

export function isDaemonCommandLine(cmdline: string): boolean {
  return DAEMON_LAUNCH_PATTERN.test(cmdline);
}

export async function isForeignProcess(pid: number): Promise<boolean> {
  const info = await readProcessInfo(pid);
  if (info === null || info.cmdline.trim() === "") return false;
  return !isDaemonCommandLine(info.cmdline);
}
