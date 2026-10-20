import { MissingRequiredClientCapabilityError, Server, inputRequired, type InputRequest, type Tool } from "@modelcontextprotocol/server";

export const INPUT_ASKING_TOOLS: Tool[] = ["ask", "sample", "roots", "resume", "needs_tasks", "needs_elicitation_and_tasks"].map((name) => ({
  name,
  inputSchema: { type: "object" },
}));

const SAMPLING_REQUEST: InputRequest = {
  method: "sampling/createMessage",
  params: { messages: [{ role: "user", content: { type: "text", text: "Draft it" } }], maxTokens: 10 },
} as InputRequest;

export function inputAskingServer(calls: string[] = []): Server {
  const server = new Server({ name: "input-asker", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler("tools/list", () => ({ tools: INPUT_ASKING_TOOLS }));
  server.setRequestHandler("tools/call", (request) => {
    const name = request.params.name;
    calls.push(name);
    if (name === "ask") {
      return inputRequired({
        inputRequests: { confirm: inputRequired.elicit({ message: "Proceed?", requestedSchema: { type: "object", properties: {} } }) },
      });
    }
    if (name === "sample") return inputRequired({ inputRequests: { draft: SAMPLING_REQUEST } });
    if (name === "roots") return inputRequired({ inputRequests: { workspace: { method: "roots/list" } as InputRequest } });
    if (name === "needs_tasks") throw new MissingRequiredClientCapabilityError({ requiredCapabilities: { tasks: {} } });
    if (name === "needs_elicitation_and_tasks") {
      throw new MissingRequiredClientCapabilityError({ requiredCapabilities: { elicitation: {}, tasks: {} } });
    }
    if (calls.filter((call) => call === "resume").length === 1) return inputRequired({ requestState: "resume-1" });
    return { content: [{ type: "text" as const, text: "resumed" }] };
  });
  return server;
}
