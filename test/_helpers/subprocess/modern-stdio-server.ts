import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { MODERN_STUB_DISCOVER_LOG_ENV, MODERN_STUB_START_DELAY_ENV } from "../stub-stdio-server.js";

const discoverLog = process.env[MODERN_STUB_DISCOVER_LOG_ENV];

function countDiscovers(): void {
  let pending = "";
  process.stdin.on("data", (chunk: Buffer) => {
    const lines = (pending + chunk.toString("utf-8")).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (discoverLog !== undefined && line.includes('"method":"server/discover"')) appendFileSync(discoverLog, `${process.pid}\n`);
    }
  });
}

const serve = () => serveStdio(() => {
  const server = new McpServer({ name: "modern-stub", version: "0" });
  server.registerTool("echo", { description: "Answers with a fixed text" }, () => ({ content: [{ type: "text", text: "echoed" }] }));
  server.registerTool("add-tool", { description: "Adds a tool named added" }, () => {
    server.registerTool("added", { description: "Added at runtime" }, () => ({ content: [{ type: "text", text: "added" }] }));
    return { content: [{ type: "text", text: "adding" }] };
  });
  server.registerTool("exit", { description: "Exits the process shortly after answering" }, () => {
    setTimeout(() => process.exit(1), 20);
    return { content: [{ type: "text", text: "exiting" }] };
  });
  return server;
});

setTimeout(() => {
  countDiscovers();
  serve();
}, Number(process.env[MODERN_STUB_START_DELAY_ENV] ?? 0));
