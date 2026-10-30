import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { instanceEnvFrom, isInstanceEnvName, networkSettings, unfollowedNodeOptions } from "../../src/daemon/instance-env.js";

describe("isInstanceEnvName", () => {
  it.each([
    "MCP_BRIDGE_MASTER_KEY",
    "NOTION_OAUTH_SECRET",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "NODE_EXTRA_CA_CERTS",
    "NODE_USE_SYSTEM_CA",
    "SSL_CERT_FILE",
    "NODE_USE_ENV_PROXY",
    "https_proxy",
    "NO_PROXY",
  ])("sends %s", (name) => {
    expect(isInstanceEnvName(name)).toBe(true);
  });

  it.each(["PATH", "NODE_OPTIONS", "MCP_BRIDGE_CONFIG", "SSL_CERT_DIR"])("doesn't send %s", (name) => {
    expect(isInstanceEnvName(name)).toBe(false);
  });
});

describe("instanceEnvFrom", () => {
  it("keeps the instance variables that are set, with certificate files made absolute", () => {
    expect(
      instanceEnvFrom(
        {
          MCP_BRIDGE_MASTER_KEY: "k",
          NOTION_OAUTH_SECRET: "s",
          EMPTY_OAUTH: "",
          PATH: "/bin",
          HOME: "/home/u",
          MISSING_OAUTH: undefined,
          https_proxy: "http://proxy:3128",
          NODE_USE_ENV_PROXY: "1",
          NODE_EXTRA_CA_CERTS: "certs/ca.pem",
          SSL_CERT_FILE: "certs/bundle.pem",
          NODE_OPTIONS: "--max-old-space-size=512",
        },
        [],
      ),
    ).toEqual({
      MCP_BRIDGE_MASTER_KEY: "k",
      NOTION_OAUTH_SECRET: "s",
      https_proxy: "http://proxy:3128",
      NODE_USE_ENV_PROXY: "1",
      NODE_EXTRA_CA_CERTS: join(process.cwd(), "certs/ca.pem"),
      SSL_CERT_FILE: join(process.cwd(), "certs/bundle.pem"),
    });
  });

  it("keeps an empty proxy variable, which hides the other spelling", () => {
    const env = instanceEnvFrom({ NODE_USE_ENV_PROXY: "1", http_proxy: "", HTTP_PROXY: "http://proxy:3128" }, []);

    expect(env).toEqual({ NODE_USE_ENV_PROXY: "1", http_proxy: "", HTTP_PROXY: "http://proxy:3128" });
    expect(networkSettings(env).proxy).toEqual({ http: "", https: "", noProxy: "" });
  });

  it.each([
    ["NODE_OPTIONS", { NODE_OPTIONS: "--use-system-ca\t--use-env-proxy" }, []],
    ["the command line", {}, ["--use-system-ca", "--use-env-proxy"]],
  ])("sends Node's --use-system-ca and --use-env-proxy flags from %s as the variables that do the same", (_label, env, execArgv) => {
    expect(instanceEnvFrom(env, execArgv)).toEqual({ NODE_USE_SYSTEM_CA: "1", NODE_USE_ENV_PROXY: "1" });
  });
});

describe("unfollowedNodeOptions", () => {
  it("names the options that would change a connection, once each, without their values", () => {
    const env = { NODE_OPTIONS: "--use-openssl-ca --tls-min-v1.3 --require ./proxy.js --max-old-space-size=512 --use-system-ca" };

    expect(unfollowedNodeOptions(env, ["--dns-result-order=ipv4first", "--tls-min-v1.3"])).toEqual([
      "--dns-result-order",
      "--tls-min-v1.3",
      "--use-openssl-ca",
      "--require",
    ]);
  });

  it("names the options that change how addresses are tried, but not Node's default", () => {
    const env = { NODE_OPTIONS: "--no-network-family-autoselection --network-family-autoselection-attempt-timeout=500" };

    expect(unfollowedNodeOptions(env, [])).toEqual(["--no-network-family-autoselection", "--network-family-autoselection-attempt-timeout"]);
    expect(unfollowedNodeOptions({ NODE_OPTIONS: "--network-family-autoselection" }, [])).toEqual([]);
  });

  it("is empty without such options", () => {
    expect(unfollowedNodeOptions({ NODE_OPTIONS: "--max-old-space-size=512 --use-env-proxy" }, [])).toEqual([]);
  });
});
