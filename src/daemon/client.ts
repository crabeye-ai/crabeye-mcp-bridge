import { randomUUID } from "node:crypto";
import type { DaemonRequest, DaemonResponse } from "./protocol.js";
import type { FrameChannel, Transport } from "./transport.js";

export class DaemonRpcError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DaemonRpcError";
  }
}

export interface DaemonClientOpts {
  socketPath: string;
  transport: Transport;
  rpcTimeoutMs?: number;
  connectTimeoutMs?: number;
}

const DEFAULT_RPC_TIMEOUT_MS = 5_000;

export class DaemonClient {
  private channel: FrameChannel | null = null;
  private closed = false;
  private pending = new Map<
    string,
    { resolve: (r: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor(private readonly opts: DaemonClientOpts) {}

  async connect(): Promise<void> {
    if (this.closed) throw new Error("daemon client is closed");
    if (this.channel !== null) return;
    const channel = await this.opts.transport.connect({
      path: this.opts.socketPath,
      connectTimeoutMs: this.opts.connectTimeoutMs,
    });
    channel.on("message", (msg: unknown) => {
      const res = msg as DaemonResponse;
      if (typeof res?.id !== "string") return;
      const entry = this.pending.get(res.id);
      if (entry === undefined) return;
      this.pending.delete(res.id);
      clearTimeout(entry.timer);
      if (res.error) {
        entry.reject(new DaemonRpcError(res.error.code, res.error.message));
      } else {
        entry.resolve(res.result);
      }
    });
    channel.on("close", () => {
      this.channel = null;
      const closeErr = new Error("daemon connection closed");
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(closeErr);
      }
      this.pending.clear();
    });
    channel.on("error", () => {
      /* close handler handles drain */
    });
    this.channel = channel;
  }

  async call(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) throw new Error("daemon client is closed");
    if (this.channel === null) await this.connect();
    const channel = this.channel;
    if (channel === null) throw new Error("daemon channel unavailable");

    const id = randomUUID();
    const req: DaemonRequest = { id, method, ...(params !== undefined ? { params } : {}) };
    const timeoutMs = this.opts.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new DaemonRpcError("rpc_timeout", `rpc ${method} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();

      this.pending.set(id, { resolve, reject, timer });
      const ok = channel.send(req);
      if (!ok) {
        // Backpressure: kernel buffer full. Fail fast rather than letting
        // the request linger until rpc_timeout — caller can retry.
        if (this.pending.delete(id)) {
          clearTimeout(timer);
          reject(new DaemonRpcError("backpressure", `socket write would block on ${method}`));
        }
      }
    });
  }

  close(): void {
    this.closed = true;
    if (this.channel === null) return;
    this.channel.close();
    this.channel = null;
  }
}

