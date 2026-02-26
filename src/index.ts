import { Command } from "commander";
import { loadConfig, ConfigError } from "./config/index.js";
import { resolveUpstreams, isStdioServer } from "./config/schema.js";
import type { ServerBridgeConfig, HttpServerConfig } from "./config/schema.js";
import { BridgeServer } from "./server/index.js";
import { ToolRegistry } from "./server/tool-registry.js";
import { ToolSearchService } from "./search/index.js";
import { PolicyEngine } from "./policy/index.js";
import { UpstreamManager } from "./upstream/index.js";
import { APP_NAME, APP_VERSION } from "./constants.js";

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

    try {
      const config = await loadConfig({ configPath: options.config });
      const upstreams = resolveUpstreams(config);

      // --validate: print config summary and exit
      if (options.validate) {
        const entries = Object.entries(upstreams);
        console.error(`Config OK — ${entries.length} upstream server${entries.length === 1 ? "" : "s"}`);
        for (const [name, serverConfig] of entries) {
          const transport = isStdioServer(serverConfig)
            ? "stdio"
            : (serverConfig as HttpServerConfig).type;
          const category = serverConfig._bridge?.category;
          const suffix = category ? ` [${category}]` : "";
          console.error(`  ${name} (${transport})${suffix}`);
        }
        return;
      }

      const toolRegistry = new ToolRegistry();
      upstreamManager = new UpstreamManager({ config, toolRegistry });

      // Build per-server bridge configs for the policy engine
      const serverBridgeConfigs: Record<string, ServerBridgeConfig> = {};
      for (const [name, serverConfig] of Object.entries(upstreams)) {
        if ("_bridge" in serverConfig && serverConfig._bridge) {
          serverBridgeConfigs[name] = serverConfig._bridge;
        }
      }

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
      console.error(`${APP_NAME} running — connecting to ${serverCount} upstream server${serverCount === 1 ? "" : "s"}`);

      // Connect upstreams in the background — tools appear as each server connects
      upstreamManager.connectAll().then((result) => {
        const tools = toolRegistry.listRegisteredTools().length;
        if (result.failed.length === 0) {
          console.error(`${APP_NAME} ready — ${tools} tools from ${result.connected} servers`);
        } else {
          console.error(`${APP_NAME} ready — ${tools} tools from ${result.connected} servers (${result.failed.length} failed)`);
          for (const f of result.failed) {
            console.error(`  ${f.name}: ${f.error}`);
          }
        }
      }).catch(() => {
        // Individual failures already logged by UpstreamManager
      });
    } catch (err) {
      if (err instanceof ConfigError) {
        console.error(`Error: ${err.message}`);
        for (const issue of err.issues) {
          console.error(`  ${issue.path}: ${issue.message}`);
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
