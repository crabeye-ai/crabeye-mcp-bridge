import { createServer as createNetServer, createConnection, type Server } from "node:net";
import { chmod, link, lstat, mkdir, readdir, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import {
  SocketInUseError,
  wrapSocket,
  type DaemonClientOptions,
  type DaemonServer,
  type DaemonServerOptions,
  type FrameChannel,
  type Transport,
} from "./transport.js";
import { socketAddress } from "./socket-address.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const SERVING_PROBE_TIMEOUT_MS = 1_000;
const STAGING_SOCKET_NAME = /^\.s[0-9a-f]{4}$/;
const isWindows = process.platform === "win32";

class NetDaemonServer implements DaemonServer {
  private server: Server | null = null;
  private bound: { dev: number; ino: number } | null = null;

  constructor(private readonly opts: DaemonServerOptions) {}

  get address(): string {
    return this.opts.path;
  }

  async start(): Promise<void> {
    const address = await socketAddress(this.opts.path);
    if (!isWindows) {
      await prepUnixSocketPath(this.opts.path);
    }
    const bindPath = isWindows ? this.opts.path : stagingSocketPath(this.opts.path);
    const bindAddress = isWindows ? bindPath : join(dirname(address), basename(bindPath));

    this.server = createNetServer((socket) => {
      this.opts.onConnection(wrapSocket(socket, this.opts.path));
    });

    if (this.opts.onError) {
      this.server.on("error", this.opts.onError);
    }

    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        this.server?.off("listening", onListening);
        reject(isWindows && err.code === "EADDRINUSE" ? new SocketInUseError(this.opts.path) : err);
      };
      const onListening = (): void => {
        this.server?.off("error", onError);
        resolve();
      };
      this.server!.once("error", onError);
      this.server!.once("listening", onListening);
      this.server!.listen(bindAddress);
    });

    if (!isWindows) {
      try {
        await this.publish(bindPath);
      } catch (err) {
        await this.stop();
        throw err;
      }
    }
  }

  private async publish(bindPath: string): Promise<void> {
    // Tighten in case of permissive umask. Mode 0600 must hold for the
    // "same-UID" trust model to mean anything.
    await chmod(bindPath, 0o600);
    const { dev, ino } = await lstat(bindPath);
    this.bound = { dev, ino };
    try {
      await link(bindPath, this.opts.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new SocketInUseError(this.opts.path);
      throw err;
    } finally {
      await unlink(bindPath).catch(() => {});
    }
  }

  async stop(): Promise<void> {
    const srv = this.server;
    if (srv === null) return;
    this.server = null;
    if (!isWindows && (await this.isPublished())) {
      await unlink(this.opts.path).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") throw err;
      });
    }
    await new Promise<void>((resolve) => {
      srv.close(() => resolve());
    });
  }

  async isPublished(): Promise<boolean> {
    if (isWindows) return this.server !== null;
    try {
      const { dev, ino } = await lstat(this.opts.path);
      return dev === this.bound?.dev && ino === this.bound.ino;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code !== "ENOENT";
    }
  }
}

/**
 * Create the run dir 0700 and remove a stale socket file. Refuses to proceed
 * if the run dir or socket path is a symlink — same-UID trust model requires
 * that an attacker can't redirect our writes — or if a daemon still answers
 * on the socket.
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
  await sweepOrphanedStagingSockets(dir);

  // Only a socket nobody answers on is stale. Refuse to unlink a regular
  // file, dir, or symlink: that would be either an operator-placed marker
  // or a redirection attempt.
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
    if (await isServing(socketPath)) throw new SocketInUseError(socketPath);
    await unlink(socketPath);
    return;
  }
  throw new Error(`refusing to bind: socket path is not a socket: ${socketPath}`);
}

function stagingSocketPath(socketPath: string): string {
  return join(dirname(socketPath), `.s${randomBytes(2).toString("hex")}`);
}

async function sweepOrphanedStagingSockets(dir: string): Promise<void> {
  for (const name of await readdir(dir)) {
    if (!STAGING_SOCKET_NAME.test(name)) continue;
    const path = join(dir, name);
    const st = await lstat(path).catch(() => null);
    if (st?.isSocket() && !(await isServing(path))) await unlink(path).catch(() => {});
  }
}

export async function isServing(path: string): Promise<boolean> {
  const address = await socketAddress(path);
  return new Promise((resolve) => {
    const probe = createConnection(address);
    const settle = (serving: boolean): void => {
      clearTimeout(timer);
      probe.destroy();
      resolve(serving);
    };
    const timer = setTimeout(() => settle(true), SERVING_PROBE_TIMEOUT_MS);
    probe.once("connect", () => settle(true));
    probe.once("error", (err: NodeJS.ErrnoException) => {
      settle(err.code !== "ECONNREFUSED" && err.code !== "ENOENT");
    });
  });
}

export const netTransport: Transport = {
  createServer(opts: DaemonServerOptions): DaemonServer {
    return new NetDaemonServer(opts);
  },
  async connect(opts: DaemonClientOptions): Promise<FrameChannel> {
    const timeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const address = await socketAddress(opts.path);
    return new Promise((resolve, reject) => {
      const socket = createConnection(address);
      const timer = setTimeout(() => {
        socket.destroy(new Error(`connect timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const onError = (err: Error): void => {
        clearTimeout(timer);
        socket.removeListener("connect", onConnect);
        if (address !== opts.path) err.message = err.message.split(address).join(opts.path);
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
