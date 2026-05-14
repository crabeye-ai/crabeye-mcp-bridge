import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { OAuthError } from "./errors.js";

export interface CallbackResult {
  code: string;
  state: string;
}

export interface CallbackServerHandle {
  /** `http://127.0.0.1:<port>/callback` */
  redirectUri: string;
  port: number;
  /** Resolves with the OAuth callback result, or rejects on error/timeout/abort. */
  result: Promise<CallbackResult>;
  /** Tears down the listener. Idempotent. Safe to call after `result` settles. */
  close: () => Promise<void>;
}

export interface StartCallbackServerOptions {
  port?: number;
  /** Default 300000 (5 min). 0 disables. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Path served on the callback URL. Defaults to "/callback". */
  path?: string;
}

/**
 * Hardening headers applied to every callback-server response. Cuts the
 * reflected-XSS / cross-origin-read surface to defense-in-depth zero:
 *  - `Content-Security-Policy: default-src 'none'` — if `htmlEscape` ever
 *    regresses, a malicious AS can't run script in the response.
 *  - `Cross-Origin-Resource-Policy: same-origin` + `Cross-Origin-Opener-Policy: same-origin`
 *    block cross-origin readers from observing the response body via
 *    `<img>`/`<script>`/window.opener.
 *  - `X-Content-Type-Options: nosniff` keeps browsers from MIME-sniffing.
 *  - `Referrer-Policy: no-referrer` so navigations away from this page don't
 *    leak query params (which include the authorization code) to other sites.
 *  - `Cache-Control: no-store` so a shared-machine browser doesn't cache the
 *    authorization-code-bearing URL in history/back-forward cache.
 */
const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
});

function applySecurityHeaders(res: import("node:http").ServerResponse): void {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
/**
 * Sanity bound on callback parameters. Real authorization codes and state
 * tokens are well under a kilobyte; anything beyond 4 KiB is malformed input
 * or an exploit probe. Node's default HTTP header limit (~8 KiB) bounds
 * this anyway — we just fail earlier with a clearer error.
 */
const MAX_CALLBACK_PARAM_LENGTH = 4096;

function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" :
    c === "<" ? "&lt;" :
    c === ">" ? "&gt;" :
    c === '"' ? "&quot;" : "&#39;",
  );
}

/** Trim provider-supplied error fields before rendering or quoting in errors. */
function truncate(value: string): string {
  if (value.length <= MAX_CALLBACK_PARAM_LENGTH) return value;
  return value.slice(0, MAX_CALLBACK_PARAM_LENGTH) + "…(truncated)";
}

function successPage(serverName?: string): string {
  const who = serverName ? ` for <strong>${htmlEscape(serverName)}</strong>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Authorized</title>
<style>body{font:14px system-ui;margin:48px auto;max-width:480px;text-align:center;color:#222}</style>
</head><body><h2>Authorization complete${who}</h2>
<p>You can close this window and return to your terminal.</p></body></html>`;
}

function errorPage(error: string, description?: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Authorization failed</title>
<style>body{font:14px system-ui;margin:48px auto;max-width:480px;color:#222}h2{color:#c0392b}</style>
</head><body><h2>Authorization failed</h2>
<p><strong>${htmlEscape(error)}</strong></p>
${description ? `<p>${htmlEscape(description)}</p>` : ""}
<p>Return to your terminal for details.</p></body></html>`;
}

/**
 * Start a one-shot loopback HTTP listener that resolves with the first
 * authorization callback that arrives on `path` (default `/callback`).
 *
 * - 127.0.0.1 only — never binds 0.0.0.0.
 * - Only GET is accepted on the callback path; other methods return 405 and
 *   do not affect the pending promise.
 * - Any non-callback path returns 404 without affecting the pending promise.
 * - Timeout (default 5 min) and AbortSignal both reject and tear down.
 */
export async function startCallbackServer(
  options: StartCallbackServerOptions = {},
): Promise<CallbackServerHandle> {
  const path = options.path ?? "/callback";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let resolveResult!: (value: CallbackResult) => void;
  let rejectResult!: (err: Error) => void;
  const resultPromise = new Promise<CallbackResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  let settled = false;
  let server: Server | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  let cleanupPromise: Promise<void> | undefined;

  // Cache the cleanup promise so multiple `close()` callers (including the
  // implicit cleanup that runs after `settle`) all await the same teardown
  // instead of racing on `server.close()`.
  const cleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      if (abortHandler && options.signal) {
        options.signal.removeEventListener("abort", abortHandler);
        abortHandler = undefined;
      }
      if (server) {
        const s = server;
        server = undefined;
        // `server.close()` waits for in-flight connections to drain — that
        // gives the browser time to receive the success/error response body
        // we just queued before the socket is torn down. Previous code
        // called `closeAllConnections()` here, which severed the socket
        // before the body flushed on slow loopback paths (the user saw
        // "page can't be reached" instead of the success page).
        await new Promise<void>((resolve) => {
          s.close(() => resolve());
        });
      }
    })();
    return cleanupPromise;
  };

  const settle = (err: Error | null, value?: CallbackResult): void => {
    if (settled) return;
    settled = true;
    if (err) rejectResult(err);
    else resolveResult(value!);
    void cleanup();
  };

  server = createServer((req, res) => {
    applySecurityHeaders(res);

    // DNS rebinding / cross-origin defense: only accept requests whose
    // `Host:` header is exactly `127.0.0.1:<our-port>`. Browsers send the
    // hostname the user navigated to, so a rebound `attacker.example` →
    // `127.0.0.1` still carries `Host: attacker.example` on the request and
    // is rejected here. `localhost` is excluded by design — keeps the check
    // tight and matches the loopback IP we actually bind to. The port comes
    // from the socket itself so we don't have to thread it through closure.
    const expectedHost = `127.0.0.1:${req.socket.localPort}`;
    if (req.headers.host !== expectedHost) {
      res.statusCode = 421; // Misdirected Request
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== path) {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }

    if (req.method !== "GET") {
      // Authorization-code callbacks are always GETs per RFC 6749 §3.1.2.
      // Refusing other methods denies cross-origin POST-style callback
      // injection (browsers can issue cross-origin POSTs without a preflight
      // for simple content types) and other shape probes.
      res.statusCode = 405;
      res.setHeader("Allow", "GET");
      res.end();
      return;
    }

    const error = url.searchParams.get("error");
    const errorDescription = url.searchParams.get("error_description") ?? undefined;
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    const sendError = (
      page: { error: string; description?: string },
      settleErr: OAuthError,
    ): void => {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(errorPage(page.error, page.description), () => settle(settleErr));
    };

    if (error) {
      const safeError = truncate(error);
      const safeDescription =
        errorDescription !== undefined ? truncate(errorDescription) : undefined;
      sendError(
        { error: safeError, description: safeDescription },
        new OAuthError(
          "authorization_failed",
          `Authorization provider returned error: ${safeError}${safeDescription ? ` — ${safeDescription}` : ""}`,
        ),
      );
      return;
    }

    if (!code || !state) {
      sendError(
        { error: "invalid_response", description: "Missing code or state" },
        new OAuthError(
          "invalid_callback",
          "Callback missing required parameters (code, state)",
        ),
      );
      return;
    }

    if (
      code.length > MAX_CALLBACK_PARAM_LENGTH ||
      state.length > MAX_CALLBACK_PARAM_LENGTH
    ) {
      sendError(
        { error: "invalid_response", description: "Callback parameters too long" },
        new OAuthError(
          "invalid_callback",
          `Callback parameter exceeded ${MAX_CALLBACK_PARAM_LENGTH} bytes`,
        ),
      );
      return;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    // Settle only after the response flushes so `server.close()` (in cleanup)
    // drains this connection rather than racing the body to the wire.
    res.end(successPage(), () => settle(null, { code, state }));
  });

  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    // `exclusive: true` prevents SO_REUSEADDR/SO_REUSEPORT sharing so a
    // concurrent local process can't piggyback on a pinned `redirectPort`
    // between the abort of one `auth` run and the start of the next.
    server!.listen(
      { port: options.port ?? 0, host: "127.0.0.1", exclusive: true },
      () => {
        server!.removeListener("error", reject);
        resolve();
      },
    );
  });

  const addr = server.address() as AddressInfo;
  const port = addr.port;
  const redirectUri = `http://127.0.0.1:${port}${path}`;

  if (timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      settle(
        new OAuthError(
          "timeout",
          `Authorization timed out after ${Math.round(timeoutMs / 1000)}s — no callback received`,
        ),
      );
    }, timeoutMs);
    // Don't keep the process alive solely for the auth timeout
    timeoutTimer.unref?.();
  }

  if (options.signal) {
    if (options.signal.aborted) {
      settle(new OAuthError("aborted", "Authorization aborted"));
    } else {
      abortHandler = () => {
        settle(new OAuthError("aborted", "Authorization aborted"));
      };
      options.signal.addEventListener("abort", abortHandler, { once: true });
    }
  }

  return {
    redirectUri,
    port,
    result: resultPromise,
    close: cleanup,
  };
}
