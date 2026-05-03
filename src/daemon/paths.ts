import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import {
  APP_NAME,
  DAEMON_BASE,
  DAEMON_DIR,
  DAEMON_LOCK_FILENAME,
  DAEMON_PID_FILENAME,
  DAEMON_RUN_SUBDIR,
  DAEMON_SOCKET_FILENAME,
} from "../constants.js";

function windowsRunDir(): string {
  const base =
    process.env.LOCALAPPDATA ??
    join(homedir(), "AppData", "Local");
  return join(base, DAEMON_BASE, DAEMON_RUN_SUBDIR);
}

export function getDaemonRunDir(): string {
  if (process.platform === "win32") {
    return windowsRunDir();
  }
  return join(homedir(), DAEMON_DIR, DAEMON_RUN_SUBDIR);
}

export function getDaemonSocketPath(): string {
  if (process.platform === "win32") {
    const user = sanitizeUser(userInfo().username);
    return `\\\\.\\pipe\\${APP_NAME}-manager-${user}`;
  }
  return join(getDaemonRunDir(), DAEMON_SOCKET_FILENAME);
}

export function getDaemonPidPath(): string {
  return join(getDaemonRunDir(), DAEMON_PID_FILENAME);
}

export function getDaemonLockPath(): string {
  return join(getDaemonRunDir(), DAEMON_LOCK_FILENAME);
}

function sanitizeUser(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}
