import { STDERR_LINE_MAX_CHARS, STDERR_TAIL_LINES, capStderrLine } from "./protocol.js";

export const STDERR_FORWARD_LINES_PER_SECOND = 100;
export const STDERR_DRAIN_MS = 500;
const FORWARD_WINDOW_MS = 1_000;

export function withheldLinesNotice(count: number): string {
  return `(${count} more stderr ${count === 1 ? "line" : "lines"} not shown)`;
}

function detachFromChunk(text: string): string {
  return ` ${text}`.slice(1);
}

export class StderrCapture {
  private partial = "";
  private discardingRestOfLine = false;
  private readonly lastLines: string[] = [];
  private nextTailSlot = 0;
  private linesThisChunk = 0;

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly maxLineChars = STDERR_LINE_MAX_CHARS,
    private readonly tailLines = STDERR_TAIL_LINES,
  ) {}

  push(chunk: string): void {
    this.linesThisChunk = 0;
    let start = 0;
    for (let newline = chunk.indexOf("\n"); newline !== -1; newline = chunk.indexOf("\n", start)) {
      this.append(chunk.slice(start, newline));
      this.endLine();
      start = newline + 1;
    }
    this.append(chunk.slice(start));
    this.partial = detachFromChunk(this.partial);
    this.detachTailFromChunk();
  }

  end(): void {
    this.endLine();
  }

  tail(): string[] {
    return [...this.lastLines.slice(this.nextTailSlot), ...this.lastLines.slice(0, this.nextTailSlot)];
  }

  private append(text: string): void {
    if (this.discardingRestOfLine) return;
    this.partial += text;
    if (this.partial.length <= this.maxLineChars) return;
    this.emit(capStderrLine(this.partial, this.maxLineChars));
    this.partial = "";
    this.discardingRestOfLine = true;
  }

  private endLine(): void {
    if (!this.discardingRestOfLine) this.emit(this.partial);
    this.partial = "";
    this.discardingRestOfLine = false;
  }

  private emit(raw: string): void {
    const line = raw.trimEnd();
    if (line.length === 0) return;
    this.lastLines[this.nextTailSlot] = line;
    this.nextTailSlot = (this.nextTailSlot + 1) % this.tailLines;
    this.linesThisChunk++;
    this.onLine(line);
  }

  private detachTailFromChunk(): void {
    const written = Math.min(this.linesThisChunk, this.lastLines.length);
    for (let back = 1; back <= written; back++) {
      const slot = (this.nextTailSlot - back + this.tailLines) % this.tailLines;
      this.lastLines[slot] = detachFromChunk(this.lastLines[slot]!);
    }
  }
}

export class StderrForwardLimit {
  private windowStartedAt = Number.NEGATIVE_INFINITY;
  private forwardedInWindow = 0;
  private withheld = 0;
  private noticeTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly forward: (line: string) => void,
    private readonly linesPerSecond = STDERR_FORWARD_LINES_PER_SECOND,
  ) {}

  offer(line: string): void {
    if (this.stopped) return;
    if (this.noticeTimer !== null) {
      this.withheld++;
      return;
    }
    this.startWindowIfDue();
    if (this.forwardedInWindow < this.linesPerSecond) {
      this.forwardedInWindow++;
      this.forward(line);
      return;
    }
    this.withheld++;
    const untilWindowEnds = this.windowStartedAt + FORWARD_WINDOW_MS - performance.now();
    this.noticeTimer = setTimeout(() => this.reportWithheld(), untilWindowEnds).unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    this.noticeTimer = null;
  }

  private startWindowIfDue(): void {
    const now = performance.now();
    if (now - this.windowStartedAt < FORWARD_WINDOW_MS) return;
    this.windowStartedAt = now;
    this.forwardedInWindow = 0;
  }

  private reportWithheld(): void {
    this.noticeTimer = null;
    const count = this.withheld;
    this.withheld = 0;
    this.windowStartedAt = performance.now();
    this.forwardedInWindow = 1;
    this.forward(withheldLinesNotice(count));
  }
}
