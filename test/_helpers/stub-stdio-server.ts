import { readFile } from "node:fs/promises";
export const STUB_STARTUP_ERROR_ENV = "STUB_STARTUP_ERROR";
export const STUB_EXIT_ON_TOOLS_LIST_ENV = "STUB_EXIT_ON_TOOLS_LIST";
export const STUB_IGNORE_DISCOVER_ENV = "STUB_IGNORE_DISCOVER";
/** Makes the stub exit when it gets the protocol version question, as servers that refuse anything before `initialize` do. */
export const STUB_EXIT_ON_DISCOVER_ENV = "STUB_EXIT_ON_DISCOVER";
/** Makes the stub answer the protocol version question with an error, then exit. */
export const STUB_ERROR_THEN_EXIT_ON_DISCOVER_ENV = "STUB_ERROR_THEN_EXIT_ON_DISCOVER";
export const MODERN_STUB_DISCOVER_LOG_ENV = "MODERN_STUB_DISCOVER_LOG";
export const MODERN_STUB_START_DELAY_ENV = "MODERN_STUB_START_DELAY_MS";
/** A file the stub appends every method it receives to, one `<pid> <method>` per line. */
export const STUB_METHOD_LOG_ENV = "STUB_METHOD_LOG";
/** Makes the stub refuse every request but `initialize` until `notifications/initialized` arrives, as strict legacy servers do. */
export const STUB_STRICT_ENV = "STUB_STRICT";

export const STUB_STDIO_SERVER = `
const reply = (id, body) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...body }) + "\\n");
const text = (id, value) => reply(id, { result: { content: [{ type: "text", text: value }] } });
let answersPings = true;
const tools = {
  slow: (id, args) => setTimeout(() => text(id, "slow done"), args.ms),
  stderr: (id, args) => process.stderr.write(args.text + "\\n", () => text(id, "written")),
  crash: (id, args) => {
    if (args.keepStderrOpen) {
      const holder = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], { stdio: ["ignore", "ignore", "inherit"], detached: true });
      process.stderr.write("grandchild " + holder.pid + "\\n");
    }
    process.stderr.write(args.lines.map((line) => line + "\\n").join(""), () => process.exit(args.code));
  },
  "stderr-flood": (id) => {
    setInterval(() => process.stderr.write("flood line\\n".repeat(100)), 1);
    text(id, "flooding");
  },
  "stderr-endless": (id) => {
    setInterval(() => process.stderr.write("y".repeat(4096)), 1);
    text(id, "endless");
  },
  "stdout-flood": () => process.stdout.write("x".repeat(9 * 1024 * 1024)),
  "add-tool": (id, args) => {
    TOOLS.push(args.name);
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }) + "\\n");
    text(id, "added");
  },
  env: (id) => text(id, JSON.stringify(process.env)),
  "close-stdout": (id) => {
    text(id, "closing");
    setTimeout(() => require("node:fs").closeSync(1), 50);
    setInterval(() => {}, 1e6);
  },
  cwd: (id) => text(id, process.cwd()),
  "ignore-pings": (id) => {
    answersPings = false;
    text(id, "ignoring pings");
  },
  "log-message": (id) => {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "upstream log" } }) + "\\n");
    text(id, "logged");
  },
};
const TOOLS = ["plain", ...Object.keys(tools)];
const onNewlineOnlyLines = (handle) => {
  let buffered = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => {
    const lines = (buffered + chunk).split("\\n");
    buffered = lines.pop();
    for (const line of lines) if (line.trim() !== "") handle(line);
  });
};
let initialized = false;
const serve = () => onNewlineOnlyLines((line) => {
  const msg = JSON.parse(line);
  if (process.env.${STUB_METHOD_LOG_ENV} && msg.method !== undefined) require("node:fs").appendFileSync(process.env.${STUB_METHOD_LOG_ENV}, process.pid + " " + msg.method + "\\n");
  if (msg.method === "notifications/initialized") initialized = true;
  if (msg.id === undefined || msg.method === undefined) return;
  if (process.env.${STUB_STRICT_ENV} && !initialized && msg.method !== "initialize" && msg.method !== "ping") {
    reply(msg.id, { error: { code: -32002, message: "Server not initialized" } });
  } else if (msg.method === "initialize") {
    reply(msg.id, { result: { protocolVersion: msg.params.protocolVersion, serverInfo: { name: "stub", version: "0" }, capabilities: { tools: { listChanged: true } } } });
  } else if (msg.method === "server/discover" && process.env.${STUB_IGNORE_DISCOVER_ENV}) {
    return;
  } else if (msg.method === "server/discover" && process.env.${STUB_EXIT_ON_DISCOVER_ENV}) {
    process.exit(1);
  } else if (msg.method === "server/discover" && process.env.${STUB_ERROR_THEN_EXIT_ON_DISCOVER_ENV}) {
    reply(msg.id, { error: { code: -32601, message: "Method not found" } });
    setImmediate(() => process.exit(1));
  } else if (msg.method === "tools/list" && process.env.${STUB_EXIT_ON_TOOLS_LIST_ENV}) {
    process.stderr.write("Error: cannot list tools\\n", () => process.exit(4));
  } else if (msg.method === "tools/list") {
    reply(msg.id, { result: { tools: TOOLS.map((name) => ({ name, inputSchema: { type: "object" } })) } });
  } else if (msg.method === "ping") {
    if (answersPings) reply(msg.id, { result: {} });
  } else if (msg.method === "tools/call") {
    const run = tools[msg.params.name];
    if (run) run(msg.id, msg.params.arguments ?? {});
    else text(msg.id, "called " + msg.params.name);
  } else {
    reply(msg.id, { error: { code: -32601, message: "Method not found" } });
  }
});
const startupError = process.env.${STUB_STARTUP_ERROR_ENV};
if (startupError) process.stderr.write(startupError + "\\n", () => process.exit(1));
else serve();
`;

/** The methods stub servers logged to `path`, oldest first, from every process or only from `pid`. */
export async function readMethodLog(path: string, pid?: number): Promise<string[]> {
  const lines = (await readFile(path, "utf-8").catch(() => "")).split("\n").filter(Boolean);
  return lines.filter((line) => pid === undefined || line.startsWith(`${pid} `)).map((line) => line.slice(line.indexOf(" ") + 1));
}
