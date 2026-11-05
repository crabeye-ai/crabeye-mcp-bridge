import { ProcessTracker, type TrackedProcess } from "../../src/daemon/process-tracker.js";
import type { KillProcessTreeOptions, ProcessInfo } from "../../src/process/process-utils.js";

interface FakeProc {
  alive: boolean;
  cmdline: string;
  startTime: number | null;
}

export class FakeProcessTable {
  procs = new Map<number, FakeProc>();
  killCalls: Array<{ pid: number; opts: KillProcessTreeOptions }> = [];

  spawn(pid: number, cmdline: string, startTime: number | null = null): void {
    this.procs.set(pid, { alive: true, cmdline, startTime });
  }

  isAlive = (pid: number): boolean => {
    const p = this.procs.get(pid);
    return !!p?.alive;
  };

  killProcessTree = async (
    pid: number,
    opts: KillProcessTreeOptions,
  ): Promise<boolean> => {
    this.killCalls.push({ pid, opts });
    const p = this.procs.get(pid);
    if (!p || !p.alive) return false;
    p.alive = false;
    return true;
  };

  readProcessInfo = async (pid: number): Promise<ProcessInfo | null> => {
    const p = this.procs.get(pid);
    if (!p || !p.alive) return null;
    return { cmdline: p.cmdline, startTime: p.startTime };
  };
}

export function makeEntry(overrides: Partial<TrackedProcess> = {}): TrackedProcess {
  return {
    pid: 12345,
    command: "node",
    args: ["server.js"],
    server: "test",
    startedAt: 1_700_000_000_000,
    ...overrides,
  };
}

export function makeTracker(
  filePath: string,
  fake: FakeProcessTable,
): ProcessTracker {
  return new ProcessTracker({
    filePath,
    _isProcessAlive: fake.isAlive,
    _killProcessTree: fake.killProcessTree,
    _readProcessInfo: fake.readProcessInfo,
    _waitMs: 0,
  });
}
