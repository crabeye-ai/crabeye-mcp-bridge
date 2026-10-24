import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockKeychain, secret, tempFiles } from "../_helpers/credential-store.js";

const fsControl = vi.hoisted(() => ({ events: [] as string[], failSync: false, failRename: false, deniedPath: "" }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    access: async (...args: Parameters<typeof actual.access>) => {
      if (args[0] === fsControl.deniedPath) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      return actual.access(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const sync = handle.sync.bind(handle);
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (...writeArgs: Parameters<typeof handle.writeFile>) => {
        fsControl.events.push(`write ${String(args[0])}`);
        return write(...writeArgs);
      };
      handle.sync = async () => {
        fsControl.events.push(`sync ${String(args[0])}`);
        if (fsControl.failSync) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
        return sync();
      };
      return handle;
    },
    rename: async (from: string, to: string) => {
      fsControl.events.push(`rename ${from} -> ${to}`);
      if (fsControl.failRename && from.includes(".tmp.")) throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
      return actual.rename(from, to);
    },
  };
});

const { CredentialStore } = await import("../../src/credentials/credential-store.js");
const { storeTempPath } = await import("../../src/credentials/store-write-lock.js");

describe("credential store durability", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cbe-store-sync-"));
    filePath = join(dir, "creds.enc");
    fsControl.events = [];
    fsControl.failSync = false;
    fsControl.failRename = false;
    fsControl.deniedPath = "";
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("flushes the temp file to disk before renaming it over the store", async () => {
    await new CredentialStore({ keychain: new MockKeychain(), filePath }).set("k", secret("1"));

    const tmpPath = storeTempPath(filePath);
    const storeEvents = fsControl.events.filter((event) => event.includes(tmpPath));
    expect(storeEvents).toEqual([`write ${tmpPath}`, `sync ${tmpPath}`, `rename ${tmpPath} -> ${filePath}`]);
  });

  it("keeps the previous store and leaves no temp file when the flush fails", async () => {
    const store = new CredentialStore({ keychain: new MockKeychain(), filePath });
    await store.set("before", secret("old"));
    fsControl.failSync = true;

    await expect(store.set("after", secret("new"))).rejects.toMatchObject({ code: "EIO" });

    fsControl.failSync = false;
    expect(await store.list()).toEqual(["before"]);
    expect(await tempFiles(dir)).toEqual([]);
  });

  it("keeps the previous store and leaves no temp file when the rename fails", async () => {
    const store = new CredentialStore({ keychain: new MockKeychain(), filePath });
    await store.set("before", secret("old"));
    fsControl.failRename = true;

    await expect(store.set("after", secret("new"))).rejects.toMatchObject({ code: "EBUSY" });

    fsControl.failRename = false;
    expect(await store.list()).toEqual(["before"]);
    expect(await tempFiles(dir)).toEqual([]);
  });

  it("replaces a temp file this process left behind instead of writing through it", async () => {
    const store = new CredentialStore({ keychain: new MockKeychain(), filePath });
    const decoy = join(dir, "decoy");
    await writeFile(decoy, "untouched");
    await symlink(decoy, storeTempPath(filePath));

    await store.set("k", secret("1"));

    expect(await readFile(decoy, "utf-8")).toBe("untouched");
    expect(await store.get("k")).toEqual(secret("1"));
  });

  it("refuses to create a key when it can't tell whether the store exists", async () => {
    await new CredentialStore({ keychain: new MockKeychain(), filePath }).set("before", secret("old"));
    const emptied = new MockKeychain();
    const setKey = vi.spyOn(emptied, "setKey");
    fsControl.deniedPath = filePath;

    await expect(new CredentialStore({ keychain: emptied, filePath }).set("k", secret("1"))).rejects.toThrow(/No master key found/);

    expect(setKey).not.toHaveBeenCalled();
  });
});
