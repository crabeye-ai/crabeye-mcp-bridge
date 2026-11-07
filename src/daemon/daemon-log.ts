import { format } from "node:util";
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

const CONSOLE_LEVELS = { debug: "debug", log: "info", info: "info", warn: "warn", error: "error" } as const satisfies Record<string, LogLevel>;

type ConsoleMethod = keyof typeof CONSOLE_LEVELS;

/**
 * Sends what code in the manager prints through `console`, such as the MCP
 * SDK's warnings, to `logger`, since the manager runs without a stderr.
 * Returns a function that puts the console back.
 */
export function routeConsoleTo(logger: Logger): () => void {
  const methods = Object.keys(CONSOLE_LEVELS) as ConsoleMethod[];
  const originals = methods.map((method) => [method, console[method]] as const);
  for (const method of methods) console[method] = (...args: unknown[]) => logger[CONSOLE_LEVELS[method]](format(...args));
  return () => {
    for (const [method, original] of originals) console[method] = original;
  };
}
