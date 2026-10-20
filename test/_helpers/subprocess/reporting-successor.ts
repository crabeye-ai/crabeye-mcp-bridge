import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { reportToLauncher } from "../../../src/daemon/daemon-launch.js";
import { processExists } from "../../../src/process/process-utils.js";

const waitForDisconnect = process.argv.includes("--after-disconnect");
const reportsServing = process.argv.includes("--serving");
const sendsOtherMessage = process.argv.includes("--other-message");
const marker = process.env.SUCCESSOR_MARKER;
const launchingBridge = Number(process.env.LAUNCHING_BRIDGE_PID);

async function outliveLaunchingBridge(markerPath: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (processExists(launchingBridge) && Date.now() < deadline) await delay(50);
  writeFileSync(markerPath, processExists(launchingBridge) ? "bridge still running" : "still running");
}

async function reportAndStay(): Promise<void> {
  if (sendsOtherMessage) {
    process.send?.("hello");
  } else {
    reportToLauncher(reportsServing ? "serving" : "waiting");
    reportToLauncher(reportsServing ? "waiting" : "serving");
  }
  if (marker === undefined) {
    await delay(300);
    process.stdout.write("still running");
  } else {
    await outliveLaunchingBridge(marker);
  }
  process.exit(0);
}

if (waitForDisconnect && process.connected) process.once("disconnect", () => void reportAndStay());
else void reportAndStay();
