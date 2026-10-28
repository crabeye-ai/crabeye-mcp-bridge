import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  openSync,
  renameSync,
  statSync,
  truncateSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import { dirname } from "node:path";
import { ensurePrivateDirSync } from "../process/private-dir.js";

export interface LogFileOptions {
  path: string;
  maxBytes: number;
  recheckMs?: number;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

const DEFAULT_RECHECK_MS = 1_000;
const isWindows = process.platform === "win32";
const OPEN_FLAGS = isWindows
  ? "a"
  : constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export class LogFile {
  private fd: number | null = null;
  private identity: FileIdentity | null = null;
  private size = 0;
  private nextCheckAt = 0;
  private readonly recheckMs: number;

  constructor(private readonly opts: LogFileOptions) {
    this.recheckMs = opts.recheckMs ?? DEFAULT_RECHECK_MS;
  }

  write(line: string): void {
    try {
      const bytes = Buffer.from(line, "utf8");
      const fd = this.fdWithRoomFor(bytes.length);
      if (fd !== null) this.append(fd, bytes);
    } catch {
      // ignore
    }
  }

  close(): void {
    if (this.fd === null) return;
    const fd = this.fd;
    this.fd = null;
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
  }

  private fdWithRoomFor(incomingBytes: number): number | null {
    if (performance.now() >= this.nextCheckAt) this.reopenIfReplaced();
    if (this.fd === null) return null;
    if (this.size > 0 && this.size + incomingBytes > this.opts.maxBytes) this.rotate(incomingBytes);
    return this.fd;
  }

  private reopenIfReplaced(): void {
    this.nextCheckAt = performance.now() + this.recheckMs;
    const current = this.statIfOurs();
    if (this.fd !== null && current !== null) {
      this.size = Number(current.size);
      return;
    }
    this.open();
  }

  private rotate(incomingBytes: number): void {
    const current = this.statIfOurs();
    if (current !== null && Number(current.size) + incomingBytes <= this.opts.maxBytes) {
      this.size = Number(current.size);
      return;
    }
    if (current !== null) {
      try {
        renameSync(this.opts.path, `${this.opts.path}.1`);
      } catch {
        if (this.statIfOurs() !== null) {
          this.truncateInPlace();
          return;
        }
      }
    }
    this.open();
  }

  private truncateInPlace(): void {
    try {
      if (isWindows) truncateSync(this.opts.path, 0);
      else ftruncateSync(this.fd!, 0);
      this.size = 0;
    } catch {
      this.close();
    }
  }

  private statIfOurs(): BigIntStats | null {
    const current = statOrNull(this.opts.path);
    return current !== null && this.isOurs(current) ? current : null;
  }

  private open(): void {
    this.close();
    ensurePrivateDirSync(dirname(this.opts.path), "log dir");
    const fd = openSync(this.opts.path, OPEN_FLAGS, 0o600);
    try {
      const stats = fstatSync(fd, { bigint: true });
      if (!isWindows) ensurePrivateFile(fd, stats, this.opts.path);
      this.fd = fd;
      this.identity = { dev: stats.dev, ino: stats.ino };
      this.size = Number(stats.size);
    } catch (err) {
      closeSync(fd);
      throw err;
    }
  }

  private isOurs(stats: BigIntStats): boolean {
    return this.identity !== null && stats.dev === this.identity.dev && stats.ino === this.identity.ino;
  }

  private append(fd: number, bytes: Buffer): void {
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written);
    this.size += bytes.length;
  }
}

function ensurePrivateFile(fd: number, stats: BigIntStats, path: string): void {
  if (!stats.isFile() || stats.nlink !== 1n || Number(stats.uid) !== process.geteuid?.()) {
    throw new Error(`refusing to use log file that isn't a private regular file: ${path}`);
  }
  fchmodSync(fd, 0o600);
}

function statOrNull(path: string): BigIntStats | null {
  try {
    return statSync(path, { bigint: true, throwIfNoEntry: false }) ?? null;
  } catch {
    return null;
  }
}
