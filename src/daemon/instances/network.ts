import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import tls from "node:tls";
import type { Dispatcher } from "undici";
import type { Logger } from "../../logging/index.js";
import { instanceEnvFrom, networkSettings, type NetworkSettings } from "../instance-env.js";

export interface NetworkFetch {
  fetch: typeof fetch;
  close(): Promise<void>;
}

type Undici = typeof import("undici");
type CaStore = "bundled" | "system";

interface Connection {
  undici: Undici;
  dispatcher: Dispatcher;
}

interface TlsOptions {
  rejectUnauthorized: boolean;
  secureContext?: tls.SecureContext;
}

const DAEMON_NETWORK = networkSettings(instanceEnvFrom(process.env, process.execArgv));

let undiciModule: Promise<Undici> | undefined;
const keptForTheirBodies = new WeakMap<Response, unknown>();
const secureContexts = new Map<string, WeakRef<tls.SecureContext>>();

/**
 * A fetch that connects as a client with `settings` would, whatever the
 * daemon's own environment says: it checks certificates unless the client
 * turned checks off, trusts Node's bundled certificates, the client's extra
 * certificates, the certificates in its `SSL_CERT_FILE` and, with
 * `NODE_USE_SYSTEM_CA=1`, the system's, and goes through the client's
 * proxies. A client whose certificate settings are the daemon's, with no
 * `SSL_CERT_FILE`, uses the daemon's default store. It sets up the connection
 * on its first request. Responses are this runtime's own `Response` objects.
 */
export function networkFetch(settings: NetworkSettings, logger: Logger): NetworkFetch {
  let connection: Promise<Connection> | undefined;
  let closed = false;
  return {
    fetch: async (input, init) => {
      if (closed) throw new Error("network fetch is closed");
      if (input instanceof Request) throw new TypeError("networkFetch takes a URL, not a Request");
      connection ??= connect(settings, logger).catch((err: unknown) => {
        connection = undefined;
        throw err;
      });
      const { undici, dispatcher } = await connection;
      const response = await undici.fetch(input, { ...(init as Parameters<Undici["fetch"]>[1]), dispatcher });
      return asRuntimeResponse(response);
    },
    close: async () => {
      closed = true;
      const opened = await connection?.catch(() => undefined);
      await opened?.dispatcher.destroy().catch(() => {});
    },
  };
}

async function connect(settings: NetworkSettings, logger: Logger): Promise<Connection> {
  const [undici, tlsOptions] = await Promise.all([loadUndici(), tlsOptionsFor(settings, logger)]);
  const dispatcher =
    settings.proxy === null
      ? new undici.Agent({ connect: tlsOptions })
      : new undici.EnvHttpProxyAgent({
          httpProxy: settings.proxy.http,
          httpsProxy: settings.proxy.https,
          noProxy: settings.proxy.noProxy,
          connect: tlsOptions,
          requestTls: tlsOptions,
          proxyTls: tlsOptions,
        });
  return { undici, dispatcher };
}

function loadUndici(): Promise<Undici> {
  undiciModule ??= import("undici").catch((err: unknown) => {
    undiciModule = undefined;
    throw err;
  });
  return undiciModule;
}

async function tlsOptionsFor(settings: NetworkSettings, logger: Logger): Promise<TlsOptions> {
  if (usesDaemonDefaultStore(settings)) return { rejectUnauthorized: settings.rejectUnauthorized };
  return { rejectUnauthorized: settings.rejectUnauthorized, secureContext: secureContextFor(await trustedCertificates(settings, logger)) };
}

/** True when the client sets the same certificates as the daemon started with, and neither names an `SSL_CERT_FILE`. */
function usesDaemonDefaultStore(client: NetworkSettings): boolean {
  return (
    client.certFile === null &&
    DAEMON_NETWORK.certFile === null &&
    client.useSystemCa === DAEMON_NETWORK.useSystemCa &&
    client.extraCaFile === DAEMON_NETWORK.extraCaFile
  );
}

/** The certificates a client trusts when it doesn't use the daemon's default store. */
export async function trustedCertificates(client: NetworkSettings, logger: Logger): Promise<string[]> {
  const ca = [...caStore("bundled"), ...(client.useSystemCa ? caStore("system") : [])];
  if (client.certFile !== null) ca.push(...(await readCertificates(client.certFile, "SSL_CERT_FILE", logger)));
  if (client.extraCaFile !== null) ca.push(...(await readCertificates(client.extraCaFile, "NODE_EXTRA_CA_CERTS", logger)));
  return ca;
}

function secureContextFor(ca: string[]): tls.SecureContext {
  const hash = createHash("sha256");
  for (const certificate of ca) hash.update(certificate).update("\0");
  const key = hash.digest("hex");
  const shared = secureContexts.get(key)?.deref();
  if (shared !== undefined) return shared;
  const created = tls.createSecureContext({ ca });
  secureContexts.set(key, new WeakRef(created));
  return created;
}

function caStore(type: CaStore): string[] {
  const getCACertificates = (tls as { getCACertificates?: (type: CaStore) => string[] }).getCACertificates;
  if (getCACertificates !== undefined) return [...getCACertificates(type)];
  return type === "bundled" ? [...tls.rootCertificates] : [];
}

async function readCertificates(path: string, variable: string, logger: Logger): Promise<string[]> {
  try {
    if (!(await stat(path)).isFile()) throw new Error(`${path} is not a file`);
    return [await readFile(path, "utf8")];
  } catch (err) {
    logger.warn(`ignoring certificates from ${variable}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function asRuntimeResponse(response: Awaited<ReturnType<Undici["fetch"]>>): Response {
  const wrapped = new Response(response.body as ReadableStream | null, {
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers],
  });
  Object.defineProperties(wrapped, { url: { value: response.url }, redirected: { value: response.redirected } });
  keptForTheirBodies.set(wrapped, response);
  return wrapped;
}
