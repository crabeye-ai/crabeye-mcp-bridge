import { Command } from "commander";
import { loadConfig, ConfigError } from "./config/index.js";
import { BridgeServer } from "./server/index.js";

const program = new Command();

program
  .name("kokuai-bridge")
  .description(
    "Aggregates multiple MCP servers behind a single STDIO interface",
  )
  .version("0.1.0")
  .option("-c, --config <path>", "path to config file")
  .option("-p, --port <number>", "HTTP server port", parseInt)
  .option("-t, --token <string>", "authentication token")
  .action(async (options) => {
    let server: BridgeServer | undefined;

    try {
      const config = await loadConfig({ configPath: options.config });

      if (options.port !== undefined) {
        config._bridge.port = options.port;
      }

      console.error("kokuai-bridge starting with config:", config);

      server = new BridgeServer();
      await server.start();
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
