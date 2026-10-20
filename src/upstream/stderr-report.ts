import type { Logger } from "../logging/index.js";
import {
  CHILD_EXIT_CAUSES,
  STDERR_LINE_MAX_SENT_CHARS,
  STDERR_TAIL_LINES,
  capStderrLine,
  type ChildExit,
} from "../daemon/protocol.js";

const KNOWN_CAUSES: ReadonlySet<unknown> = new Set(CHILD_EXIT_CAUSES);
const SIGNAL_NAME_RE = /^SIG[A-Z0-9]{1,16}$/;
export const NO_STDERR_OUTPUT = "(no stderr output)";

export interface ChildStopWarning {
  message: string;
  stderr: string[];
}

type ReportedExit = Omit<ChildExit, "cause"> & { cause: ChildExit["cause"] | null };

export function stderrLineFor(params: unknown, sessionId: string | null): string | null {
  if (typeof params !== "object" || params === null) return null;
  const { sessionId: target, line } = params as { sessionId?: unknown; line?: unknown };
  if (target !== sessionId || typeof line !== "string" || line.length === 0) return null;
  return capStderrLine(line, STDERR_LINE_MAX_SENT_CHARS);
}

export function childStopWarning(evicted: { exit?: unknown; stderr?: unknown }): ChildStopWarning | null {
  const exit = asReportedExit(evicted.exit);
  if (exit === null) return null;
  const lines = reportedStderr(evicted.stderr);
  return { message: describeStop(exit), stderr: lines.length > 0 ? lines : [NO_STDERR_OUTPUT] };
}

export class ChildStopWarnings {
  private lastMessageSinceConnect: string | null = null;

  constructor(private readonly logger: Logger) {}

  connected(): void {
    this.lastMessageSinceConnect = null;
  }

  log(warning: ChildStopWarning): void {
    const context = { stderr: warning.stderr };
    if (warning.message === this.lastMessageSinceConnect) this.logger.debug(warning.message, context);
    else this.logger.warn(warning.message, context);
    this.lastMessageSinceConnect = warning.message;
  }
}

function asReportedExit(value: unknown): ReportedExit | null {
  if (typeof value !== "object" || value === null) return null;
  const { cause, code, signal } = value as { cause?: unknown; code?: unknown; signal?: unknown };
  return {
    cause: KNOWN_CAUSES.has(cause) ? (cause as ChildExit["cause"]) : null,
    code: typeof code === "number" && Number.isSafeInteger(code) ? code : null,
    signal: typeof signal === "string" && SIGNAL_NAME_RE.test(signal) ? signal : null,
  };
}

function describeStop(exit: ReportedExit): string {
  switch (exit.cause) {
    case "failed_to_start":
      return "STDIO server could not be started";
    case "unresponsive":
      return "STDIO server stopped answering and was stopped";
    case "output_flood":
      return "STDIO server sent a message too large to read and was stopped";
    case "exited":
      if (exit.code !== null) return `STDIO server exited with code ${exit.code}`;
      if (exit.signal !== null) return `STDIO server was killed by signal ${exit.signal}`;
      return "STDIO server exited";
    case null:
      return "STDIO server stopped";
  }
}

function reportedStderr(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((line): line is string => typeof line === "string" && line.length > 0)
    .slice(-STDERR_TAIL_LINES)
    .map((line) => capStderrLine(line, STDERR_LINE_MAX_SENT_CHARS));
}
