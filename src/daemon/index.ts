export { ManagerDaemon, DaemonAlreadyRunningError } from "./manager.js";
export type { ManagerOptions, ChildGroup, SessionAttachment } from "./manager.js";
export { DaemonClient, DaemonRpcError, DAEMON_CONNECTION_CLOSED, DAEMON_REJECTED } from "./client.js";
export type { DaemonClientOpts } from "./client.js";
export type { ChildEraLabel } from "./child-era.js";
export {
  encodeFrame,
  FrameDecoder,
  FrameError,
  MIN_BRIDGE_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  SHARING_FOR_OLDER_DAEMONS,
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
  SessionEvictedParams,
  StatusChild,
  StatusSession,
  StatusResult,
  DaemonStatus,
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
  ERROR_CODE_SESSION_IN_USE,
  ERROR_CODE_SESSION_NOT_FOUND,
  ERROR_CODE_SPAWN_FAILED,
  ERROR_CODE_TOO_MANY_CONNECTIONS,
  ERROR_CODE_TOO_MANY_SESSIONS,
  ERROR_CODE_UNKNOWN_METHOD,
  ERROR_CODE_UPSTREAM_RESTARTED,
  INNER_ERROR_CODE_BACKPRESSURE,
  INNER_ERROR_CODE_SESSION_CLOSED,
  INNER_ERROR_CODE_UPSTREAM_RESTARTED,
} from "./protocol.js";
export type {
  UpstreamRestartedReason,
  RestartParams,
  RestartResult,
  PingParams,
  PingResult,
} from "./protocol.js";
export { DaemonLivenessSupervisor } from "./liveness-supervisor.js";
export type {
  DaemonLivenessSupervisorOpts,
  LivenessFailureEvent,
  LivenessFailureKind,
} from "./liveness-supervisor.js";
export {
  daemonFilesFor,
  getDaemonRunDir,
  getDaemonSocketPath,
  getDaemonPidPath,
  getDaemonLockPath,
  processTrackerPathFor,
} from "./paths.js";
export {
  ProcessTracker,
  type TrackedProcess,
  type ProcessTrackerOptions,
  type ReapResult,
} from "./process-tracker.js";
export { netTransport } from "./net-transport.js";
export { daemonFit, daemonVersionLabel, olderDaemonStillRunning, reportedDaemonPid, UNKNOWN_DAEMON_VERSION } from "./daemon-version.js";
export {
  AWAIT_PREDECESSOR_FLAG,
  MAX_AWAIT_PREDECESSOR_MS,
  reportToLauncher,
  resolveEntryScript,
} from "./daemon-launch.js";
export {
  DaemonRefusesBridgeError,
  DaemonTooOldError,
  DaemonUnreachableError,
  DaemonUnresponsiveError,
  daemonStatus,
  ensureDaemonRunning,
  isDaemonReachable,
  type EnsureAttemptOptions,
  type UnresponsiveReason,
} from "./bootstrap.js";
export { TokenRewriter, type InnerId, type InboundRouting } from "./token-rewriter.js";
export { ChildHandle, BackpressureError, type ChildHandleOptions } from "./child-handle.js";
export type {
  Transport,
  DaemonServer,
  DaemonServerOptions,
  DaemonClientOptions,
  FrameChannel,
} from "./transport.js";
export {
  readPidFile,
  recordedPids,
  terminateDaemon,
  waitForExit,
  type TerminateResult,
} from "./daemon-process.js";
export { SocketAliasRefusedError, SocketPathTooLongError, isSocketAddressError } from "./socket-address.js";
