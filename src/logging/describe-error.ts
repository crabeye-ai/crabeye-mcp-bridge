const MAX_CAUSES = 4;

function messageOf(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const { code } = err as { code?: unknown };
  return err.message === "" && typeof code === "string" ? code : err.message;
}

function causeOf(err: unknown): unknown {
  return err instanceof Error ? err.cause : undefined;
}

/**
 * `err`'s message followed, in parentheses, by the messages of its causes
 * that it doesn't already include, such as the `ECONNREFUSED` or `ENOTFOUND`
 * under a `fetch failed`. A cause without a message is named by its code.
 */
export function describeError(err: unknown): string {
  let text = messageOf(err);
  const causes: string[] = [];
  for (let cause = causeOf(err), depth = 0; cause !== undefined && depth < MAX_CAUSES; cause = causeOf(cause), depth++) {
    const message = messageOf(cause);
    if (text.includes(message)) continue;
    causes.push(message);
    text += ` ${message}`;
  }
  return causes.length === 0 ? messageOf(err) : `${messageOf(err)} (${causes.join(": ")})`;
}
