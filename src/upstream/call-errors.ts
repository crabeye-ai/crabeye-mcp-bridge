import { APP_NAME } from "../constants.js";

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

/** What a client is told when a call can't be made, wherever the bridge or the manager finds out. */
export function reauthorizationError(source: string, serverName: string): CallRefusedError {
  return new CallRefusedError(
    `Upstream server "${source}" needs re-authorization. Run: ${APP_NAME} auth ${serverName} ` +
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
