export const STUB_STDIO_SERVER = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const reply = (id, body) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...body }) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined || msg.method === undefined) return;
  if (msg.method === "initialize") {
    reply(msg.id, { result: { protocolVersion: msg.params.protocolVersion, serverInfo: { name: "stub", version: "0" }, capabilities: { tools: {} } } });
  } else if (msg.method === "tools/list") {
    reply(msg.id, { result: { tools: [{ name: "plain", inputSchema: { type: "object" } }, { name: "slow", inputSchema: { type: "object" } }] } });
  } else if (msg.method === "tools/call" && msg.params.name === "slow") {
    setTimeout(() => reply(msg.id, { result: { content: [{ type: "text", text: "slow done" }] } }), msg.params.arguments.ms);
  } else if (msg.method === "tools/call") {
    reply(msg.id, { result: { content: [{ type: "text", text: "called " + msg.params.name }] } });
  } else {
    reply(msg.id, { error: { code: -32601, message: "Method not found" } });
  }
});
`;
