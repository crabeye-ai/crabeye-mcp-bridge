const REUSE_SUCCESSFUL_REFRESH_MS = 30_000;
/** How long a refresh request may take before it fails. */
export const REFRESH_TIMEOUT_MS = 30_000;

interface Answer {
  ok: boolean;
  body: ArrayBuffer | null;
  init: ResponseInit;
}

/**
 * Coalesces refreshes that redeem the same refresh token at the same token
 * endpoint into one request, whichever connection sends them: those in flight
 * together, and those started up to 30 seconds after one succeeded (a request
 * sent before that refresh can come back unauthorized after it, and redeeming
 * the old token again would be refused by a server that rotates refresh
 * tokens). A request with no answer within 30 seconds fails, so a stalled
 * network can't keep the others waiting. Every caller gets its own response.
 */
export class SharedRefreshes {
  private readonly _inFlight = new Map<string, Promise<Answer>>();
  private readonly _succeeded = new Map<string, { answer: Answer; at: number }>();

  constructor(private readonly _requestTimeoutMs: number = REFRESH_TIMEOUT_MS) {}

  /** Sends the refresh with `send` unless one for the same endpoint and refresh token is in flight or just succeeded. */
  async fetch(endpoint: string, refreshToken: string, send: (signal: AbortSignal) => Promise<Response>): Promise<Response> {
    const key = `${endpoint}\n${refreshToken}`;
    this._forgetExpired(Date.now());
    const recent = this._succeeded.get(key)?.answer;
    if (recent !== undefined) return responseOf(recent);
    let pending = this._inFlight.get(key);
    if (pending === undefined) {
      pending = this._send(key, send);
      this._inFlight.set(key, pending);
    }
    return responseOf(await pending);
  }

  private _send(key: string, send: (signal: AbortSignal) => Promise<Response>): Promise<Answer> {
    const pending = answerOf(send(AbortSignal.timeout(this._requestTimeoutMs)));
    pending.then(
      (answer) => {
        if (answer.ok) this._rememberSuccess(key, answer);
      },
      () => {},
    );
    pending
      .finally(() => {
        if (this._inFlight.get(key) === pending) this._inFlight.delete(key);
      })
      .catch(() => {});
    return pending;
  }

  private _forgetExpired(now: number): void {
    for (const [known, entry] of this._succeeded) {
      if (now - entry.at >= REUSE_SUCCESSFUL_REFRESH_MS) this._succeeded.delete(known);
    }
  }

  private _rememberSuccess(key: string, answer: Answer): void {
    const now = Date.now();
    this._forgetExpired(now);
    const entry = { answer, at: now };
    this._succeeded.set(key, entry);
    setTimeout(() => {
      if (this._succeeded.get(key) === entry) this._succeeded.delete(key);
    }, REUSE_SUCCESSFUL_REFRESH_MS).unref();
  }
}

async function answerOf(sending: Promise<Response>): Promise<Answer> {
  const response = await sending;
  const body = response.body === null ? null : await response.arrayBuffer();
  return { ok: response.ok, body, init: { status: response.status, statusText: response.statusText, headers: [...response.headers] } };
}

function responseOf(answer: Answer): Response {
  return new Response(answer.body === null ? null : answer.body.slice(0), answer.init);
}
