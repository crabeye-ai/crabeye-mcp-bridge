import { escapeLabel } from "../logging/labels.js";
import type { ProviderStatus } from "../search/types.js";
import { authCommand, reauthorizationError } from "../upstream/call-errors.js";
import type { ConnectionStatus } from "../upstream/types.js";

/** A server as the end of the `search_tools` description lists it. */
export interface ServerState {
  name: string;
  status: ConnectionStatus;
  category?: string;
}

type NotConnected = Exclude<ConnectionStatus, "connected">;

const STATUS_NOTES: Record<ConnectionStatus, (shownName: string) => string> = {
  connected: () => "",
  connecting: () => ": starting",
  disconnected: () => ": not connected",
  auth_required: (shownName) => `: needs authorization; the user runs: ${authCommand(shownName)}, or updates its credentials if it doesn't use OAuth`,
};

const PROVIDER_STATUSES: Record<NotConnected, ProviderStatus> = {
  connecting: "starting",
  disconnected: "not_connected",
  auth_required: "needs_authorization",
};

const AUTH_HEADER = /(?<![a-z0-9-])(authorization|proxy-authorization|[a-z0-9]+(?:-[a-z0-9]+)*-(?:token|key))(\s*:\s*)[^\r\n,;]+/gi;
const COOKIE_HEADER = /\b(cookie)(\s*:\s*)[^\r\n]+/gi;
const SCHEME_TOKEN = /\b(bearer|basic)\s+(?=[A-Za-z._~+/-]*[0-9]|[A-Za-z0-9._~+/-]{16})[A-Za-z0-9._~+/-]+=*/gi;
const SECRET_NAME = /api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|token|secret|password|passwd/.source;
const NAMED_SECRET = new RegExp(String.raw`(?<![A-Za-z0-9])((?:${SECRET_NAME})(?:\s*=\s*|["']\s*:\s*))("[^"]*"|'[^']*'|[^\s"'&,;}]+)`, "gi");
const URL_USERINFO = /(\/\/)[^/\s@]+@/g;

const CREDENTIALS: Array<[RegExp, string]> = [
  [AUTH_HEADER, "$1$2[redacted]"],
  [COOKIE_HEADER, "$1$2[redacted]"],
  [SCHEME_TOKEN, "$1 [redacted]"],
  [NAMED_SECRET, "$1[redacted]"],
  [URL_USERINFO, "$1[redacted]@"],
];

/**
 * How a server is shown, from its connection's status and last error: one
 * retrying after a failed attempt is still not connected, and one whose
 * connection dropped without an error is connecting again, so a broken server
 * doesn't flip between the two and a dropped one keeps its tools.
 */
export function listedStatus(status: ConnectionStatus, error: string | undefined): ConnectionStatus {
  if (status === "connecting" && error !== undefined) return "disconnected";
  if (status === "disconnected" && error === undefined) return "connecting";
  return status;
}

/** The servers for the end of the `search_tools` description, with the status of each that isn't connected; empty when there are none. */
export function renderServerList(servers: readonly ServerState[]): string {
  if (servers.length === 0) return "";
  const lines = servers.map(({ name, status, category }) => {
    const shownName = escapeLabel(name);
    const shownCategory = category === undefined ? "" : ` [${escapeLabel(category)}]`;
    return `- ${shownName}${shownCategory}${STATUS_NOTES[status](shownName)}`;
  });
  return ["Servers (search by provider name):", ...lines].join("\n");
}

/**
 * What a search says about a server that isn't connected. `error` is its last
 * connection error, already passed through `withoutCredentials` and cut short
 * by the caller; this only escapes it. `hasTools` says whether the tools it
 * last listed are still searched.
 */
export function providerStatus(name: string, status: NotConnected, error: string | undefined, hasTools: boolean): { status: ProviderStatus; message: string } {
  const shownName = escapeLabel(name);
  return { status: PROVIDER_STATUSES[status], message: statusMessage(shownName, status, error, hasTools) };
}

function statusMessage(shownName: string, status: NotConnected, error: string | undefined, hasTools: boolean): string {
  if (status === "auth_required") return reauthorizationError(shownName, shownName).message;
  if (status === "connecting") {
    return hasTools ? `"${shownName}" is reconnecting; a call to its tools waits for it to be back.` : `"${shownName}" is starting; search again shortly.`;
  }
  if (error === undefined) return `"${shownName}" is not connected.`;
  return `"${shownName}" is not connected: ${escapeLabel(error)}`;
}

/** `text` with what looks like a credential, such as a bearer token, a `password=` value or a URL's user and password, replaced by `[redacted]`. */
export function withoutCredentials(text: string): string {
  return CREDENTIALS.reduce((shown, [pattern, replacement]) => shown.replace(pattern, replacement), text);
}
