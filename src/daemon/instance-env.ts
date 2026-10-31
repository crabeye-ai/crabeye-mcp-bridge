import { resolve } from "node:path";
import { MASTER_KEY_ENV } from "../credentials/keychain.js";
import { isClientSecretEnvName } from "../oauth/client-secret.js";

/** Sent as absolute paths. */
export const CERTIFICATE_FILE_ENV_NAMES: readonly string[] = ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"];

const PROXY_ENV_NAMES: ReadonlySet<string> = new Set(["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]);

const NETWORK_ENV_NAMES: ReadonlySet<string> = new Set([
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_USE_SYSTEM_CA",
  "NODE_USE_ENV_PROXY",
  ...CERTIFICATE_FILE_ENV_NAMES,
  ...PROXY_ENV_NAMES,
]);

const NODE_OPTIONS_AS_ENV: Readonly<Record<string, string>> = {
  "--use-system-ca": "NODE_USE_SYSTEM_CA",
  "--use-env-proxy": "NODE_USE_ENV_PROXY",
};

/** The Node options a bridge passes on to the daemon, as the variables that do the same. */
export const FOLLOWED_NODE_OPTIONS: readonly string[] = Object.keys(NODE_OPTIONS_AS_ENV);

const UNFOLLOWED_NODE_OPTIONS: ReadonlySet<string> = new Set([
  "--use-openssl-ca",
  "--use-bundled-ca",
  "--dns-result-order",
  "--no-network-family-autoselection",
  "--require",
  "-r",
  "--import",
  "--loader",
  "--experimental-loader",
  "--max-http-header-size",
]);

const UNFOLLOWED_NODE_OPTION_PREFIXES: readonly string[] = ["--tls-", "--openssl-", "--network-family-autoselection-"];

/** How a client's HTTP and SSE connections are made, as its own Node process would make them. */
export interface NetworkSettings {
  rejectUnauthorized: boolean;
  useSystemCa: boolean;
  extraCaFile: string | null;
  certFile: string | null;
  proxy: { http: string; https: string; noProxy: string } | null;
}

/** Whether `name` is one of the variables a bridge sends when it attaches. */
export function isInstanceEnvName(name: string): boolean {
  return name === MASTER_KEY_ENV || NETWORK_ENV_NAMES.has(name) || isClientSecretEnvName(name);
}

/**
 * The variables a bridge sends when it attaches, as its own Node process
 * applies them: certificate files made absolute, an empty proxy variable kept
 * (it hides the other spelling), and `--use-system-ca` and `--use-env-proxy`,
 * on the command line or in `NODE_OPTIONS`, sent as the variables that do the
 * same.
 */
export function instanceEnvFrom(env: NodeJS.ProcessEnv, execArgv: readonly string[] = process.execArgv): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || !isInstanceEnvName(name)) continue;
    if (value !== "" || PROXY_ENV_NAMES.has(name)) picked[name] = value;
  }
  for (const name of CERTIFICATE_FILE_ENV_NAMES) {
    if (picked[name] !== undefined) picked[name] = resolve(picked[name]);
  }
  for (const option of nodeOptionNames(env, execArgv)) {
    const name = NODE_OPTIONS_AS_ENV[option];
    if (name !== undefined) picked[name] = "1";
  }
  return picked;
}

/** The Node options a bridge runs with that would change its connections but that the daemon doesn't apply. */
export function unfollowedNodeOptions(env: NodeJS.ProcessEnv, execArgv: readonly string[] = process.execArgv): string[] {
  const unfollowed = nodeOptionNames(env, execArgv).filter(
    (option) => UNFOLLOWED_NODE_OPTIONS.has(option) || UNFOLLOWED_NODE_OPTION_PREFIXES.some((prefix) => option.startsWith(prefix)),
  );
  return [...new Set(unfollowed)];
}

function nodeOptionNames(env: NodeJS.ProcessEnv, execArgv: readonly string[]): string[] {
  return [...execArgv, ...(env.NODE_OPTIONS?.split(/\s+/) ?? [])].filter((token) => token.startsWith("-")).map((token) => token.split("=")[0]!);
}

/** The master key and the client-secret variables. */
export function credentialEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => name === MASTER_KEY_ENV || isClientSecretEnvName(name)));
}

/** Only what changes a connection: proxies count with `NODE_USE_ENV_PROXY=1`, the lowercase names first. */
export function networkSettings(env: Record<string, string | undefined>): NetworkSettings {
  return {
    rejectUnauthorized: env.NODE_TLS_REJECT_UNAUTHORIZED !== "0",
    useSystemCa: env.NODE_USE_SYSTEM_CA === "1",
    extraCaFile: env.NODE_EXTRA_CA_CERTS || null,
    certFile: env.SSL_CERT_FILE || null,
    proxy:
      env.NODE_USE_ENV_PROXY === "1"
        ? {
            http: env.http_proxy ?? env.HTTP_PROXY ?? "",
            https: env.https_proxy ?? env.HTTPS_PROXY ?? "",
            noProxy: env.no_proxy ?? env.NO_PROXY ?? "",
          }
        : null,
  };
}

/** The environment a bridge passes on to the STDIO servers its instance starts: all of its own that a process can be started with, without the master key. */
export function childEnvFrom(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const masterKey = envNameFor(MASTER_KEY_ENV, platform);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || !isSpawnableEntry(name, value) || envNameFor(name, platform) === masterKey) continue;
    out[name] = value;
  }
  return out;
}

/** Whether a process can be started with `name=value` in its environment. */
export function isSpawnableEntry(name: string, value: string): boolean {
  return name.length > 0 && !name.includes("\0") && !name.includes("=", 1) && !value.includes("\0");
}

/** How the system tells variable names apart: ignoring case on Windows. */
export function envNameFor(name: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? name.toUpperCase() : name;
}
