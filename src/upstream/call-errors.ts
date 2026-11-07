import { MissingRequiredClientCapabilityError, SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { APP_NAME } from "../constants.js";
import { methodLabel } from "../logging/index.js";

const CLIENT_INPUT_CAPABILITY_BY_METHOD = new Map([
  ["elicitation/create", "elicitation"],
  ["sampling/createMessage", "sampling"],
  ["roots/list", "roots"],
]);
const CLIENT_INPUT_CAPABILITIES = new Set(CLIENT_INPUT_CAPABILITY_BY_METHOD.values());

/** A call that wasn't made; the message is what the client should be told, as is. */
export class CallRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CallRefusedError";
  }
}

/** A call the client has to approve first; the message is the question to ask it. */
export class ApprovalRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalRequiredError";
  }
}

const PLAIN_ARGUMENT = /^[A-Za-z0-9._:+/][A-Za-z0-9._@:+=/-]*$/;

/**
 * The `auth` command for `serverName`, or `auth --remove` with `remove`. A
 * name that isn't plain is single-quoted, in the POSIX way or PowerShell's on
 * Windows, and one that starts with `-` follows `--`, or is joined to
 * `--remove=`, so it isn't read as an option.
 */
export function authCommand(serverName: string, { remove = false }: { remove?: boolean } = {}): string {
  const name = shellArgument(serverName);
  const dashed = serverName.startsWith("-");
  if (remove) return `${APP_NAME} auth --remove${dashed ? "=" : " "}${name}`;
  return `${APP_NAME} auth ${dashed ? "-- " : ""}${name}`;
}

function shellArgument(arg: string): string {
  if (PLAIN_ARGUMENT.test(arg)) return arg;
  return process.platform === "win32" ? `'${arg.replace(/['\u2018-\u201b]/g, "$&$&")}'` : `'${arg.replace(/'/g, "'\\''")}'`;
}

/** What a client is told when a call can't be made, wherever the bridge or the manager finds out. */
export function reauthorizationError(source: string, serverName: string): CallRefusedError {
  return new CallRefusedError(
    `Upstream server "${source}" needs re-authorization. Run: ${authCommand(serverName)} ` +
      "(or update its configured credentials if it does not use OAuth).",
  );
}

export function cancelledError(): Error {
  return new Error("Request cancelled");
}

export function removedError(source: string): CallRefusedError {
  return new CallRefusedError(`Upstream server "${source}" was removed from the configuration`);
}

export function unavailableError(source: string): CallRefusedError {
  return new CallRefusedError(`Upstream server "${source}" is unavailable; reconnecting in the background. Please retry shortly.`);
}

/** What a client is told when a server asks it for input mid-call, which the bridge can't pass on; null for any other error. */
export function unsupportedInputRequest(err: unknown): Error | null {
  const requested = requestedClientInput(err);
  if (requested.length === 0) return null;
  const names = requested.map((name) => `"${name}"`).join(", ");
  return new Error(`asked the client for input (${names}), which ${APP_NAME} doesn't support`);
}

function requestedClientInput(err: unknown): string[] {
  if (err instanceof MissingRequiredClientCapabilityError) {
    const required = Object.keys(err.requiredCapabilities ?? {});
    return required.length > 0 && required.every((name) => CLIENT_INPUT_CAPABILITIES.has(name)) ? required : [];
  }
  if (err instanceof SdkError && err.code === SdkErrorCode.CapabilityNotSupported) {
    const method = (err.data as { method?: unknown } | undefined)?.method;
    return typeof method === "string" ? [CLIENT_INPUT_CAPABILITY_BY_METHOD.get(method) ?? methodLabel(method)] : [];
  }
  return [];
}
