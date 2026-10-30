import { InMemoryTransport, Server } from "@modelcontextprotocol/server";
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/client";

export function hangingTransport(release: Promise<void>, error = new Error("released")): Transport {
  const transport: Transport = {
    async start() {
      await release;
      throw error;
    },
    async send() {},
    async close() {
      transport.onclose?.();
    },
  };
  return transport;
}

export interface ServingOptions {
  gate?: Promise<void>;
  requestFailure?: (method: string) => Error | undefined;
  onClose?: () => void;
}

export function servingTransport(options: ServingOptions = {}): Transport {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name: "upstream", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler("tools/list", () => ({ tools: [] }));
  server.setRequestHandler("tools/call", () => ({ content: [] }));
  void server.connect(serverSide);
  const start = clientSide.start.bind(clientSide);
  const send = clientSide.send.bind(clientSide);
  const close = clientSide.close.bind(clientSide);
  clientSide.start = async () => {
    await options.gate;
    await start();
  };
  clientSide.send = async (message: JSONRPCMessage, sendOptions) => {
    const failure = "method" in message ? options.requestFailure?.(message.method) : undefined;
    if (failure) throw failure;
    await send(message, sendOptions);
  };
  clientSide.close = async () => {
    options.onClose?.();
    await close();
  };
  return clientSide;
}
