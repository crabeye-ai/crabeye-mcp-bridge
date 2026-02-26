import { Command } from "commander";
import {
  loadConfig,
  ConfigError,
  resolveConfigPath,
  diffConfigs,
  ConfigWatcher,
} from "./config/index.js";
import { resolveUpstreams, isStdioServer } from "./config/schema.js";
import type { ServerBridgeConfig, ServerConfig, HttpServerConfig } from "./config/schema.js";
import { BridgeServer } from "./server/index.js";
import { ToolRegistry } from "./server/tool-registry.js";
import { ToolSearchService } from "./search/index.js";
import { PolicyEngine } from "./policy/index.js";
import { UpstreamManager } from "./upstream/index.js";
import { APP_NAME, APP_VERSION } from "./constants.js";
import { createLogger } from "./logging/index.js";

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
  .action(async (options) => {
    let server: BridgeServer | undefined;
    let upstreamManager: UpstreamManager | undefined;
    let toolSearchService: ToolSearchService | undefined;
    let configWatcher: ConfigWatcher | undefined;

    try {
      const configPath = resolveConfigPath({ configPath: options.config });
      let config = await loadConfig({ configPath });
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
      upstreamManager = new UpstreamManager({ config, toolRegistry, logger });

      const serverBridgeConfigs = buildServerBridgeConfigs(upstreams);

      const policyEngine = new PolicyEngine(
        config._bridge.toolPolicy,
        serverBridgeConfigs,
      );

      toolSearchService = new ToolSearchService(toolRegistry, policyEngine);

      server = new BridgeServer({
        toolRegistry,
        toolSearchService,
        policyEngine,
        getUpstreamClient: (name) => upstreamManager!.getClient(name),
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
        const newBridgeConfigs = buildServerBridgeConfigs(resolveUpstreams(newConfig));
        policyEngine.update(newConfig._bridge.toolPolicy, newBridgeConfigs);

        if (diff.bridge.toolPolicy) {
          logger.info(`tool policy changed to ${diff.bridge.toolPolicy}`, { component: "reload" });
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
        configWatcher = new ConfigWatcher({ configPath, logger });
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
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      try {
        configWatcher?.stop();
        toolSearchService?.dispose();
        if (upstreamManager) {
          await upstreamManager.closeAll();
        }
        if (server) {
          await server.close();
        }
      } catch {
        // Don't prevent exit on close error
      }
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

program.parse();
