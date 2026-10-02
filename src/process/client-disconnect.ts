import type { Readable, Writable } from "node:stream";

export function onClientDisconnect(
  input: Readable,
  output: Writable,
  disconnected: () => void,
): void {
  input.once("end", disconnected);
  input.once("close", disconnected);
  output.on("error", disconnected);
}
