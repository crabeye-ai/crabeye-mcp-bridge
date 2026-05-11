import { createRequire } from "node:module";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

export const APP_NAME = "crabeye-mcp-bridge";
export const APP_VERSION = pkg.version;

export const CREDENTIALS_DIR = `.${APP_NAME}`;
export const CREDENTIALS_FILENAME = "credentials.enc";
export const BRIDGE_CONFIG_FILENAME = "config.json";
export const PROCESS_TRACKER_FILENAME = "processes.json";

export const DAEMON_BASE = "crabeye";
export const DAEMON_DIR = `.${DAEMON_BASE}`;
export const DAEMON_RUN_SUBDIR = "run";
export const DAEMON_SOCKET_FILENAME = "manager.sock";
export const DAEMON_PID_FILENAME = "manager.pid";
export const DAEMON_LOCK_FILENAME = "manager.lock";
