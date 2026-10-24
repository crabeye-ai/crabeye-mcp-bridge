import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore } from "../../src/credentials/credential-store.js";
import { EnvKeychain } from "../../src/credentials/keychain.js";
import { readLockHolderPid } from "../../src/process/lockfile.js";
import { bundleForSubprocess } from "../_helpers/subprocess-bundle.js";
import { deadPid, exited, settledWithin } from "../_helpers/processes.js";
import { FileKeychain, keyWrites } from "../_helpers/file-keychain.js";
import { secret, tempFiles } from "../_helpers/credential-store.js";

const MASTER_KEY = randomBytes(32).toString("hex");
const isWindows = process.platform === "win32";

type KeySource = "env" | "dpapi" | { file: string; readDelayMs: number };

interface Started {
  child: ChildProcessWithoutNullStreams;
  line: () => Promise<string>;
}

describe("credential store shared by several processes (#219)", { timeout: 60_000 }, () => {
  let writerScript: string;
  let lockScript: string;
  let dir: string;
  let storePath: string;
  const children: ChildProcessWithoutNullStreams[] = [];

  beforeAll(async () => {
    [writerScript, lockScript] = await Promise.all([
      bundleForSubprocess("test/_helpers/subprocess/credential-writer.ts", "credential-writer"),
      bundleForSubprocess("test/_helpers/subprocess/acquire-lock.ts", "acquire-lock"),
    ]);
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cbe-store-"));
    storePath = join(dir, "credentials.enc");
  });

  afterEach(async () => {
    const leftovers = children.splice(0);
    for (const child of leftovers) child.kill("SIGKILL");
    await Promise.all(leftovers.map((child) => exited(child, 5_000)));
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  function start(script: string, args: string[]): Started {
    const child = spawn(process.execPath, [script, ...args], {
      stdio: "pipe",
      env: { ...process.env, MCP_BRIDGE_MASTER_KEY: MASTER_KEY, USERPROFILE: dir },
    });
    children.push(child);
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf-8")));
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const line = async () => {
      const next = await lines.next();
      if (next.done) throw new Error(`process ${child.pid} exited without output; stderr: ${stderr}`);
      return next.value;
    };
    return { child, line };
  }

  function writer(op: "set" | "delete" | "deleteMany" | "list", prefix: string, count: number, key: KeySource = "env"): Started {
    const keyArgs = typeof key === "string" ? [key] : ["file", key.file, String(key.readDelayMs)];
    return start(writerScript, [storePath, op, prefix, String(count), ...keyArgs]);
  }

  async function runTogether(writers: Started[]): Promise<string[]> {
    for (const w of writers) expect(await w.line()).toBe("ready");
    for (const w of writers) w.child.stdin.write("go\n");
    return Promise.all(writers.map((w) => w.line()));
  }

  async function holdLock(): Promise<Started> {
    const holder = start(lockScript, [`${storePath}.lock`]);
    expect(await holder.line()).toBe("held");
    return holder;
  }

  const envStore = (options: { lockTimeoutMs?: number } = {}) =>
    new CredentialStore({ keychain: new EnvKeychain(MASTER_KEY), filePath: storePath, ...options });

  const drainAbandonedWrites = () => envStore().delete("drain");

  it("keeps every write when several processes write at once, while a reader always sees a whole store", async () => {
    const writers = ["a", "b", "c", "d"].map((prefix) => writer("set", prefix, 20));
    const reads: number[] = [];
    let writing = true;
    const reader = (async () => {
      while (writing) reads.push((await envStore().list()).length);
    })();

    let outcomes: string[];
    try {
      outcomes = await runTogether(writers);
    } finally {
      writing = false;
      await reader;
    }

    expect(outcomes).toEqual(["done", "done", "done", "done"]);
    expect(reads.every((count, i) => i === 0 || count >= reads[i - 1]!)).toBe(true);
    const keys = await envStore().list();
    expect(keys).toHaveLength(80);
    for (const prefix of ["a", "b", "c", "d"]) {
      for (let i = 0; i < 20; i++) expect(keys).toContain(`${prefix}-${i}`);
    }
  });

  it("keeps every write when other processes delete at the same time", async () => {
    const seeding = envStore();
    for (let i = 0; i < 15; i++) {
      await seeding.set(`gone-${i}`, secret("x"));
      await seeding.set(`gone-many-${i}`, secret("x"));
    }

    const outcomes = await runTogether([
      writer("set", "kept", 15),
      writer("delete", "gone", 15),
      writer("deleteMany", "gone-many", 15),
    ]);

    expect(outcomes).toEqual(["done", "done", "done"]);
    expect((await envStore().list()).sort()).toEqual(Array.from({ length: 15 }, (_, i) => `kept-${i}`).sort());
  });

  it.each([1, 2, 3, 4, 5])("ends with one master key when two processes use a fresh store at once (round %i)", async () => {
    const keyPath = join(dir, "master-key");
    const key = { file: keyPath, readDelayMs: 100 };

    expect(await runTogether([writer("set", "first", 3, key), writer("set", "second", 3, key)])).toEqual(["done", "done"]);

    expect(await keyWrites(keyPath)).toBe(1);
    const store = new CredentialStore({ keychain: new FileKeychain(keyPath), filePath: storePath });
    expect((await store.list()).sort()).toEqual(["first-0", "first-1", "first-2", "second-0", "second-1", "second-2"]);
  });

  it.skipIf(!isWindows)("ends with one readable DPAPI master key when two processes use a fresh store at once", async () => {
    expect(await runTogether([writer("set", "first", 2, "dpapi"), writer("set", "second", 2, "dpapi")])).toEqual(["done", "done"]);

    expect(await runTogether([writer("list", "listed", 1, "dpapi")])).toEqual(["keys: first-0,first-1,second-0,second-1"]);
  });

  it("takes over a lock left by a killed process", async () => {
    const holder = await holdLock();
    holder.child.kill("SIGKILL");
    await exited(holder.child, 5_000);

    await envStore({ lockTimeoutMs: 5_000 }).set("after", secret("1"));

    expect(await envStore().get("after")).toEqual(secret("1"));
  });

  it.skipIf(isWindows)("takes over a lock naming a process that has exited", async () => {
    await writeFile(`${storePath}.lock`, `${deadPid()}\nleft-behind\n`);

    await envStore({ lockTimeoutMs: 5_000 }).set("after", secret("1"));

    expect(await envStore().get("after")).toEqual(secret("1"));
  });

  it("waits for a live holder and then writes", async () => {
    const holder = await holdLock();

    const write = envStore().set("waited", secret("1"));
    expect(await settledWithin(write, 300)).toBe(false);
    holder.child.stdin.end();

    await write;
    expect(await envStore().get("waited")).toEqual(secret("1"));
  });

  it("never takes the lock from a live holder, however old the lock is", async () => {
    const holder = await holdLock();
    const longAgo = new Date(Date.now() - 10 * 60_000);
    await utimes(`${storePath}.lock`, longAgo, longAgo);

    await expect(envStore({ lockTimeoutMs: 1_000 }).set("stolen", secret("1"))).rejects.toThrow(/Credential store set exceeded 1000ms/);
    await drainAbandonedWrites();

    expect(await readLockHolderPid(`${storePath}.lock`)).toBe(holder.child.pid);
  });

  it("gives up once the wait passes the timeout, and never writes afterwards", async () => {
    const holder = await holdLock();

    await expect(envStore({ lockTimeoutMs: 500 }).set("late", secret("1"))).rejects.toThrow(/Credential store set exceeded 500ms/);
    await drainAbandonedWrites();
    holder.child.stdin.end();
    await exited(holder.child, 5_000);

    expect(await envStore().get("late")).toBeUndefined();
  });

  it("waits for as long as it takes when the timeout is disabled", async () => {
    const holder = await holdLock();

    const write = envStore({ lockTimeoutMs: 0 }).set("patient", secret("1"));
    expect(await settledWithin(write, 300)).toBe(false);
    holder.child.stdin.end();

    await write;
    expect(await envStore().get("patient")).toEqual(secret("1"));
  });

  it.each([1, 2, 3])("leaves a readable store when a writer is killed mid-write (round %i)", async () => {
    await envStore().set("before", secret("old"));
    const victim = writer("set", "victim", 1_000);
    expect(await victim.line()).toBe("ready");
    victim.child.stdin.write("go\n");
    await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 250));
    victim.child.kill("SIGKILL");
    await exited(victim.child, 5_000);

    expect(await envStore().get("before")).toEqual(secret("old"));
    await envStore({ lockTimeoutMs: 5_000 }).set("after", secret("new"));

    expect(await envStore().get("after")).toEqual(secret("new"));
    expect(await tempFiles(dir)).toEqual([]);
  });

  it("removes the temp file a dead writer left behind", async () => {
    await envStore().set("before", secret("old"));
    const holder = await holdLock();
    await writeFile(`${storePath}.tmp.${holder.child.pid}`, randomBytes(40));
    holder.child.kill("SIGKILL");
    await exited(holder.child, 5_000);

    expect(await envStore().get("before")).toEqual(secret("old"));
    await envStore().set("after", secret("new"));

    expect((await envStore().list()).sort()).toEqual(["after", "before"]);
    expect(await tempFiles(dir)).toEqual([]);
  });

  it("reads without waiting for a held lock", async () => {
    await envStore().set("present", secret("1"));
    const holder = await holdLock();

    expect(await envStore().get("present")).toEqual(secret("1"));
    expect(await envStore().list()).toEqual(["present"]);
    expect(await readLockHolderPid(`${storePath}.lock`)).toBe(holder.child.pid);
  });
});
