import { vi, type Mock } from "vitest";
import type { Logger, LogLevel } from "../../src/logging/index.js";

export interface SpyLogger extends Logger {
  debug: Mock;
  info: Mock;
  warn: Mock;
  error: Mock;
}

export function spyLogger(): SpyLogger {
  const logger: SpyLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => logger,
  };
  return logger;
}

export interface LoggedLine {
  level: LogLevel;
  message: string;
  context: Record<string, unknown>;
}

/** A logger that appends every line to `lines`, with the context its children add. */
export function recordingLogger(lines: LoggedLine[], defaults: Record<string, unknown> = {}): Logger {
  const record = (level: LogLevel) => (message: string, context?: Record<string, unknown>) => {
    lines.push({ level, message, context: { ...defaults, ...context } });
  };
  return {
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    setLevel: () => {},
    child: (context) => recordingLogger(lines, { ...defaults, ...context }),
  };
}
