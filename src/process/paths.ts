import { join } from "node:path";
import { homedir } from "node:os";
import { CREDENTIALS_DIR, PROCESS_TRACKER_FILENAME } from "../constants.js";

export function getProcessTrackerPath(): string {
  return join(homedir(), CREDENTIALS_DIR, PROCESS_TRACKER_FILENAME);
}
