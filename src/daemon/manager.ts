import { open, lstat, mkdir, chmod, unlink } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname } from "node:path";
import { acquireLock, LockBusyError, type LockHandle } from "./lockfile.js";
import { PROTOCOL_VERSION, notImplementedResponse } from "./protocol.js";
import type {
  DaemonError,
  DaemonRequest,
  DaemonResponse,
  StatusResult,
} from "./protocol.js";
import type { DaemonServer, FrameChannel, Transport } from "./transport.js";

const isWindows = process.platform === "win32";

/** Bound on simultaneous IPC clients. Same-UID DoS hardening. */
const DEFAULT_MAX_CONNECTIONS = 64;

export interface ManagerOptions {
  socketPath: string;
  pidPath: string;
  lockPath: string;
  /** Daemon self-exits after `idleMs` of having no children/sessions. */
  idleMs: number;
  transport: Transport;
  /** Override pid for tests. */
  pid?: number;
  /** Cap on concurrent IPC connections. Defaults to 64. */
  maxConnections?: number;
  /** Hook called once the manager has exited; tests await this. */
  onExit?: (code: number) => void;
}

const PROTOCOL_MISSING_FIELD: DaemonError = {
  code: "invalid_request",
  message: "request missing required fields { id, method }",
};

/**
 * Phase-A manager daemon. Owns the lockfile, pidfile, and IPC server.
 * Phase B will plug session/child management into the same lifecycle hooks.
 */
export class ManagerDaemon {
  private server: DaemonServer | null = null;
  private lock: LockHandle | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private connections = new Set<FrameChannel>();
  private startedAt = 0;
  private stopping = false;
  private exited = false;
  private readonly maxConnections: number;
  private readonly exitedPromise: Promise<number>;
  private exitedResolve: (code: number) => void = () => {
    /* replaced in constructor */
  };

  constructor(private readonly opts: ManagerOptions) {
    this.maxConnections = opts.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.exitedPromise = new Promise<number>((resolve) => {
      this.exitedResolve = resolve;
    });
  }

  /** Resolves with the exit code once `stop()` finishes. */
  waitForExit(): Promise<number> {
    return this.exitedPromise;
  }

  /**
   * Acquires the lock, writes the pidfile, and binds the IPC server. Throws
   * `LockBusyError` if another live daemon is already running.
   */
  async start(): Promise<void> {
    await this.prepRunDir();

    this.lock = await acquireLock(this.opts.lockPath, {
      pid: this.opts.pid ?? process.pid,
    });

    let pidWritten = false;
    try {
      await writePidfile(this.opts.pidPath, this.opts.pid ?? process.pid);
      pidWritten = true;

      this.server = this.opts.transport.createServer({
        path: this.opts.socketPath,
        onConnection: (channel) => this.handleConnection(channel),
      });

      await this.server.start();
      this.startedAt = Date.now();
      this.armIdleTimer();
    } catch (err) {
      if (pidWritten) {
        try {
          await unlink(this.opts.pidPath);
        } catch {
          /* best-effort */
        }
      }
      await this.releaseLock();
      throw err;
    }
  }

  /** Trigger graceful shutdown. Idempotent. */
  async stop(exitCode = 0): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;

    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    for (const ch of this.connections) {
      try {
        ch.close();
      } catch {
        /* ignore */
      }
    }
    this.connections.clear();

    if (this.server !== null) {
      const srv = this.server;
      this.server = null;
      try {
        await srv.stop();
      } catch {
        /* swallowed during shutdown — refused unlinks etc. */
      }
    }

    try {
      await unlink(this.opts.pidPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        // Anything other than missing-file is unexpected; surface to stderr
        // so a wedged shutdown is visible.
        process.stderr.write(`pidfile cleanup: ${(err as Error).message}\n`);
      }
    }

    await this.releaseLock();

    if (!this.exited) {
      this.exited = true;
      this.opts.onExit?.(exitCode);
      this.exitedResolve(exitCode);
    }
  }

  uptimeMs(): number {
    return this.startedAt === 0 ? 0 : Date.now() - this.startedAt;
  }

  /** Manager-side request dispatch. Pure on the request object. */
  handleRequest(req: DaemonRequest): DaemonResponse {
    if (
      typeof req !== "object" ||
      req === null ||
      typeof req.id !== "string" ||
      typeof req.method !== "string"
    ) {
      const id = (req as { id?: unknown })?.id;
      return {
        id: typeof id === "string" ? id : "",
        error: PROTOCOL_MISSING_FIELD,
      };
    }

    switch (req.method) {
      case "STATUS": {
        const result: StatusResult = {
          uptime: this.uptimeMs(),
          pid: this.opts.pid ?? process.pid,
          version: PROTOCOL_VERSION,
          children: [],
          sessions: [],
        };
        return { id: req.id, result };
      }
      case "SHUTDOWN":
        // setImmediate gives the response a chance to drain to the kernel
        // before stop() destroys the connection. Not a strict flush, but
        // better than queueMicrotask which fires before write() returns.
        setImmediate(() => {
          void this.stop(0);
        });
        return { id: req.id, result: { ok: true } };
      case "OPEN":
      case "OPENED":
      case "RPC":
      case "CLOSE":
      case "RESTART":
        return notImplementedResponse(req.id, req.method);
      default:
        return {
          id: req.id,
          error: {
            code: "unknown_method",
            message: `unknown method "${req.method}"`,
          },
        };
    }
  }

  private handleConnection(channel: FrameChannel): void {
    if (this.stopping) {
      channel.close();
      return;
    }
    if (this.connections.size >= this.maxConnections) {
      channel.send({
        id: "",
        error: { code: "too_many_connections", message: "manager at connection cap" },
      });
      channel.close();
      return;
    }
    this.connections.add(channel);
    this.cancelIdleTimer();

    channel.on("message", (msg: unknown) => {
      const req = msg as DaemonRequest;
      const res = this.handleRequest(req);
      channel.send(res);
    });

    channel.on("error", () => {
      /* swallow — close handler does the cleanup */
    });

    channel.on("close", () => {
      this.connections.delete(channel);
      if (this.connections.size === 0 && !this.stopping) {
        this.armIdleTimer();
      }
    });
  }

  private armIdleTimer(): void {
    this.cancelIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (!this.stopping && this.connections.size === 0) {
        void this.stop(0);
      }
    }, this.opts.idleMs);
    if (typeof this.idleTimer.unref === "function") {
      this.idleTimer.unref();
    }
  }

  private cancelIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private async releaseLock(): Promise<void> {
    if (this.lock === null) return;
    const lock = this.lock;
    this.lock = null;
    await lock.release();
  }

  private async prepRunDir(): Promise<void> {
    const dir = dirname(this.opts.lockPath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (isWindows) return;

    // mkdir-recursive resolves intermediate symlinks. Refuse the run dir if
    // it's been replaced with a symlink (same-UID redirection attempt).
    const st = await lstat(dir);
    if (st.isSymbolicLink()) {
      throw new Error(`refusing to use symlinked daemon run dir: ${dir}`);
    }
    await chmod(dir, 0o700);
  }
}

/**
 * Write the pidfile with `O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW` to refuse
 * pre-existing symlinks. The lockfile already pins our slot, so the file
 * shouldn't exist; if it does, fail loudly.
 */
async function writePidfile(path: string, pid: number): Promise<void> {
  // O_NOFOLLOW is best-effort on Windows (the constant is 0 there) and
  // unnecessary because the pidfile lives under %LOCALAPPDATA%.
  const flags =
    fsConstants.O_CREAT |
    fsConstants.O_EXCL |
    fsConstants.O_WRONLY |
    (isWindows ? 0 : fsConstants.O_NOFOLLOW);
  let fh;
  try {
    fh = await open(path, flags, 0o600);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      // Stale pidfile from a previous crash. Lock-holding daemon is *us*,
      // so it's safe to overwrite — but go through unlink + retry rather
      // than O_TRUNC so we keep the symlink-refusing semantics.
      try {
        const st = await lstat(path);
        if (st.isSymbolicLink()) {
          throw new Error(`refusing to write pidfile: ${path} is a symlink`);
        }
      } catch (lstatErr) {
        if ((lstatErr as NodeJS.ErrnoException).code !== "ENOENT") throw lstatErr;
      }
      await unlink(path).catch(() => {
        /* race tolerated; retry will surface it */
      });
      fh = await open(path, flags, 0o600);
    } else {
      throw err;
    }
  }
  try {
    await fh.writeFile(`${pid}\n`, "utf-8");
  } finally {
    await fh.close();
  }
}

export { LockBusyError };
