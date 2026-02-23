import { Command } from "commander";

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
  .action((options) => {
    console.log("kokuai-bridge starting with options:", options);
  });

program.parse();
