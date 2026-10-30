import { createServer, type Server, type Socket } from "node:net";
import { encodeFrame, FrameDecoder } from "../../src/daemon/protocol.js";

export const NO_REPLY = Symbol("no reply");
export const DROP_CONNECTION = Symbol("drop connection");

/** Returned by a reply function to answer with this error instead of a result. */
export class ErrorReply {
  constructor(
    readonly code: string,
    readonly message: string,
  ) {}
}

export interface FrameRequest {
  id: string;
  method: string;
  params?: unknown;
}

/**
 * Listens on `path` like a daemon. Answers each request frame with what
 * `reply` returns, or what its promise resolves to: a result, an `ErrorReply`
 * as an error, or nothing for `NO_REPLY`; `DROP_CONNECTION` closes the
 * connection.
 */
export function serveFrames(path: string, reply: (request: FrameRequest, server: Server) => unknown): Promise<Server> {
  const server = createServer((sock: Socket) => {
    const decoder = new FrameDecoder();
    sock.on("data", (chunk: Buffer) => {
      decoder.push(chunk);
      for (let frame = decoder.next(); frame !== null; frame = decoder.next()) {
        const request = frame as FrameRequest;
        const result = reply(request, server);
        if (result instanceof Promise) void result.then((settled: unknown) => answer(sock, request.id, settled));
        else answer(sock, request.id, result);
        if (result === DROP_CONNECTION) return;
      }
    });
  });
  return new Promise((resolve) => server.listen(path, () => resolve(server)));
}

function answer(sock: Socket, id: string, result: unknown): void {
  if (result === DROP_CONNECTION) sock.destroy();
  else if (result instanceof ErrorReply) sock.write(encodeFrame({ id, error: { code: result.code, message: result.message } }));
  else if (result !== NO_REPLY) sock.write(encodeFrame({ id, result }));
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => (server.listening ? server.close(() => resolve()) : resolve()));
}
