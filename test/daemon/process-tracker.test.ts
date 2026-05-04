import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ProcessTracker,
  type TrackedProcess,
} from "../../src/daemon/process-tracker.js";
import type {
  KillProcessTreeOptions,
  ProcessInfo,
} from "../../src/process/process-utils.js";

function tempPath(): string {
  return join(
    tmpdir(),
    `crabeye-proc-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    "processes.json",
  );
}

interface FakeProc {
  alive: boolean;
  cmdline: string;
  startTime: number | null;
}

class FakeProcessTable {
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

function makeEntry(overrides: Partial<TrackedProcess> = {}): TrackedProcess {
  return {
    pid: 12345,
    command: "node",
    args: ["server.js"],
    server: "test",
    startedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function makeTracker(
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

describe("ProcessTracker", () => {
  let filePath: string;

  beforeEach(() => {
    filePath = tempPath();
  });

  afterEach(async () => {
    await rm(join(filePath, ".."), { recursive: true, force: true });
  });

  describe("register / unregister / list", () => {
    it("returns empty list when file does not exist", async () => {
      const tracker = new ProcessTracker({ filePath });
      expect(await tracker.list()).toEqual([]);
    });

    it("persists registered entry to disk", async () => {
      const tracker = new ProcessTracker({ filePath });
      const entry = makeEntry({ pid: 100 });
      await tracker.register(entry);

      const fromDisk = JSON.parse(await readFile(filePath, "utf-8"));
      expect(fromDisk).toEqual({ processes: [entry] });
    });

    it("list reflects entries across instances", async () => {
      const t1 = new ProcessTracker({ filePath });
      await t1.register(makeEntry({ pid: 100 }));
      await t1.register(makeEntry({ pid: 101, server: "other" }));

      const t2 = new ProcessTracker({ filePath });
      const entries = await t2.list();
      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.pid).sort()).toEqual([100, 101]);
    });

    it("unregister removes entry by pid", async () => {
      const tracker = new ProcessTracker({ filePath });
      await tracker.register(makeEntry({ pid: 100 }));
      await tracker.register(makeEntry({ pid: 101 }));

      await tracker.unregister(100);

      const entries = await tracker.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.pid).toBe(101);
    });

    it("unregister of unknown pid is a no-op", async () => {
      const tracker = new ProcessTracker({ filePath });
      await tracker.register(makeEntry({ pid: 100 }));
      await tracker.unregister(999);

      expect(await tracker.list()).toHaveLength(1);
    });

    it("re-registering same pid replaces prior entry", async () => {
      const tracker = new ProcessTracker({ filePath });
      await tracker.register(makeEntry({ pid: 100, server: "old" }));
      await tracker.register(makeEntry({ pid: 100, server: "new" }));

      const entries = await tracker.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.server).toBe("new");
    });

    it("file is written with mode 0600", async () => {
      const tracker = new ProcessTracker({ filePath });
      await tracker.register(makeEntry({ pid: 100 }));
      const st = await stat(filePath);
      expect(st.mode & 0o777).toBe(0o600);
    });

    it("concurrent registers do not lose data", async () => {
      const tracker = new ProcessTracker({ filePath });
      const ops: Promise<void>[] = [];
      for (let i = 0; i < 20; i++) {
        ops.push(tracker.register(makeEntry({ pid: 1000 + i })));
      }
      await Promise.all(ops);

      const entries = await tracker.list();
      expect(entries).toHaveLength(20);
      const pids = entries.map((e) => e.pid).sort((a, b) => a - b);
      for (let i = 0; i < 20; i++) {
        expect(pids[i]).toBe(1000 + i);
      }
    });

    it("recovers from corrupt file by starting fresh", async () => {
      await mkdir(join(filePath, ".."), { recursive: true });
      await writeFile(filePath, "{ not json", "utf-8");

      const tracker = new ProcessTracker({ filePath });
      expect(await tracker.list()).toEqual([]);

      await tracker.register(makeEntry({ pid: 100 }));
      expect(await tracker.list()).toHaveLength(1);
    });
  });

  describe("reapStale", () => {
    it("kills tracked alive process whose start time is at or before recorded", async () => {
      const fake = new FakeProcessTable();
      // Live start time = recorded - 100ms (kernel timed spawn slightly before
      // event-loop captured Date.now()). Should kill.
      fake.spawn(100, "node /server.js", 1_699_999_999_900);

      const tracker = makeTracker(filePath, fake);
      await tracker.register(
        makeEntry({
          pid: 100,
          command: "node",
          args: ["/server.js"],
          startedAt: 1_700_000_000_000,
        }),
      );

      const result = await tracker.reapStale();
      expect(result).toEqual({ total: 1, killed: 1, skipped: 0 });
      expect(fake.killCalls).toHaveLength(1);
      expect(fake.killCalls[0]!.pid).toBe(100);
      expect(fake.procs.get(100)!.alive).toBe(false);
    });

    it("skips alive process whose start time is later than recorded (PID reuse)", async () => {
      const fake = new FakeProcessTable();
      // Live process started 30s after we recorded → impossible to be ours.
      fake.spawn(100, "node /server.js", 1_700_000_030_000);

      const tracker = makeTracker(filePath, fake);
      await tracker.register(
        makeEntry({
          pid: 100,
          command: "node",
          args: ["/server.js"],
          startedAt: 1_700_000_000_000,
        }),
      );

      const result = await tracker.reapStale();
      expect(result).toEqual({ total: 1, killed: 0, skipped: 1 });
      expect(fake.killCalls).toHaveLength(0);
      expect(fake.procs.get(100)!.alive).toBe(true);
    });

    it("kills when start time is later than recorded but within tolerance", async () => {
      const fake = new FakeProcessTable();
      // Live start time 2s after recorded (within 5s tolerance for ps lstart
      // second-granular rounding). Should kill.
      fake.spawn(100, "node /server.js", 1_700_000_002_000);

      const tracker = makeTracker(filePath, fake);
      await tracker.register(
        makeEntry({
          pid: 100,
          command: "node",
          args: ["/server.js"],
          startedAt: 1_700_000_000_000,
        }),
      );

      const result = await tracker.reapStale();
      expect(result.killed).toBe(1);
    });

    it("npx exec-replacement: kills when both start time AND cmdline plausibly match", async () => {
      const fake = new FakeProcessTable();
      // Recorded as npx but live cmdline shows node + npx-cli.js (after exec).
      // The basename "npx" still appears as a substring of "npx-cli.js" and
      // the inner arg appears verbatim, so cmdlineMatches is true.
      fake.spawn(
        100,
        "node /usr/local/lib/node_modules/npm/bin/npx-cli.js @some/mcp-server",
        1_699_999_999_500,
      );

      const tracker = makeTracker(filePath, fake);
      await tracker.register(
        makeEntry({
          pid: 100,
          command: "npx",
          args: ["@some/mcp-server"],
          startedAt: 1_700_000_000_000,
        }),
      );

      const result = await tracker.reapStale();
      expect(result.killed).toBe(1);
    });

    it(
      "skips when start time matches but cmdline does NOT (forged-record defense)",
      async () => {
        const fake = new FakeProcessTable();
        // Attacker writes a tracker file with `startedAt: now()` for a victim
        // PID. Live process is unrelated (a shell, an editor) and its cmdline
        // doesn't match the recorded command/args.
        fake.spawn(100, "/Applications/Firefox.app/Contents/MacOS/firefox", 1_700_000_000_500);

        const tracker = makeTracker(filePath, fake);
        await tracker.register(
          makeEntry({
            pid: 100,
            command: "node",
            args: ["/server.js"],
            startedAt: 1_700_000_000_000,
          }),
        );

        const result = await tracker.reapStale();
        expect(result.skipped).toBe(1);
        expect(fake.killCalls).toHaveLength(0);
        expect(fake.procs.get(100)!.alive).toBe(true);
      },
    );

    it(
      "skips when start time is EARLIER than recorded by more than tolerance",
      async () => {
        const fake = new FakeProcessTable();
        // Live process started 30 s before the record — cannot be ours, the
        // record was made after spawn resolved.
        fake.spawn(100, "node /server.js", 1_699_999_970_000);

        const tracker = makeTracker(filePath, fake);
        await tracker.register(
          makeEntry({
            pid: 100,
            command: "node",
            args: ["/server.js"],
            startedAt: 1_700_000_000_000,
          }),
        );

        const result = await tracker.reapStale();
        expect(result.skipped).toBe(1);
        expect(fake.procs.get(100)!.alive).toBe(true);
      },
    );

    it("falls back to cmdline match when start time unavailable", async () => {
      const fake = new FakeProcessTable();
      fake.spawn(100, "node /server.js", null);

      const tracker = makeTracker(filePath, fake);
      await tracker.register(
        makeEntry({
          pid: 100,
          command: "node",
          args: ["/server.js"],
        }),
      );

      const result = await tracker.reapStale();
      expect(result.killed).toBe(1);
    });

    it("skips when start time unavailable AND cmdline does not match", async () => {
      const fake = new FakeProcessTable();
      fake.spawn(100, "/Applications/Firefox.app/Contents/MacOS/firefox", null);

      const tracker = makeTracker(filePath, fake);
      await tracker.register(
        makeEntry({
          pid: 100,
          command: "node",
          args: ["/server.js"],
        }),
      );

      const result = await tracker.reapStale();
      expect(result.skipped).toBe(1);
      expect(fake.killCalls).toHaveLength(0);
      expect(fake.procs.get(100)!.alive).toBe(true);
    });

    it("cmdline fallback requires every recorded arg to be present", async () => {
      const fake = new FakeProcessTable();
      // Has the command "node" but missing the script arg → another node
      // process, not ours.
      fake.spawn(100, "node /unrelated.js", null);

      const tracker = makeTracker(filePath, fake);
      await tracker.register(
        makeEntry({
          pid: 100,
          command: "node",
          args: ["/server.js"],
        }),
      );

      const result = await tracker.reapStale();
      expect(result.skipped).toBe(1);
    });

    it("attempts kill when readProcessInfo returns null but process is alive", async () => {
      const fake = new FakeProcessTable();
      fake.spawn(100, "node /server.js", null);
      // Override readProcessInfo to simulate platform query failure.
      const tracker = new ProcessTracker({
        filePath,
        _isProcessAlive: fake.isAlive,
        _killProcessTree: fake.killProcessTree,
        _readProcessInfo: async () => null,
        _waitMs: 0,
      });

      await tracker.register(makeEntry({ pid: 100 }));
      const result = await tracker.reapStale();
      expect(result.killed).toBe(1);
    });

    it("drops dead processes without recording a kill", async () => {
      const fake = new FakeProcessTable();
      // pid 100 not in fake table → not alive

      const tracker = makeTracker(filePath, fake);
      await tracker.register(makeEntry({ pid: 100 }));
      const result = await tracker.reapStale();

      expect(result).toEqual({ total: 1, killed: 0, skipped: 0 });
      expect(fake.killCalls).toHaveLength(0);
      expect(await tracker.list()).toEqual([]);
    });

    it("clears the file after reaping", async () => {
      const fake = new FakeProcessTable();
      fake.spawn(100, "node /server.js", 1_699_999_999_500);

      const tracker = makeTracker(filePath, fake);
      await tracker.register(
        makeEntry({
          pid: 100,
          command: "node",
          args: ["/server.js"],
          startedAt: 1_700_000_000_000,
        }),
      );

      await tracker.reapStale();
      expect(await tracker.list()).toEqual([]);
    });

    it("processes a mix of dead, ours, and reused PIDs", async () => {
      const fake = new FakeProcessTable();
      fake.spawn(100, "node /a.js", 1_699_999_999_900); // ours, kill
      fake.spawn(101, "node /b.js", 1_700_000_030_000); // reused, skip
      // 102 not in table → dead

      const tracker = makeTracker(filePath, fake);
      const startedAt = 1_700_000_000_000;
      await tracker.register(makeEntry({ pid: 100, command: "node", args: ["/a.js"], startedAt }));
      await tracker.register(makeEntry({ pid: 101, command: "node", args: ["/b.js"], startedAt }));
      await tracker.register(makeEntry({ pid: 102, command: "node", args: ["/c.js"], startedAt }));

      const result = await tracker.reapStale();
      expect(result).toEqual({ total: 3, killed: 1, skipped: 1 });
      expect(await tracker.list()).toEqual([]);
    });
  });
});
