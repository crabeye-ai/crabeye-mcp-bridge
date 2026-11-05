import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DAEMON_CONNECTION_CLOSED } from "./client.js";
import { getDaemonKeyPath } from "./paths.js";
import { FrameError } from "./protocol.js";
import type { FrameChannel } from "./transport.js";

const SECRET_BYTES = 32;
const HEX_32_BYTES = /^[0-9a-f]{64}$/;

export class ForeignPipeServerError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`refusing to use ${path}: ${reason}`);
    this.name = "ForeignPipeServerError";
  }
}

/**
 * Reads the manager key from the run dir, writing a new one when it is missing or malformed.
 * Call only while holding the manager lock.
 */
export async function loadOrCreateManagerKey(): Promise<Buffer> {
  const path = getDaemonKeyPath();
  const existing = await readManagerKey(path);
  if (existing !== null) return existing;
  const key = randomBytes(SECRET_BYTES);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, key.toString("hex"), { mode: 0o600 });
  return key;
}

/**
 * Answers the first frame on a manager connection when it is a challenge, then hands the
 * connection on; anything else, or no challenge within `timeoutMs`, drops it unanswered.
 */
export function answerChallenge(
  channel: FrameChannel,
  key: Buffer,
  timeoutMs: number,
  onProven: () => void,
  onDropped: () => void,
): void {
  let settled = false;
  const settle = (proven: boolean): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    channel.off("message", onMessage);
    channel.off("close", onFailure);
    if (proven) onProven();
    else onDropped();
  };
  const onFailure = (): void => settle(false);
  const onMessage = (msg: unknown): void => {
    const challenge = hexField(msg, "challenge");
    if (challenge === null) return settle(false);
    channel.send({ proof: prove(key, challenge).toString("hex") });
    settle(true);
  };
  const timer = setTimeout(onFailure, timeoutMs);
  channel.on("message", onMessage);
  channel.on("close", onFailure);
  channel.on("error", onFailure);
}

/**
 * Sends a challenge and resolves once the server proves it holds the manager key. Rejects with
 * `ForeignPipeServerError` when it answers anything else or there is no key; a closed or failed
 * connection, or a key that can't be read, rejects with its own error.
 */
export function requireProof(channel: FrameChannel, path: string): Promise<void> {
  const keyPath = getDaemonKeyPath();
  return new Promise((resolve, reject) => {
    let expected: Buffer | null = null;
    let settled = false;
    const settle = (err?: Error): void => {
      if (settled) return;
      settled = true;
      channel.off("message", onMessage);
      channel.off("close", onClose);
      if (err === undefined) resolve();
      else reject(err);
    };
    const refuse = (reason: string): void => settle(new ForeignPipeServerError(path, reason));
    const onMessage = (msg: unknown): void => {
      const proof = hexField(msg, "proof");
      if (expected !== null && proof !== null && timingSafeEqual(proof, expected)) settle();
      else refuse("the process serving it didn't prove it is this user's manager");
    };
    const onClose = (): void => settle(new Error(DAEMON_CONNECTION_CLOSED));
    const onError = (err: Error): void => {
      if (err instanceof FrameError) refuse("the process serving it didn't answer like this user's manager");
      else settle(err);
    };
    channel.on("message", onMessage);
    channel.on("close", onClose);
    channel.on("error", onError);
    readManagerKey(keyPath).then(
      (key) => {
        if (settled) return;
        if (key === null) return refuse(`there is no manager key at ${keyPath} to check the process serving it against`);
        const challenge = randomBytes(SECRET_BYTES);
        expected = prove(key, challenge);
        channel.send({ challenge: challenge.toString("hex") });
      },
      (err: Error) => settle(err),
    );
  });
}

async function readManagerKey(path: string): Promise<Buffer | null> {
  const text = await readFile(path, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  return text !== null && HEX_32_BYTES.test(text) ? Buffer.from(text, "hex") : null;
}

function prove(key: Buffer, challenge: Buffer): Buffer {
  return createHmac("sha256", key).update(challenge).digest();
}

function hexField(msg: unknown, field: string): Buffer | null {
  const value = typeof msg === "object" && msg !== null ? (msg as Record<string, unknown>)[field] : undefined;
  return typeof value === "string" && HEX_32_BYTES.test(value) ? Buffer.from(value, "hex") : null;
}
