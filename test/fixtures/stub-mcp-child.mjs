// Stub MCP child for daemon tests.
//
// Speaks newline-delimited JSON-RPC over stdio (the framing the daemon's
// `ChildHandle` expects). Knobs are set via env vars so the same script can
// exercise initialize, tools/list, tools/call, list-changed, and "hang on
// tools/call" scenarios from a single Node spawn.
//
// Env knobs:
//   STUB_TOOLS_JSON: JSON array of `Tool`. Default: one tool named "echo".
//   STUB_HANG_ON_CALL: when "1", `tools/call` never responds.
//   STUB_HANG_ON_INIT: when "1", `initialize` never responds.
//   STUB_EMIT_LIST_CHANGED_AFTER_MS: emit `notifications/tools/list_changed`
//     after the given delay (set to 0 to skip).
//   STUB_EXIT_ON_CALL: when "1", exit(0) immediately after replying to any
//     `tools/call`. Used to simulate child crashes.
//   STUB_DELAY_INIT_MS: when set, delay the `initialize` reply by N ms. Used
//     by the slow-child / queue tests.

import { stdin, stdout } from "node:process";

const TOOLS_JSON =
  process.env.STUB_TOOLS_JSON ??
  '[{"name":"echo","description":"echo arguments back","inputSchema":{"type":"object"}}]';
const HANG_ON_CALL = process.env.STUB_HANG_ON_CALL === "1";
const HANG_ON_INIT = process.env.STUB_HANG_ON_INIT === "1";
const EMIT_LIST_CHANGED_AFTER_MS = Number.parseInt(
  process.env.STUB_EMIT_LIST_CHANGED_AFTER_MS ?? "0",
  10,
);
const EXIT_ON_CALL = process.env.STUB_EXIT_ON_CALL === "1";
const DELAY_INIT_MS = Number.parseInt(process.env.STUB_DELAY_INIT_MS ?? "0", 10);

const TOOLS = JSON.parse(TOOLS_JSON);

function send(payload) {
  stdout.write(JSON.stringify(payload) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function handle(msg) {
  if (typeof msg.method !== "string") return;
  if (msg.id === undefined) {
    // Notification — ignore.
    return;
  }
  switch (msg.method) {
    case "initialize":
      if (HANG_ON_INIT) return;
      if (DELAY_INIT_MS > 0) {
        setTimeout(() => {
          reply(msg.id, {
            protocolVersion: "2024-11-05",
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "stub-mcp", version: "0.0.0" },
          });
        }, DELAY_INIT_MS);
      } else {
        reply(msg.id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "stub-mcp", version: "0.0.0" },
        });
      }
      return;
    case "notifications/initialized":
      return;
    case "tools/list":
      reply(msg.id, { tools: TOOLS });
      return;
    case "tools/call": {
      if (HANG_ON_CALL) return;
      const params = msg.params ?? {};
      const name = params.name ?? "(unknown)";
      const args = params.arguments ?? {};
      reply(msg.id, {
        content: [{ type: "text", text: `${name}:${JSON.stringify(args)}` }],
      });
      if (EXIT_ON_CALL) {
        stdout.end();
        setTimeout(() => process.exit(0), 0);
      }
      return;
    }
    case "ping":
      reply(msg.id, {});
      return;
    default:
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `method not found: ${msg.method}` },
      });
  }
}

let buffer = "";
stdin.setEncoding("utf-8");
stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl = buffer.indexOf("\n");
  while (nl !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line.length > 0) {
      try {
        handle(JSON.parse(line));
      } catch (err) {
        process.stderr.write(`stub parse error: ${err.message}\n`);
      }
    }
    nl = buffer.indexOf("\n");
  }
});

stdin.on("end", () => {
  process.exit(0);
});

if (EMIT_LIST_CHANGED_AFTER_MS > 0) {
  setTimeout(() => {
    send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  }, EMIT_LIST_CHANGED_AFTER_MS);
}
