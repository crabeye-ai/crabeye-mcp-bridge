import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { FrameDecoder, encodeFrame, FrameError } from "./protocol.js";

export interface FrameChannel extends EventEmitter {
  send(payload: unknown): boolean;
  close(): void;
  readonly remote: string;
}

export type ConnectionHandler = (channel: FrameChannel) => void;

export interface DaemonServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly address: string;
}

export interface DaemonServerOptions {
  path: string;
  onConnection: ConnectionHandler;
  onError?: (err: Error) => void;
}

export interface DaemonClientOptions {
  path: string;
  connectTimeoutMs?: number;
}

export type ConnectFn = (opts: DaemonClientOptions) => Promise<FrameChannel>;
export type CreateServerFn = (opts: DaemonServerOptions) => DaemonServer;

export interface Transport {
  createServer: CreateServerFn;
  connect: ConnectFn;
}

export function wrapSocket(socket: Socket, remote: string): FrameChannel {
  const emitter = new EventEmitter() as FrameChannel;
  const decoder = new FrameDecoder();
  let closed = false;

  socket.on("data", (chunk: Buffer) => {
    try {
      decoder.push(chunk);
      for (;;) {
        const msg = decoder.next();
        if (msg === null) break;
        emitter.emit("message", msg);
      }
    } catch (err) {
      // Any decode failure means the framing is corrupt and we cannot
      // recover state on this connection — surface and tear down.
      emitter.emit("error", err instanceof FrameError ? err : (err as Error));
      socket.destroy();
    }
  });

  socket.on("error", (err) => {
    if (!closed) emitter.emit("error", err);
  });

  socket.on("close", () => {
    if (closed) return;
    closed = true;
    emitter.emit("close");
  });

  Object.defineProperty(emitter, "remote", { value: remote, enumerable: true });

  emitter.send = (payload: unknown): boolean => {
    if (closed) return false;
    try {
      return socket.write(encodeFrame(payload));
    } catch (err) {
      emitter.emit("error", err as Error);
      return false;
    }
  };

  emitter.close = (): void => {
    if (closed) return;
    closed = true;
    socket.end();
  };

  return emitter;
}
