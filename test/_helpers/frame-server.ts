import { createServer, type Server, type Socket } from "node:net";
import { encodeFrame, FrameDecoder } from "../../src/daemon/protocol.js";

export const NO_REPLY = Symbol("no reply");
export const DROP_CONNECTION = Symbol("drop connection");

export interface FrameRequest {
  id: string;
  method: string;
  params?: unknown;
}

/** Listens on `path` like a daemon, answering every request frame with `reply`'s result, unless it returns `NO_REPLY` or `DROP_CONNECTION`. */
export function serveFrames(path: string, reply: (request: FrameRequest, server: Server) => unknown): Promise<Server> {
  const server = createServer((sock: Socket) => {
    const decoder = new FrameDecoder();
    sock.on("data", (chunk: Buffer) => {
      decoder.push(chunk);
      for (let frame = decoder.next(); frame !== null; frame = decoder.next()) {
        const request = frame as FrameRequest;
        const result = reply(request, server);
        if (result === DROP_CONNECTION) {
          sock.destroy();
          return;
        }
        if (result !== NO_REPLY) sock.write(encodeFrame({ id: request.id, result }));
      }
    });
  });
  return new Promise((resolve) => server.listen(path, () => resolve(server)));
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => (server.listening ? server.close(() => resolve()) : resolve()));
}
