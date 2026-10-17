import type { Transport } from "@modelcontextprotocol/client";

export function transportKeepingFirstMessageHandler(inner: Transport): Transport {
  let handler: Transport["onmessage"];
  return {
    start: () => inner.start(),
    send: (message, options) => inner.send(message, options),
    close: () => inner.close(),
    get onmessage() {
      return handler;
    },
    set onmessage(next) {
      if (handler) return;
      handler = next;
      inner.onmessage = next;
    },
    get onclose() {
      return inner.onclose;
    },
    set onclose(next) {
      inner.onclose = next;
    },
    get onerror() {
      return inner.onerror;
    },
    set onerror(next) {
      inner.onerror = next;
    },
  };
}
