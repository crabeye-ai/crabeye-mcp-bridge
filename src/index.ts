import { Command, Option } from "commander";
import {
  loadConfig,
  ConfigError,
  resolveConfigPath,
  diffConfigs,
  ConfigWatcher,
} from "./config/index.js";
import { loadMergedConfig } from "./config/merged-loader.js";
import { resolveUpstreams, isStdioServer } from "./config/schema.js";
import type { ServerBridgeConfig, ServerConfig, HttpServerConfig } from "./config/schema.js";
import { BridgeServer } from "./server/index.js";
import { RateLimiter } from "./server/rate-limiter.js";
import { ToolRegistry } from "./server/tool-registry.js";
import { ToolSearchService } from "./search/index.js";
import type { DiscoveryMode } from "./search/index.js";
import { PolicyEngine } from "./policy/index.js";
import { UpstreamManager } from "./upstream/index.js";
import { APP_NAME, APP_VERSION } from "./constants.js";
import { createLogger } from "./logging/index.js";
import {
  CredentialStore,
  CredentialSchema,
  CredentialError,
  createKeychainAdapter,
  type Credential,
} from "./credentials/index.js";
import { ProcessTracker, getProcessTrackerPath } from "./process/index.js";

function buildServerBridgeConfigs(
  upstreams: Record<string, ServerConfig>,
): Record<string, ServerBridgeConfig> {
  const result: Record<string, ServerBridgeConfig> = {};
  for (const [name, serverConfig] of Object.entries(upstreams)) {
    if ("_bridge" in serverConfig && serverConfig._bridge) {
      result[name] = serverConfig._bridge;
    }
  }
  return result;
}

const program = new Command();

program
  .name(APP_NAME)
  .description(
    "Aggregates multiple MCP servers behind a single STDIO interface",
  )
  .version(APP_VERSION)
  .option("-c, --config <path>", "path to config file")
  .option("--validate", "validate config and list upstream servers, then exit")
  .option("--stats", "include session_stats in search_tools responses")
  .addOption(
    new Option(
      "--discovery-mode <mode>",
      "how searched tools are surfaced: search (response only), tools_list (native MCP tools list only), both (default)",
    ).choices(["search", "tools_list", "both"]).default("both"),
  )
  .action(async (options) => {
    let server: BridgeServer | undefined;
    let upstreamManager: UpstreamManager | undefined;
    let toolSearchService: ToolSearchService | undefined;
    let configWatcher: ConfigWatcher | undefined;
    let processTracker: ProcessTracker | undefined;
    const rateLimiters = new Map<string, RateLimiter>();

    try {
      // Config resolution: --config / MCP_BRIDGE_CONFIG → single-file load,
      // otherwise try merged loader (bridge-owned config + client configs).
      const explicitPath = options.config || process.env.MCP_BRIDGE_CONFIG;
      let config: Awaited<ReturnType<typeof loadMergedConfig>>["config"];
      let watchPaths: string[];

      if (explicitPath) {
        // Backwards-compatible: explicit path provided
        const configPath = resolveConfigPath({ configPath: options.config });
        config = await loadConfig({ configPath });
        watchPaths = [configPath];
      } else {
        // Try merged loader (bridge-owned config + client configs)
        const merged = await loadMergedConfig();
        config = merged.config;
        watchPaths = merged.watchPaths;
      }

      const upstreams = resolveUpstreams(config);

      const logger = createLogger({
        level: config._bridge.logLevel,
        format: config._bridge.logFormat,
      });

      // --validate: print config summary and exit (always human-readable CLI output)
      if (options.validate) {
        const entries = Object.entries(upstreams);
        process.stderr.write(`Config OK — ${entries.length} upstream server${entries.length === 1 ? "" : "s"}\n`);
        for (const [name, serverConfig] of entries) {
          const transport = isStdioServer(serverConfig)
            ? "stdio"
            : (serverConfig as HttpServerConfig).type;
          const category = serverConfig._bridge?.category;
          const suffix = category ? ` [${category}]` : "";
          process.stderr.write(`  ${name} (${transport})${suffix}\n`);
        }
        return;
      }

      const toolRegistry = new ToolRegistry();
      const credentialStore = new CredentialStore({ keychain: createKeychainAdapter() });

      // Reap any subprocesses left behind by a previous run (crash, SIGKILL,
      // power loss) BEFORE we connect anything new. Otherwise we would stack
      // duplicate upstream subprocesses every time the bridge restarts.
      processTracker = new ProcessTracker({
        filePath: getProcessTrackerPath(),
        logger: logger.child({ component: "process-tracker" }),
      });
      try {
        const reaped = await processTracker.reapStale();
        if (reaped.killed > 0 || reaped.skipped > 0) {
          logger.info(
            `reaped ${reaped.killed} leaked subprocess${reaped.killed === 1 ? "" : "es"} from previous run` +
              (reaped.skipped > 0 ? ` (${reaped.skipped} skipped due to PID reuse)` : ""),
            { component: "bridge" },
          );
        }
      } catch (err) {
        logger.warn(`failed to reap stale subprocesses: ${err instanceof Error ? err.message : String(err)}`, {
          component: "bridge",
        });
      }

      upstreamManager = new UpstreamManager({
        config,
        toolRegistry,
        logger,
        credentialStore,
        processTracker,
      });

      const serverBridgeConfigs = buildServerBridgeConfigs(upstreams);

      const policyEngine = new PolicyEngine(
        config._bridge.toolPolicy,
        serverBridgeConfigs,
      );

      const discoveryMode = options.discoveryMode as DiscoveryMode;
      toolSearchService = new ToolSearchService(toolRegistry, policyEngine, discoveryMode);

      for (const [name, serverConfig] of Object.entries(upstreams)) {
        if (serverConfig._bridge?.rateLimit) {
          rateLimiters.set(name, new RateLimiter(serverConfig._bridge.rateLimit));
        }
      }

      server = new BridgeServer({
        toolRegistry,
        toolSearchService,
        policyEngine,
        getUpstreamClient: (name) => upstreamManager!.getClient(name),
        getRateLimiter: (name) => rateLimiters.get(name),
        showStats: options.stats === true,
        onSearchStats: (stats) => {
          logger.info(
            `tokens saved: ${stats.tokens_saved.toLocaleString()} (baseline: ${stats.baseline_tokens.toLocaleString()}, bridge: ${stats.bridge_tokens.toLocaleString()})`,
            { component: "stats" },
          );
        },
      });
      await server.start();

      const serverCount = Object.keys(upstreams).length;
      logger.info(`${APP_NAME} running — connecting to ${serverCount} upstream server${serverCount === 1 ? "" : "s"}`, { component: "bridge" });

      // Config hot-reload handler
      const onConfigReload = async (newConfig: typeof config) => {
        const diff = diffConfigs(config, newConfig);

        // Bridge-level hot-reloadable settings
        if (diff.bridge.logLevel) {
          logger.setLevel(diff.bridge.logLevel);
          logger.info(`log level changed to ${diff.bridge.logLevel}`, { component: "reload" });
        }

        if (diff.bridge.healthCheckInterval !== undefined) {
          upstreamManager!.restartHealthChecks(diff.bridge.healthCheckInterval);
          logger.info(`health check interval changed to ${diff.bridge.healthCheckInterval}s`, { component: "reload" });
        }

        if (diff.bridge.requiresRestart.length > 0) {
          logger.warn(
            `config changed for ${diff.bridge.requiresRestart.join(", ")} — restart required`,
            { component: "reload" },
          );
        }

        // Always update the policy engine with the full new state
        const newUpstreams = resolveUpstreams(newConfig);
        const newBridgeConfigs = buildServerBridgeConfigs(newUpstreams);
        policyEngine.update(newConfig._bridge.toolPolicy, newBridgeConfigs);

        if (diff.bridge.toolPolicy) {
          logger.info(`tool policy changed to ${diff.bridge.toolPolicy}`, { component: "reload" });
        }

        // Update rate limiters from new config
        for (const [name, serverConfig] of Object.entries(newUpstreams)) {
          const rl = serverConfig._bridge?.rateLimit;
          const existing = rateLimiters.get(name);
          if (rl && existing) {
            existing.reconfigure(rl);
          } else if (rl) {
            rateLimiters.set(name, new RateLimiter(rl));
          } else if (existing) {
            existing.dispose();
            rateLimiters.delete(name);
          }
        }
        // Remove rate limiters for servers no longer in config
        for (const name of rateLimiters.keys()) {
          if (!(name in newUpstreams)) {
            rateLimiters.get(name)!.dispose();
            rateLimiters.delete(name);
          }
        }

        // Server-level changes
        const hasServerChanges =
          diff.servers.added.length > 0 ||
          diff.servers.removed.length > 0 ||
          diff.servers.reconnect.length > 0 ||
          diff.servers.updated.length > 0;

        if (hasServerChanges) {
          await upstreamManager!.applyConfigDiff(diff, newConfig);
        }

        config = newConfig;
      };

      // Connect upstreams in the background — tools appear as each server connects.
      // Config watching starts only after initial connections settle to avoid
      // race conditions between connectAll and applyConfigDiff.
      upstreamManager.connectAll().then((result) => {
        const tools = toolRegistry.listRegisteredTools().length;
        if (result.failed.length === 0) {
          logger.info(`${APP_NAME} ready — ${tools} tools from ${result.connected} servers`, { component: "bridge" });
        } else {
          logger.warn(`${APP_NAME} ready — ${tools} tools from ${result.connected} servers (${result.failed.length} failed)`, { component: "bridge" });
          for (const f of result.failed) {
            logger.error(`${f.name}: ${f.error}`, { component: "bridge" });
          }
        }
        upstreamManager?.startHealthChecks();
      }).catch(() => {
        // Individual failures already logged by UpstreamManager.
      }).finally(() => {
        // Start config watching after initial connections settle to avoid
        // race conditions between connectAll and applyConfigDiff.
        configWatcher = new ConfigWatcher({
          configPaths: watchPaths,
          loadConfig: async () => {
            if (explicitPath) {
              return loadConfig({ configPath: explicitPath });
            }
            const merged = await loadMergedConfig();
            return merged.config;
          },
          logger,
        });
        configWatcher.start(onConfigReload, config);
      });
    } catch (err) {
      if (err instanceof ConfigError) {
        process.stderr.write(`Error: ${err.message}\n`);
        for (const issue of err.issues) {
          process.stderr.write(`  ${issue.path}: ${issue.message}\n`);
        }
        process.exitCode = 1;
        return;
      } else {
        throw err;
      }
    }

    let shuttingDown = false;
    const shutdown = async (exitCode = 0) => {
      if (shuttingDown) return;
      shuttingDown = true;
      try {
        configWatcher?.stop();
        toolSearchService?.dispose();
        for (const rl of rateLimiters.values()) {
          rl.dispose();
        }
        rateLimiters.clear();
        if (upstreamManager) {
          await upstreamManager.closeAll();
        }
        if (server) {
          await server.close();
        }
      } catch {
        // Don't prevent exit on close error
      }

      // Belt-and-suspenders: even if individual clients failed to clean up
      // their subprocess, sweep anything still tracked on disk.
      try {
        await processTracker?.reapStale();
      } catch {
        // Best-effort.
      }

      process.exit(exitCode);
    };

    process.on("SIGINT", () => void shutdown(0));
    process.on("SIGTERM", () => void shutdown(0));
    process.on("SIGHUP", () => void shutdown(0));
    // If we crash, still try to cleanly shut down — at the very least the
    // process tracker reap will kill orphaned subprocesses on the way out.
    process.on("uncaughtException", (err) => {
      try {
        process.stderr.write(`uncaughtException: ${err?.stack ?? err}\n`);
      } catch {
        // ignore
      }
      void shutdown(1);
    });
    process.on("unhandledRejection", (reason) => {
      try {
        process.stderr.write(`unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}\n`);
      } catch {
        // ignore
      }
      void shutdown(1);
    });
  });

// --- Credential helpers ---

function readStdin(): Promise<string> {
  const MAX_STDIN_BYTES = 1024 * 1024; // 1 MB
  if (process.stdin.isTTY) {
    return Promise.resolve("");
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    process.stdin.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_STDIN_BYTES) {
        process.stdin.destroy();
        reject(new Error("stdin input too large (max 1 MB)"));
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on("end", () =>
      resolve(Buffer.concat(chunks).toString("utf-8").trim()),
    );
    process.stdin.on("error", reject);
  });
}

function redact(credential: Credential): Credential {
  const mask = (value: string): string => {
    // Tokens under 20 chars are fully masked to avoid leaking most of the value.
    // Longer tokens show first 4 and last 4 characters.
    if (value.length < 20) return "****";
    return value.slice(0, 4) + "****" + value.slice(-4);
  };

  if (credential.type === "secret") {
    return { ...credential, value: mask(credential.value) };
  }

  const result = { ...credential };
  result.access_token = mask(result.access_token);
  if ("refresh_token" in result && result.refresh_token) {
    result.refresh_token = mask(result.refresh_token);
  }
  return result;
}

// --- Credential subcommand ---

const credential = program
  .command("credential")
  .description("Manage stored credentials");

credential
  .command("set <key> [value]")
  .description("Store a credential (plain string, --json for typed, or pipe to stdin)")
  .option("--json <json>", "typed credential JSON (bearer/oauth2/secret)")
  .action(async (key: string, value: string | undefined, options: { json?: string }) => {
    try {
      let cred: Credential;

      if (options.json) {
        // --json flag: parse as typed credential
        let parsed: unknown;
        try {
          parsed = JSON.parse(options.json);
        } catch {
          process.stderr.write("Error: invalid JSON\n");
          process.exitCode = 1;
          return;
        }
        const result = CredentialSchema.safeParse(parsed);
        if (!result.success) {
          process.stderr.write(`Error: invalid credential: ${result.error.message}\n`);
          process.exitCode = 1;
          return;
        }
        cred = result.data;
      } else if (value) {
        // Positional arg: store as simple secret
        cred = { type: "secret", value };
      } else {
        // Read from stdin
        const input = await readStdin();
        if (!input) {
          process.stderr.write("Error: no credential provided (pass as argument, use --json, or pipe to stdin)\n");
          process.exitCode = 1;
          return;
        }
        // Try JSON parse first; if it fails, treat as plain string
        try {
          const parsed = JSON.parse(input);
          const result = CredentialSchema.safeParse(parsed);
          if (result.success) {
            cred = result.data;
          } else {
            cred = { type: "secret", value: input };
          }
        } catch {
          cred = { type: "secret", value: input };
        }
      }

      const keychain = createKeychainAdapter();
      const store = new CredentialStore({ keychain });
      await store.set(key, cred);
      process.stderr.write(`Credential "${key}" stored\n`);
    } catch (err) {
      const message = err instanceof CredentialError ? err.message : String(err);
      process.stderr.write(`Error: ${message}\n`);
      process.exitCode = 1;
    }
  });

credential
  .command("get <key>")
  .description("Retrieve a stored credential")
  .option("--show-secret", "show full secret values")
  .action(async (key: string, options: { showSecret?: boolean }) => {
    try {
      const keychain = createKeychainAdapter();
      const store = new CredentialStore({ keychain });
      const cred = await store.get(key);

      if (!cred) {
        process.stderr.write(`Credential "${key}" not found\n`);
        process.exitCode = 1;
        return;
      }

      const output = options.showSecret ? cred : redact(cred);
      process.stdout.write(JSON.stringify(output, null, 2) + "\n");
    } catch (err) {
      const message = err instanceof CredentialError ? err.message : String(err);
      process.stderr.write(`Error: ${message}\n`);
      process.exitCode = 1;
    }
  });

credential
  .command("delete <key>")
  .description("Delete a stored credential")
  .action(async (key: string) => {
    try {
      const keychain = createKeychainAdapter();
      const store = new CredentialStore({ keychain });
      const deleted = await store.delete(key);

      if (deleted) {
        process.stderr.write(`Credential "${key}" deleted\n`);
      } else {
        process.stderr.write(`Credential "${key}" not found\n`);
        process.exitCode = 1;
      }
    } catch (err) {
      const message = err instanceof CredentialError ? err.message : String(err);
      process.stderr.write(`Error: ${message}\n`);
      process.exitCode = 1;
    }
  });

credential
  .command("list")
  .description("List all stored credential keys")
  .action(async () => {
    try {
      const keychain = createKeychainAdapter();
      const store = new CredentialStore({ keychain });
      const keys = await store.list();

      for (const k of keys) {
        process.stdout.write(k + "\n");
      }
    } catch (err) {
      const message = err instanceof CredentialError ? err.message : String(err);
      process.stderr.write(`Error: ${message}\n`);
      process.exitCode = 1;
    }
  });

// --- Init / Restore subcommands ---

program
  .command("init")
  .description("Discover MCP client configs and set up the bridge")
  .action(async () => {
    const { runInit } = await import("./commands/init.js");
    await runInit();
  });

program
  .command("restore")
  .description("Remove the bridge from client configs and restore originals")
  .action(async () => {
    const { runRestore } = await import("./commands/restore.js");
    await runRestore();
  });

program.parse();
