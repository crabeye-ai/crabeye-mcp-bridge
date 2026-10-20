export const STUB_STARTUP_ERROR_ENV = "STUB_STARTUP_ERROR";
export const STUB_EXIT_ON_TOOLS_LIST_ENV = "STUB_EXIT_ON_TOOLS_LIST";

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
const serve = () => onNewlineOnlyLines((line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined || msg.method === undefined) return;
  if (msg.method === "initialize") {
    reply(msg.id, { result: { protocolVersion: msg.params.protocolVersion, serverInfo: { name: "stub", version: "0" }, capabilities: { tools: {} } } });
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
