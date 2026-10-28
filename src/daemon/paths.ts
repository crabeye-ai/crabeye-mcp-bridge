import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import {
  APP_NAME,
  DAEMON_BASE,
  DAEMON_DIR,
  DAEMON_LOCK_FILENAME,
  DAEMON_LOG_FILENAME,
  DAEMON_LOG_SUBDIR,
  DAEMON_PID_FILENAME,
  DAEMON_RUN_SUBDIR,
  DAEMON_SOCKET_FILENAME,
  PROCESS_TRACKER_FILENAME,
} from "../constants.js";

function daemonBaseDir(): string {
  if (process.platform !== "win32") return join(homedir(), DAEMON_DIR);
  return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), DAEMON_BASE);
}

export function getDaemonRunDir(): string {
  return join(daemonBaseDir(), DAEMON_RUN_SUBDIR);
}

export function getDaemonLogPath(): string {
  return join(daemonBaseDir(), DAEMON_LOG_SUBDIR, DAEMON_LOG_FILENAME);
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

export interface DaemonFiles {
  lockPath: string;
  pidPath: string;
}

export function daemonFilesFor(socketPath: string): DaemonFiles {
  if (process.platform === "win32") return { lockPath: getDaemonLockPath(), pidPath: getDaemonPidPath() };
  return {
    lockPath: join(dirname(socketPath), DAEMON_LOCK_FILENAME),
    pidPath: join(dirname(socketPath), DAEMON_PID_FILENAME),
  };
}

export function processTrackerPathFor(lockPath: string): string {
  return join(dirname(lockPath), PROCESS_TRACKER_FILENAME);
}

function sanitizeUser(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}
