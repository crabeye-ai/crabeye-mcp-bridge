import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { leftOutWarning, loadMergedConfig } from "../../../src/config/merged-loader.js";
import type { CredentialStore } from "../../../src/credentials/credential-store.js";
import { Instance, type InstanceDeps, type InstanceNotification } from "../../../src/daemon/instances/instance.js";
import { UpstreamPool } from "../../../src/daemon/instances/upstream-pool.js";
import { watching } from "../../_helpers/fs-watch-tracker.js";
import { rewriteUntil } from "../../_helpers/rewrite-until.js";
import { ScriptedStdioClient, ScriptedUpstreamClient, stdioPoolOptions } from "../../_helpers/scripted-upstream-client.js";
import { spyLogger, type SpyLogger } from "../../_helpers/spy-logger.js";

vi.mock("node:fs", async (importOriginal) => (await import("../../_helpers/fs-watch-tracker.js")).trackWatch(await importOriginal()));

const watchingFile = (path: string): boolean => watching(dirname(path));

const server = (name: string) => ({ [name]: { url: `https://${name}.example.com/mcp` } });

describe("Instance following edits to a merged config", { timeout: 30_000 }, () => {
  const dirs: string[] = [];
  let configJson: string;
  let first: string;
  let second: string;
  let pool: UpstreamPool;
  let deps: InstanceDeps;
  let instance: Instance | undefined;
  let notifications: InstanceNotification[];
  let log: SpyLogger;

  const dir = async () => {
    const created = await mkdtemp(join(tmpdir(), "cbe-instance-watch-"));
    dirs.push(created);
    return created;
  };
  const write = (path: string, content: unknown) => writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
  const upstreams = () => instance!.status().upstreams;
  const failures = (sent = notifications) => sent.filter((n) => n.method === "LOG" && n.params.message === "failed to reload config");
  const loggedFailures = () => log.warn.mock.calls.filter(([message]) => message === "failed to reload config");
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

  async function open(): Promise<void> {
    instance = await Instance.open({ kind: "merged", path: configJson }, { env: {}, childEnv: {} }, deps);
    instance.attach({ send: (n) => notifications.push(n) });
  }

  beforeEach(async () => {
    configJson = join(await dir(), "config.json");
    first = join(await dir(), "first.json");
    second = join(await dir(), "second.json");
    notifications = [];
    pool = new UpstreamPool({
      logger: spyLogger(),
      stdio: stdioPoolOptions({ createClient: (options) => new ScriptedStdioClient(options.name) }),
      createHttpClient: (name) => new ScriptedUpstreamClient(name),
    });
    deps = {
      pool,
      logger: (log = spyLogger()),
      loadConfig: (source) => loadMergedConfig({ bridgeConfigPath: source.path }),
      createCredentialStore: () => ({}) as CredentialStore,
      watchDebounceMs: 20,
    };
    await write(first, { mcpServers: server("one") });
    await write(second, { mcpServers: server("two") });
    await write(configJson, { configPaths: [first] });
  });

  afterEach(async () => {
    await instance?.close();
    instance = undefined;
    await pool.close(0);
    await Promise.all(dirs.splice(0).map((created) => rm(created, { recursive: true, force: true })));
  });

  it("applies an edit to config.json", async () => {
    await open();

    await rewriteUntil(() => write(configJson, { configPaths: [first], servers: server("fresh") }), () => expect(upstreams()).toEqual(["fresh", "one"]));
  });

  it("watches a client file an edit to config.json lists, so an edit to that file applies", async () => {
    await open();
    expect([watchingFile(configJson), watchingFile(second)]).toEqual([true, false]);
    await rewriteUntil(() => write(configJson, { configPaths: [first, second] }), () => expect(upstreams()).toEqual(["one", "two"]));
    await vi.waitFor(() => expect(watchingFile(second)).toBe(true));

    await rewriteUntil(() => write(second, { mcpServers: { ...server("two"), ...server("three") } }), () => expect(upstreams()).toEqual(["one", "three", "two"]));

    await instance!.close();
    expect([watchingFile(configJson), watchingFile(second)]).toEqual([false, false]);
  });

  it("applies an edit made while a bridge's attach is loading the config, telling that bridge", async () => {
    await open();
    await rewriteUntil(() => write(configJson, { configPaths: [first], servers: server("warm") }), () => expect(upstreams()).toEqual(["one", "warm"]));
    await settle();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let loads = 0;
    const load = deps.loadConfig;
    deps.loadConfig = async (source) => {
      const loaded = await load(source);
      loads++;
      await gate;
      return loaded;
    };
    const reload = vi.spyOn(instance!, "reload");
    const attached: InstanceNotification[] = [];
    const admitting = instance!.admit({ send: (n) => attached.push(n) }, true);
    await vi.waitFor(() => expect(loads).toBe(1));

    await write(configJson, { configPaths: [first], servers: server("fresh") });
    await vi.waitFor(() => expect(reload.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 5_000 });
    release();
    await admitting;

    await vi.waitFor(() => expect(upstreams()).toEqual(["fresh", "one"]), { timeout: 10_000, interval: 50 });
    expect(attached).toContainEqual(expect.objectContaining({ method: "UPSTREAM", params: expect.objectContaining({ name: "fresh" }) }));
  });

  it("applies only the last of two edits made together", async () => {
    deps.watchDebounceMs = 150;
    await open();
    await rewriteUntil(() => write(configJson, { configPaths: [first], servers: server("warm") }), () => expect(upstreams()).toEqual(["one", "warm"]));
    await settle();

    await write(configJson, { configPaths: [first], servers: server("early") });
    await write(configJson, { configPaths: [first], servers: server("late") });

    await vi.waitFor(() => expect(upstreams()).toEqual(["late", "one"]), { timeout: 10_000, interval: 50 });
    expect(notifications).not.toContainEqual(expect.objectContaining({ method: "UPSTREAM", params: expect.objectContaining({ name: "early" }) }));
  });

  it("applies a log level set in config.json to every attached bridge", async () => {
    await open();

    await rewriteUntil(
      () => write(configJson, { configPaths: [first], _bridge: { logLevel: "debug" } }),
      () => expect(notifications).toContainEqual({ method: "SETTINGS", params: { logLevel: "debug" } }),
    );
  });

  it("keeps the last config while config.json is deleted, saying so once in the manager log and to each bridge, and applies it once it's back", async () => {
    await open();
    const other: InstanceNotification[] = [];
    instance!.attach({ send: (n) => other.push(n) });

    await rewriteUntil(
      async () => {
        await write(configJson, { configPaths: [first] });
        await unlink(configJson);
      },
      () => expect(failures()).toHaveLength(1),
    );
    expect(failures()[0]!.params).toMatchObject({ level: "warn", context: { error: expect.stringContaining("No config found") } });
    expect(upstreams()).toEqual(["one"]);

    await rewriteUntil(() => write(configJson, { configPaths: [first], servers: server("back") }), () => expect(upstreams()).toEqual(["back", "one"]));
    expect([failures().length, failures(other).length, loggedFailures().length]).toEqual([1, 1, 1]);
  });

  it("keeps the last config while config.json isn't valid, saying so once in the manager log and to each bridge, and applies it once fixed", async () => {
    await open();
    const other: InstanceNotification[] = [];
    instance!.attach({ send: (n) => other.push(n) });

    await rewriteUntil(() => write(configJson, "{ not json"), () => expect(failures()).toHaveLength(1));
    expect(upstreams()).toEqual(["one"]);

    await rewriteUntil(() => write(configJson, { configPaths: [first], servers: server("fixed") }), () => expect(upstreams()).toEqual(["fixed", "one"]));
    expect([failures().length, failures(other).length, loggedFailures().length]).toEqual([1, 1, 1]);
  });

  it("leaves out a newly listed client file that isn't JSON, warning once, and applies the rest of the edit", async () => {
    await open();
    await write(second, "{ not json");

    await rewriteUntil(() => write(configJson, { configPaths: [first, second], servers: server("fresh") }), () => expect(upstreams()).toEqual(["fresh", "one"]));

    const warning = leftOutWarning({ path: second, message: `Invalid JSON in config file: ${second}` });
    expect(notifications.filter((n) => n.method === "LOG" && n.params.message === warning)).toHaveLength(1);
  });

  it("reloads on an edit to a client file config.json no longer lists, changing nothing", async () => {
    await write(configJson, { configPaths: [first, second] });
    await open();
    await rewriteUntil(() => write(configJson, { configPaths: [first] }), () => expect(upstreams()).toEqual(["one"]));
    await settle();
    let loads = 0;
    const load = deps.loadConfig;
    deps.loadConfig = (source) => {
      loads++;
      return load(source);
    };
    const sent = notifications.length;
    const applied = log.info.mock.calls.length;

    await rewriteUntil(() => write(second, { mcpServers: { ...server("two"), ...server("three") } }), () => expect(loads).toBeGreaterThan(0));
    await instance!.reload();

    expect(watchingFile(second)).toBe(true);
    expect(upstreams()).toEqual(["one"]);
    expect(notifications.slice(sent)).toEqual([]);
    expect(log.info.mock.calls.slice(applied)).not.toContainEqual(["applying changed config"]);
  });

  it("applies nothing a reload loads after the instance starts closing", async () => {
    await open();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const load = deps.loadConfig;
    deps.loadConfig = async (source) => {
      await gate;
      return load(source);
    };
    await write(configJson, { configPaths: [first], servers: server("fresh") });
    const acquire = vi.spyOn(pool, "acquire");
    const reloading = instance!.reload();

    await instance!.close();
    release();
    await reloading;

    expect(acquire).not.toHaveBeenCalled();
  });

  it("logs a config it fails to apply, and applies it at the next reload", async () => {
    await open();
    vi.spyOn(pool, "acquire").mockImplementationOnce(() => {
      throw new Error("boom");
    });
    await write(configJson, { configPaths: [first], servers: server("fresh") });

    await instance!.reload();
    await instance!.reload();

    expect(log.error).toHaveBeenCalledWith("failed to apply config", { error: "boom" });
    expect(upstreams()).toEqual(["fresh", "one"]);
  });

  it("converges on the earlier config when an edit fails partway and is then undone", async () => {
    await open();
    const acquire = pool.acquire.bind(pool);
    vi.spyOn(pool, "acquire")
      .mockImplementationOnce(acquire)
      .mockImplementationOnce(() => {
        throw new Error("boom");
      });
    await write(configJson, { configPaths: [first], servers: { ...server("fresh"), ...server("more") } });
    await instance!.reload();
    await write(configJson, { configPaths: [first] });

    await instance!.reload();

    expect(upstreams()).toEqual(["one"]);
  });
});
