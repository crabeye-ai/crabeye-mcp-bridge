export { ManagerDaemon } from "./manager.js";
export type { ManagerOptions } from "./manager.js";
export { DaemonClient, DaemonRpcError } from "./client.js";
export type { DaemonClientOpts } from "./client.js";
export {
  encodeFrame,
  FrameDecoder,
  FrameError,
  PROTOCOL_VERSION,
} from "./protocol.js";
export type {
  DaemonRequest,
  DaemonResponse,
  DaemonError,
  DaemonMethod,
  StatusResult,
} from "./protocol.js";
export {
  getDaemonRunDir,
  getDaemonSocketPath,
  getDaemonPidPath,
  getDaemonLockPath,
} from "./paths.js";
export { acquireLock, LockBusyError } from "./lockfile.js";
export type { LockHandle } from "./lockfile.js";
export { netTransport } from "./net-transport.js";
export type {
  Transport,
  DaemonServer,
  DaemonServerOptions,
  DaemonClientOptions,
  FrameChannel,
} from "./transport.js";
