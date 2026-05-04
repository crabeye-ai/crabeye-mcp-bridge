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
  DaemonNotification,
  DaemonFrame,
  OpenParams,
  CloseParams,
  RpcNotificationParams,
  StatusChild,
  StatusSession,
  StatusResult,
} from "./protocol.js";
export {
  isNotification,
  isRequest,
  isResponse,
  ERROR_CODE_BACKPRESSURE,
  ERROR_CODE_INVALID_PARAMS,
  ERROR_CODE_INVALID_REQUEST,
  ERROR_CODE_NOT_IMPLEMENTED,
  ERROR_CODE_RPC_TIMEOUT,
  ERROR_CODE_SESSION_NOT_FOUND,
  ERROR_CODE_SPAWN_FAILED,
  ERROR_CODE_TOO_MANY_CONNECTIONS,
  ERROR_CODE_TOO_MANY_SESSIONS,
  ERROR_CODE_UNKNOWN_METHOD,
  INNER_ERROR_CODE_BACKPRESSURE,
  INNER_ERROR_CODE_SESSION_CLOSED,
} from "./protocol.js";
export {
  getDaemonRunDir,
  getDaemonSocketPath,
  getDaemonPidPath,
  getDaemonLockPath,
  getProcessTrackerPath,
} from "./paths.js";
export {
  ProcessTracker,
  type TrackedProcess,
  type ProcessTrackerOptions,
  type ReapResult,
} from "./process-tracker.js";
export { acquireLock, LockBusyError } from "./lockfile.js";
export type { LockHandle } from "./lockfile.js";
export { netTransport } from "./net-transport.js";
export { ensureDaemonRunning, resolveEntryScript } from "./bootstrap.js";
export { TokenRewriter, type InnerId, type InboundRouting } from "./token-rewriter.js";
export { ChildHandle, BackpressureError, type ChildHandleOptions } from "./child-handle.js";
export type {
  Transport,
  DaemonServer,
  DaemonServerOptions,
  DaemonClientOptions,
  FrameChannel,
} from "./transport.js";
