import { createLogger, type Logger, type LogLevel } from "../logging/index.js";
import { LogFile } from "../logging/log-file.js";
import { getDaemonLogPath } from "./paths.js";
import { DAEMON_LOG_MAX_BYTES } from "../constants.js";

export interface DaemonLoggerOptions {
  level: LogLevel;
  path?: string;
  maxBytes?: number;
}

export function createDaemonLogger(opts: DaemonLoggerOptions): Logger {
  const file = new LogFile({ path: opts.path ?? getDaemonLogPath(), maxBytes: opts.maxBytes ?? DAEMON_LOG_MAX_BYTES });
  return createLogger({
    level: opts.level,
    format: "text",
    dated: true,
    pid: process.pid,
    write: (line) => file.write(line),
  });
}
