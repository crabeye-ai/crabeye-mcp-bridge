import { createServer as createNetServer, createConnection, type Server } from "node:net";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import {
  wrapSocket,
  type DaemonClientOptions,
  type DaemonServer,
  type DaemonServerOptions,
  type FrameChannel,
  type Transport,
} from "./transport.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const isWindows = process.platform === "win32";

class NetDaemonServer implements DaemonServer {
  private server: Server | null = null;

  constructor(private readonly opts: DaemonServerOptions) {}

  get address(): string {
    return this.opts.path;
  }

  async start(): Promise<void> {
    if (!isWindows) {
      await prepUnixSocketPath(this.opts.path);
    }

    this.server = createNetServer((socket) => {
      this.opts.onConnection(wrapSocket(socket, this.opts.path));
    });

    if (this.opts.onError) {
      this.server.on("error", this.opts.onError);
    }

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        this.server?.off("listening", onListening);
        reject(err);
      };
      const onListening = (): void => {
        this.server?.off("error", onError);
        resolve();
      };
      this.server!.once("error", onError);
      this.server!.once("listening", onListening);
      this.server!.listen(this.opts.path);
    });

    if (!isWindows) {
      // Tighten in case of permissive umask. Mode 0600 must hold for the
      // "same-UID" trust model to mean anything.
      await chmod(this.opts.path, 0o600);
    }
  }

  async stop(): Promise<void> {
    if (this.server === null) return;
    const srv = this.server;
    this.server = null;
    await new Promise<void>((resolve) => {
      srv.close(() => resolve());
    });
    if (!isWindows) {
      try {
        await unlink(this.opts.path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
  }
}

/**
 * Create the run dir 0700 and clean up any stale socket file. Refuses to
 * proceed if the run dir or socket path is a symlink — same-UID trust model
 * requires that an attacker can't redirect our writes.
 */
async function prepUnixSocketPath(socketPath: string): Promise<void> {
  const dir = dirname(socketPath);

  await mkdir(dir, { recursive: true, mode: 0o700 });

  // mkdir-recursive doesn't follow the final component as a symlink for the
  // create itself, but it does for intermediate path resolution, and it
  // doesn't reset the mode on a pre-existing dir. Verify both explicitly.
  const dirSt = await lstat(dir);
  if (dirSt.isSymbolicLink()) {
    throw new Error(`refusing to use symlinked daemon run dir: ${dir}`);
  }
  await chmod(dir, 0o700);

  // Remove a stale socket — but only if it really is a socket. Refuse to
  // unlink a regular file, dir, or symlink: that would be either an
  // operator-placed marker or a redirection attempt.
  let st;
  try {
    st = await lstat(socketPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (st.isSymbolicLink()) {
    throw new Error(`refusing to bind: socket path is a symlink: ${socketPath}`);
  }
  if (st.isSocket()) {
    await unlink(socketPath);
    return;
  }
  throw new Error(`refusing to bind: socket path is not a socket: ${socketPath}`);
}

export const netTransport: Transport = {
  createServer(opts: DaemonServerOptions): DaemonServer {
    return new NetDaemonServer(opts);
  },
  connect(opts: DaemonClientOptions): Promise<FrameChannel> {
    const timeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const socket = createConnection(opts.path);
      const timer = setTimeout(() => {
        socket.destroy(new Error(`connect timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const onError = (err: Error): void => {
        clearTimeout(timer);
        socket.removeListener("connect", onConnect);
        reject(err);
      };
      const onConnect = (): void => {
        clearTimeout(timer);
        socket.removeListener("error", onError);
        resolve(wrapSocket(socket, opts.path));
      };

      socket.once("error", onError);
      socket.once("connect", onConnect);
    });
  },
};
