import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, basename } from "node:path";
import { z } from "zod";
import type { Logger } from "../logging/index.js";
import { createNoopLogger } from "../logging/index.js";
import {
  isProcessAlive as defaultIsProcessAlive,
  killProcessTree as defaultKillProcessTree,
  readProcessInfo as defaultReadProcessInfo,
  type KillProcessTreeOptions,
  type ProcessInfo,
} from "./process-utils.js";

/**
 * Tolerance applied when comparing a live process's kernel start time against
 * our recorded `startedAt`. `startedAt` is captured right after `spawn`
 * resolves; the kernel's reported start time can lead it by a few hundred ms
 * because the OS times the spawn before our event loop gets the resolution.
 * `ps -o lstart=` is also second-granular on most platforms, so we round up.
 */
const PID_REUSE_TOLERANCE_MS = 5000;

const TrackedProcessSchema = z.object({
  pid: z.number().int(),
  command: z.string(),
  args: z.array(z.string()),
  server: z.string(),
  startedAt: z.number(),
});

const FileSchema = z.object({
  processes: z.array(TrackedProcessSchema).default([]),
});

export type TrackedProcess = z.infer<typeof TrackedProcessSchema>;

export interface ReapResult {
  total: number;
  killed: number;
  skipped: number;
}

export interface ProcessTrackerOptions {
  filePath: string;
  logger?: Logger;
  /** Override for tests. Defaults to platform-aware killProcessTree. */
  _killProcessTree?: (pid: number, opts: KillProcessTreeOptions) => Promise<boolean>;
  /** Override for tests. Defaults to `process.kill(pid, 0)`. */
  _isProcessAlive?: (pid: number) => boolean;
  /** Override for tests. Returns null when the live process is gone. */
  _readProcessInfo?: (pid: number) => Promise<ProcessInfo | null>;
  /** Pass 0 in tests to skip kill-wait timeouts. */
  _waitMs?: number;
}

export class ProcessTracker {
  private _filePath: string;
  private _logger: Logger;
  private _waitMs: number | undefined;
  private _kill: (pid: number, opts: KillProcessTreeOptions) => Promise<boolean>;
  private _alive: (pid: number) => boolean;
  private _readInfo: (pid: number) => Promise<ProcessInfo | null>;
  // Serialise all writes so concurrent register/unregister calls don't clobber.
  private _writeQueue: Promise<void> = Promise.resolve();

  constructor(options: ProcessTrackerOptions) {
    this._filePath = options.filePath;
    this._logger = options.logger ?? createNoopLogger();
    this._waitMs = options._waitMs;
    this._kill = options._killProcessTree ?? defaultKillProcessTree;
    this._alive = options._isProcessAlive ?? defaultIsProcessAlive;
    this._readInfo = options._readProcessInfo ?? defaultReadProcessInfo;
  }

  async list(): Promise<TrackedProcess[]> {
    return this._read();
  }

  async register(entry: TrackedProcess): Promise<void> {
    await this._mutate((entries) => {
      const filtered = entries.filter((e) => e.pid !== entry.pid);
      filtered.push(entry);
      return filtered;
    });
  }

  async unregister(pid: number): Promise<void> {
    await this._mutate((entries) => entries.filter((e) => e.pid !== pid));
  }

  async clear(): Promise<void> {
    await this._mutate(() => []);
  }

  async reapStale(): Promise<ReapResult> {
    const entries = await this._read();
    let killed = 0;
    let skipped = 0;

    for (const entry of entries) {
      try {
        const outcome = await this._reapOne(entry);
        if (outcome === "killed") killed++;
        else if (outcome === "skipped") skipped++;
        // "dead" → silently dropped
      } catch (err) {
        this._logger.warn("reap failed", {
          pid: entry.pid,
          server: entry.server,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await this._mutate(() => []);
    return { total: entries.length, killed, skipped };
  }

  private async _reapOne(
    entry: TrackedProcess,
  ): Promise<"killed" | "skipped" | "dead"> {
    if (!this._alive(entry.pid)) {
      return "dead";
    }

    // PID-reuse safety: prefer the kernel-reported start time, which is
    // exact and tamper-resistant. A live process whose lstart is later than
    // our recorded startedAt cannot be the one we spawned — the original
    // had to die first to free the PID.
    const info = await this._readInfo(entry.pid).catch(() => null);

    if (info) {
      if (info.startTime !== null) {
        if (info.startTime > entry.startedAt + PID_REUSE_TOLERANCE_MS) {
          this._logger.warn(
            "skipping reap (PID reused; live process started after we recorded)",
            {
              pid: entry.pid,
              server: entry.server,
              recordedStartedAt: entry.startedAt,
              liveStartTime: info.startTime,
              cmdline: info.cmdline,
            },
          );
          return "skipped";
        }
        // Start time confirms it's our process; cmdline can lie (npx
        // wrappers, exec replacement). Skip cmdline check.
      } else if (!cmdlineMatches(info.cmdline, entry)) {
        // Start time unavailable; fall back to cmdline. Be conservative.
        this._logger.warn(
          "skipping reap (cmdline does not match recorded command)",
          {
            pid: entry.pid,
            server: entry.server,
            recorded: `${entry.command} ${entry.args.join(" ")}`,
            actual: info.cmdline,
          },
        );
        return "skipped";
      }
    }
    // info === null: unable to read process info. The PID is alive per
    // our liveness check, so attempt the kill. False negatives here would
    // leak; false positives only happen if /proc/ps were unavailable AND
    // the PID had already been reused, which is vanishingly rare on Unix.

    this._logger.info("reaping leaked subprocess", {
      pid: entry.pid,
      server: entry.server,
    });

    const opts: KillProcessTreeOptions = {};
    if (this._waitMs !== undefined) {
      opts.gracefulMs = this._waitMs;
      opts.forceMs = this._waitMs;
      opts.pollMs = this._waitMs > 0 ? Math.min(50, this._waitMs) : 0;
    }

    const dead = await this._kill(entry.pid, opts);
    return dead ? "killed" : "skipped";
  }

  // --- File I/O ---

  private async _read(): Promise<TrackedProcess[]> {
    let raw: string;
    try {
      raw = await readFile(this._filePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this._logger.warn("process tracker file is corrupt; starting fresh", {
        path: this._filePath,
      });
      return [];
    }

    const result = FileSchema.safeParse(parsed);
    if (!result.success) {
      this._logger.warn("process tracker file failed schema; starting fresh", {
        path: this._filePath,
      });
      return [];
    }
    return result.data.processes;
  }

  private async _write(entries: TrackedProcess[]): Promise<void> {
    const dir = dirname(this._filePath);
    await mkdir(dir, { recursive: true });
    const tmp = `${this._filePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
    await writeFile(
      tmp,
      JSON.stringify({ processes: entries }, null, 2) + "\n",
      { mode: 0o600 },
    );
    await rename(tmp, this._filePath);
  }

  private _mutate(
    apply: (entries: TrackedProcess[]) => TrackedProcess[],
  ): Promise<void> {
    const next = this._writeQueue.then(async () => {
      const entries = await this._read();
      const updated = apply(entries);
      await this._write(updated);
    });
    // Ensure errors don't poison the chain — log but allow the next write.
    this._writeQueue = next.catch((err) => {
      this._logger.error("process tracker write failed", {
        path: this._filePath,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return next;
  }
}

// --- Helpers ---

/**
 * Loose match used only when the kernel start time is unavailable. Requires
 * the recorded command basename AND every recorded arg to appear somewhere in
 * the live cmdline. Argv rewriting (setproctitle, exec wrappers) can defeat
 * this, which is why we prefer start-time comparison.
 */
function cmdlineMatches(cmdline: string, entry: TrackedProcess): boolean {
  const cmdBase = basename(entry.command);
  if (cmdBase && !cmdline.includes(cmdBase)) return false;
  for (const arg of entry.args) {
    if (arg && !cmdline.includes(arg)) return false;
  }
  return true;
}
