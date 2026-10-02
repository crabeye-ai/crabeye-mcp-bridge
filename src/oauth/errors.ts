import {
  OAuthClientFlowError,
  OAuthError as SdkOAuthError,
  OAuthErrorCode,
  SdkErrorCode,
  SdkHttpError,
  SseError,
  UnauthorizedError,
} from "@modelcontextprotocol/client";

const TRANSIENT_OAUTH_CODES: ReadonlySet<string> = new Set([
  OAuthErrorCode.ServerError,
  OAuthErrorCode.TemporarilyUnavailable,
]);

export class OAuthError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OAuthError";
    this.code = code;
  }
}

export class ReauthorizationRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReauthorizationRequiredError";
  }
}

export function isReauthorizationRequired(err: unknown): boolean {
  return someCause(err, requiresUserAction);
}

export function isDefinitiveAuthFailure(err: unknown): boolean {
  return someCause(
    err,
    (current) =>
      current instanceof ReauthorizationRequiredError ||
      current instanceof OAuthError ||
      current instanceof OAuthClientFlowError,
  );
}

function someCause(err: unknown, predicate: (current: Error) => boolean): boolean {
  for (let current = err, depth = 0; current instanceof Error && depth < 5; current = current.cause, depth++) {
    if (predicate(current)) return true;
  }
  return false;
}

function requiresUserAction(err: Error): boolean {
  if (
    err instanceof ReauthorizationRequiredError ||
    err instanceof UnauthorizedError ||
    err instanceof OAuthError ||
    err instanceof OAuthClientFlowError
  ) {
    return true;
  }
  if (err instanceof SdkHttpError) return err.code === SdkErrorCode.ClientHttpAuthentication || err.status === 401;
  if (err instanceof SseError) return err.code === 401;
  return err instanceof SdkOAuthError && !TRANSIENT_OAUTH_CODES.has(err.code);
}
