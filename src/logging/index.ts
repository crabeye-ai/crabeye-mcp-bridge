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
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

function formatTime(): string {
  const d = new Date();
  return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}.${pad(d.getMilliseconds(), 3)}`;
}

function formatText(
  level: LogLevel,
  message: string,
  context: Record<string, unknown>,
): string {
  const tag = level.toUpperCase().padEnd(5);
  const component = context.component as string | undefined;
  const server = context.server as string | undefined;
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
    ? " " + Object.entries(extra).map(([k, v]) => `${k}=${typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)}`).join(" ")
    : "";

  const safeMessage = message.replace(/\n/g, "\\n");
  return `${formatTime()} ${tag} ${prefix}${safeMessage}${suffix}\n`;
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
  private _shared: { threshold: number };
  private _format: "text" | "json";
  private _defaultContext: Record<string, unknown>;

  constructor(
    options: CreateLoggerOptions,
    defaultContext: Record<string, unknown> = {},
    shared?: { threshold: number },
  ) {
    this._shared = shared ?? { threshold: LEVEL_VALUE[options.level] };
    this._format = options.format;
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
    return new LoggerImpl(
      { level: "debug", format: this._format },
      { ...this._defaultContext, ...defaultContext },
      this._shared,
    );
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
    const line =
      this._format === "json"
        ? formatJson(level, message, merged)
        : formatText(level, message, merged);
    process.stderr.write(line);
  }
}

export function createLogger(options: CreateLoggerOptions): Logger {
  return new LoggerImpl(options);
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
