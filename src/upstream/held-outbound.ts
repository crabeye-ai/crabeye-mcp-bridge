import type { JSONRPCMessage } from "@modelcontextprotocol/client";
import { hasMethod, requestIdOf, type RequestId } from "./jsonrpc-ids.js";

export class HeldOutbound {
  private messages: JSONRPCMessage[] = [];

  hold(message: JSONRPCMessage): void {
    if (hasMethod(message)) this.messages.push(message);
  }

  cancel(id: RequestId): boolean {
    const index = this.messages.findIndex((m) => requestIdOf(m) === id);
    if (index === -1) return false;
    this.messages.splice(index, 1);
    return true;
  }

  drain(): JSONRPCMessage[] {
    const drained = this.messages;
    this.messages = [];
    return drained;
  }
}
