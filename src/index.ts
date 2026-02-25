import { Command } from "commander";
import { loadConfig, ConfigError } from "./config/index.js";
import { BridgeServer } from "./server/index.js";
import { ToolRegistry } from "./server/tool-registry.js";
import { ToolSearchService } from "./search/index.js";
import { UpstreamManager } from "./upstream/index.js";

const program = new Command();

program
  .name("crabeye-mcp-bridge")
  .description(
    "Aggregates multiple MCP servers behind a single STDIO interface",
  )
  .version("0.1.0")
  .option("-c, --config <path>", "path to config file")
  .option("-p, --port <number>", "HTTP server port", parseInt)
  .option("-t, --token <string>", "authentication token")
  .action(async (options) => {
    let server: BridgeServer | undefined;
    let upstreamManager: UpstreamManager | undefined;
    let toolSearchService: ToolSearchService | undefined;

    try {
      const config = await loadConfig({ configPath: options.config });

      if (options.port !== undefined) {
        config._bridge.port = options.port;
      }

      const toolRegistry = new ToolRegistry();
      upstreamManager = new UpstreamManager({ config, toolRegistry });

      await upstreamManager.connectAll();

      toolSearchService = new ToolSearchService(toolRegistry);

      server = new BridgeServer({
        toolRegistry,
        toolSearchService,
        getUpstreamClient: (name) => upstreamManager!.getClient(name),
      });
      await server.start();

      console.error(
        `crabeye-mcp-bridge running — ${toolRegistry.listRegisteredTools().length} tools indexed from ${upstreamManager.getStatuses().length} servers`,
      );
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
