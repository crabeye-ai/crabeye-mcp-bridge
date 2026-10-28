import { escapeControlCharacters } from "./escape.js";

export { escapeControlCharacters } from "./escape.js";
export { escapeLabel, methodLabel } from "./labels.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  child(defaultContext: Record<string, unknown>): Logger;
  setLevel(level: LogLevel): void;
}

const LEVEL_VALUE: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface CreateLoggerOptions {
  level: LogLevel;
  format: "text" | "json";
  write?: (line: string) => void;
  dated?: boolean;
  pid?: number;
}

interface LineOutput {
  format: "text" | "json";
  write: (line: string) => void;
  dated: boolean;
  pid: number | undefined;
}

interface SharedLoggerState {
  threshold: number;
  output: LineOutput;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

function formatTime(d: Date): string {
  return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}.${pad(d.getMilliseconds(), 3)}`;
}

function formatDateTime(d: Date): string {
  const offsetMinutes = -d.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const offset = `${sign}${pad(Math.floor(Math.abs(offsetMinutes) / 60), 2)}:${pad(Math.abs(offsetMinutes) % 60, 2)}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}T${formatTime(d)}${offset}`;
}

function renderValue(value: unknown): string {
  const text = typeof value === "object" && value !== null ? String(JSON.stringify(value)) : String(value);
  return escapeControlCharacters(text);
}

function formatText(
  level: LogLevel,
  message: string,
  context: Record<string, unknown>,
  output: Pick<LineOutput, "dated" | "pid">,
): string {
  const tag = level.toUpperCase().padEnd(5);
  const component = context.component ? escapeControlCharacters(String(context.component)) : undefined;
  const server = context.server ? escapeControlCharacters(String(context.server)) : undefined;
  let prefix = "";
  if (component && server) {
    prefix = `[${component}:${server}] `;
  } else if (component) {
    prefix = `[${component}] `;
  } else if (server) {
    prefix = `[${server}] `;
  }

  // Collect extra keys (everything except component/server)
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(context)) {
    if (k !== "component" && k !== "server" && v !== undefined) {
      extra[k] = v;
    }
  }
  const suffix = Object.keys(extra).length > 0
    ? " " + Object.entries(extra).map(([k, v]) => `${k}=${renderValue(v)}`).join(" ")
    : "";

  const now = new Date();
  const stamp = output.dated ? formatDateTime(now) : formatTime(now);
  const pid = output.pid === undefined ? "" : `[${output.pid}] `;
  return `${stamp} ${pid}${tag} ${prefix}${escapeControlCharacters(message)}${suffix}\n`;
}

function formatJson(
  level: LogLevel,
  message: string,
  context: Record<string, unknown>,
): string {
  return JSON.stringify({
    ...context,
    time: new Date().toISOString(),
    level,
    msg: message,
  }) + "\n";
}

class LoggerImpl implements Logger {
  private _shared: SharedLoggerState;
  private _defaultContext: Record<string, unknown>;

  constructor(shared: SharedLoggerState, defaultContext: Record<string, unknown> = {}) {
    this._shared = shared;
    this._defaultContext = defaultContext;
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this._log("debug", message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this._log("info", message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this._log("warn", message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this._log("error", message, context);
  }

  setLevel(level: LogLevel): void {
    this._shared.threshold = LEVEL_VALUE[level];
  }

  child(defaultContext: Record<string, unknown>): Logger {
    return new LoggerImpl(this._shared, { ...this._defaultContext, ...defaultContext });
  }

  private _log(
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>,
  ): void {
    if (LEVEL_VALUE[level] < this._shared.threshold) return;
    const merged = context
      ? { ...this._defaultContext, ...context }
      : this._defaultContext;
    const output = this._shared.output;
    const line =
      output.format === "json"
        ? formatJson(level, message, merged)
        : formatText(level, message, merged, output);
    output.write(line);
  }
}

export function createLogger(options: CreateLoggerOptions): Logger {
  return new LoggerImpl({
    threshold: LEVEL_VALUE[options.level],
    output: {
      format: options.format,
      write: options.write ?? ((line) => process.stderr.write(line)),
      dated: options.dated ?? false,
      pid: options.pid,
    },
  });
}

/** A logger that discards all output. Useful in tests. */
export function createNoopLogger(): Logger {
  const noop = () => {};
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
    setLevel: noop,
  };
  return logger;
}
