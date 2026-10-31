export { ManagerDaemon, DaemonAlreadyRunningError, DaemonStoppedWhileStartingError } from "./manager.js";
export type { ManagerOptions } from "./manager.js";
export { DaemonClient, DaemonRpcError, DAEMON_CONNECTION_CLOSED, DAEMON_REJECTED } from "./client.js";
export type { CallOptions, DaemonClientOpts } from "./client.js";
export {
  encodeFrame,
  FrameDecoder,
  FrameError,
  MIN_BRIDGE_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "./protocol.js";
export type {
  DaemonRequest,
  DaemonResponse,
  DaemonError,
  DaemonMethod,
  DaemonNotification,
  DaemonFrame,
  ChildEraLabel,
  StatusChild,
  StatusResult,
  DaemonStatus,
} from "./protocol.js";
export {
  isNotification,
  isRequest,
  isResponse,
  ERROR_CODE_INVALID_PARAMS,
  ERROR_CODE_INVALID_REQUEST,
  ERROR_CODE_RPC_TIMEOUT,
  ERROR_CODE_TOO_MANY_CONNECTIONS,
  ERROR_CODE_UNKNOWN_METHOD,
} from "./protocol.js";
export type {
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
  getDaemonLogPath,
  processTrackerPathFor,
} from "./paths.js";
export { createDaemonLogger } from "./daemon-log.js";
export { daemonStopBudgetMs, installCrashHandlers, installSignalHandlers } from "./process-handlers.js";
export {
  ProcessTracker,
  type TrackedProcess,
  type ProcessTrackerOptions,
  type ReapResult,
} from "./process-tracker.js";
export { netTransport } from "./net-transport.js";
export { tellManagerAuthChanged } from "./auth-changed.js";
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
export { ChildHandle, BackpressureError, type ChildHandleOptions } from "./child-handle.js";
export type {
  Transport,
  DaemonServer,
  DaemonServerOptions,
  DaemonClientOptions,
  FrameChannel,
} from "./transport.js";
export { readPidFile } from "./pidfile.js";
export {
  recordedPids,
  terminateDaemon,
  waitForExit,
  type TerminateResult,
} from "./daemon-process.js";
export { SocketAliasRefusedError, SocketPathTooLongError, isSocketAddressError } from "./socket-address.js";
