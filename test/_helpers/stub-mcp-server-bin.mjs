#!/usr/bin/env node
// Stub MCP server for AIT-248 integration tests.
// Speaks newline-delimited JSON-RPC 2.0 over stdio.
//
// Tool: `emit_request`. Calling it causes the stub to first emit a
// server→client request (default: sampling/createMessage) on stdout, then
// respond to the tools/call. The method name can be overridden via
// the tool args: `{ "name": "emit_request", "arguments": { "method": "roots/list" } }`.

import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, terminal: false });
let nextServerRequestId = 100000;

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  // Initialize handshake.
  if (msg.method === "initialize") {
    respond(msg.id, {
      protocolVersion: "2025-06-18",
      serverInfo: { name: "stub-mcp", version: "0.0.0" },
      capabilities: {
        tools: { listChanged: false },
      },
    });
    return;
  }

  // Initialized notification — no reply.
  if (msg.method === "notifications/initialized") return;

  // Tools list.
  if (msg.method === "tools/list") {
    respond(msg.id, {
      tools: [
        {
          name: "emit_request",
          description: "Emit a server→client request (for AIT-248 fork tests).",
          inputSchema: {
            type: "object",
            properties: {
              method: { type: "string", description: "Dangerous method to emit" },
            },
          },
        },
      ],
    });
    return;
  }

  // Tools call.
  if (msg.method === "tools/call") {
    const name = msg.params?.name;
    if (name === "emit_request") {
      const serverRequestMethod = msg.params?.arguments?.method ?? "sampling/createMessage";
      // Emit server→client request first.
      emit({
        jsonrpc: "2.0",
        id: nextServerRequestId++,
        method: serverRequestMethod,
        params: {},
      });
      // Then respond to the tools/call.
      respond(msg.id, {
        content: [{ type: "text", text: "ok" }],
      });
      return;
    }
    respond(msg.id, undefined, {
      code: -32601,
      message: `Unknown tool: ${name}`,
    });
    return;
  }

  // Drop sampling/createMessage / roots/list / etc. responses from the bridge —
  // we don't track them. The daemon routes them; the stub doesn't care.
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    return;
  }

  // Drop unknown methods silently to avoid breaking the daemon's routing.
});

function respond(id, result, error) {
  const frame = error !== undefined
    ? { jsonrpc: "2.0", id, error }
    : { jsonrpc: "2.0", id, result };
  process.stdout.write(JSON.stringify(frame) + "\n");
}

function emit(frame) {
  process.stdout.write(JSON.stringify(frame) + "\n");
}
