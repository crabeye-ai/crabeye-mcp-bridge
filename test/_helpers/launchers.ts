import type { DaemonLauncher, LaunchOptions, LaunchOutcome } from "../../src/daemon/daemon-launch.js";

/** A launcher that starts nothing, records each call's options, and resolves `outcome`. */
export function countingLauncher(outcome: LaunchOutcome = "launched"): { launch: DaemonLauncher; calls: LaunchOptions[] } {
  const calls: LaunchOptions[] = [];
  return {
    calls,
    launch: async (opts) => {
      calls.push(opts);
      return outcome;
    },
  };
}
