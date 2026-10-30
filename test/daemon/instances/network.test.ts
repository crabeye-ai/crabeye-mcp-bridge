import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { execFile } from "node:child_process";
import http from "node:http";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import tls from "node:tls";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { networkSettings } from "../../../src/daemon/instance-env.js";
import { networkFetch, trustedCertificates, type NetworkFetch } from "../../../src/daemon/instances/network.js";
import { HAS_OPENSSL, selfSignedCertificate, type SelfSignedCertificate } from "../../_helpers/self-signed.js";
import { spyLogger } from "../../_helpers/spy-logger.js";
import { bundleForSubprocess } from "../../_helpers/subprocess-bundle.js";

const run = promisify(execFile);

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe.skipIf(process.platform === "win32" || !HAS_OPENSSL)("networkFetch", () => {
  let dir: string;
  let certificate: SelfSignedCertificate;
  let secure: https.Server;
  let plain: http.Server;
  let proxy: http.Server;
  let secureUrl: string;
  let plainUrl: string;
  let proxyUrl: string;
  let proxied: string[] = [];
  const fetches: NetworkFetch[] = [];

  function open(env: Record<string, string>, logger = spyLogger()): NetworkFetch {
    const created = networkFetch(networkSettings(env), logger);
    fetches.push(created);
    return created;
  }

  function connect(env: Record<string, string>, logger = spyLogger()): typeof fetch {
    return open(env, logger).fetch;
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cbe-network-"));
    certificate = selfSignedCertificate(dir);
    secure = https.createServer({ key: certificate.key, cert: certificate.cert }, (_req, res) => res.end("secure"));
    plain = http.createServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "/landed" });
        return res.end();
      }
      res.writeHead(req.method === "POST" ? 201 : 200, { "content-type": "text/plain", "x-echo": req.headers["x-test"] ?? "" });
      req.pipe(res);
    });
    proxy = http.createServer((req, res) => {
      proxied.push(`${req.method} ${req.url}`);
      const forward = http.request(req.url!, { method: req.method, headers: req.headers }, (upstream) => {
        res.writeHead(upstream.statusCode!, upstream.headers);
        upstream.pipe(res);
      });
      req.pipe(forward);
    });
    proxy.on("connect", (req, socket: net.Socket, head) => {
      proxied.push(`CONNECT ${req.url}`);
      const [host, port] = req.url!.split(":");
      const target = net.connect(Number(port), host, () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        target.write(head);
        target.pipe(socket);
        socket.pipe(target);
      });
      target.on("error", () => socket.destroy());
      socket.on("error", () => target.destroy());
    });
    secureUrl = `https://127.0.0.1:${await listen(secure)}/`;
    plainUrl = `http://127.0.0.1:${await listen(plain)}/`;
    proxyUrl = `http://127.0.0.1:${await listen(proxy)}`;
  });

  afterEach(async () => {
    proxied = [];
    await Promise.all(fetches.splice(0).map((f) => f.close()));
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await Promise.all([close(secure), close(plain), close(proxy)]);
    await rm(dir, { recursive: true, force: true });
  });

  function daemonEnvironment(values: Record<string, string>): void {
    for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
  }

  it("checks certificates for a client that doesn't turn checks off, even when the daemon's own environment does", async () => {
    daemonEnvironment({ NODE_TLS_REJECT_UNAUTHORIZED: "0" });

    await expect(connect({})(secureUrl)).rejects.toThrow("fetch failed");
    expect(await (await fetch(secureUrl)).text()).toBe("secure");
  });

  it("accepts any certificate for a client that sets NODE_TLS_REJECT_UNAUTHORIZED=0", async () => {
    expect(await (await connect({ NODE_TLS_REJECT_UNAUTHORIZED: "0" })(secureUrl)).text()).toBe("secure");
  });

  it("trusts the certificates in the client's NODE_EXTRA_CA_CERTS", async () => {
    expect(await (await connect({ NODE_EXTRA_CA_CERTS: certificate.certPath })(secureUrl)).text()).toBe("secure");
  });

  it("trusts the certificates in the client's SSL_CERT_FILE", async () => {
    expect(await (await connect({ SSL_CERT_FILE: certificate.certPath })(secureUrl)).text()).toBe("secure");
  });

  it("trusts the client's extra certificates alongside the system's when it sets NODE_USE_SYSTEM_CA=1", async () => {
    expect(await (await connect({ NODE_USE_SYSTEM_CA: "1", NODE_EXTRA_CA_CERTS: certificate.certPath })(secureUrl)).text()).toBe("secure");
  });

  it("builds a client's list from Node's bundled certificates, the system's only when the client asks, and the client's files", async () => {
    const extra = await readFile(certificate.certPath, "utf8");
    const bundled = tls.getCACertificates("bundled");
    const system = tls.getCACertificates("system");
    const certificates = (env: Record<string, string>) => trustedCertificates(networkSettings(env), spyLogger());

    expect(await certificates({ NODE_EXTRA_CA_CERTS: certificate.certPath })).toEqual([...bundled, extra]);
    expect(await certificates({ NODE_USE_SYSTEM_CA: "1" })).toEqual([...bundled, ...system]);
    expect(await certificates({ SSL_CERT_FILE: certificate.certPath, NODE_EXTRA_CA_CERTS: certificate.certPath })).toEqual([...bundled, extra, extra]);
  });

  it.each([
    ["can't be read", () => join(dir, "missing.pem"), "ENOENT"],
    ["is not a file", () => dir, "is not a file"],
  ])("warns on the first request and keeps the usual certificates when the client's extra certificate file %s", async (_label, path, reason) => {
    const logger = spyLogger();
    const fetchVia = connect({ NODE_EXTRA_CA_CERTS: path() }, logger);
    expect(logger.warn).not.toHaveBeenCalled();

    await expect(fetchVia(secureUrl)).rejects.toThrow("fetch failed");

    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^ignoring certificates from NODE_EXTRA_CA_CERTS: .*${reason}`)));
  });

  it("goes through the client's proxy when it sets NODE_USE_ENV_PROXY=1", async () => {
    expect((await connect({ NODE_USE_ENV_PROXY: "1", HTTP_PROXY: proxyUrl })(plainUrl)).status).toBe(200);
    expect(proxied).toEqual([`CONNECT ${new URL(plainUrl).host}`]);
  });

  it("tunnels HTTPS through the client's proxy and still checks the server's certificate", async () => {
    const env = { NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: proxyUrl };

    await expect(connect(env)(secureUrl)).rejects.toThrow("fetch failed");
    expect(await (await connect({ ...env, NODE_EXTRA_CA_CERTS: certificate.certPath })(secureUrl)).text()).toBe("secure");
    expect(proxied).toEqual([`CONNECT ${new URL(secureUrl).host}`, `CONNECT ${new URL(secureUrl).host}`]);
  });

  it.each([
    ["without NODE_USE_ENV_PROXY", () => ({ HTTP_PROXY: proxyUrl })],
    ["for a host in NO_PROXY", () => ({ NODE_USE_ENV_PROXY: "1", HTTP_PROXY: proxyUrl, NO_PROXY: "127.0.0.1" })],
  ])("connects directly %s", async (_label, env) => {
    await (await connect(env())(plainUrl)).text();

    expect(proxied).toEqual([]);
  });

  it("ignores the daemon's own proxy settings", async () => {
    daemonEnvironment({ NODE_USE_ENV_PROXY: "1", HTTP_PROXY: proxyUrl });

    await (await connect({})(plainUrl)).text();
    await (await connect({ NODE_USE_ENV_PROXY: "1" })(plainUrl)).text();

    expect(proxied).toEqual([]);
  });

  it("returns this runtime's own Response, with the status, headers, URL and body the server sent", async () => {
    const response = await connect({})(plainUrl, { method: "POST", headers: { "x-test": "yes" }, body: new URLSearchParams({ a: "1" }) });

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(201);
    expect(response.headers.get("x-echo")).toBe("yes");
    expect(response.url).toBe(plainUrl);
    expect(response.redirected).toBe(false);
    expect(await response.text()).toBe("a=1");
  });

  it("doesn't reuse the parsed list of one client for a client that trusts other certificates", async () => {
    const trusting = open({ NODE_EXTRA_CA_CERTS: certificate.certPath });
    expect(await (await trusting.fetch(secureUrl)).text()).toBe("secure");

    await expect(connect({ NODE_EXTRA_CA_CERTS: join(dir, "missing.pem") })(secureUrl)).rejects.toThrow("fetch failed");
  });

  it("parses a certificate list once for every connection that trusts the same certificates", async () => {
    const unique = join(dir, "unique-ca.pem");
    await writeFile(unique, `${await readFile(certificate.certPath, "utf8")}\n# ${Math.random()}\n`);
    const created = vi.spyOn(tls, "createSecureContext");

    for (let i = 0; i < 3; i++) expect(await (await connect({ NODE_EXTRA_CA_CERTS: unique })(secureUrl)).text()).toBe("secure");

    expect(created).toHaveBeenCalledTimes(1);
  });

  it("says when the response followed a redirect", async () => {
    const response = await connect({})(`${plainUrl}redirect`);

    expect(response.redirected).toBe(true);
    expect(response.url).toBe(`${plainUrl}landed`);
  });

  it("refuses a Request, whose method and body it would otherwise drop", async () => {
    await expect(connect({})(new Request(plainUrl))).rejects.toThrow("takes a URL");
  });

  it.each([
    ["for a connection set up after it", false],
    ["for the connection whose request it failed", true],
  ])("loads undici again after a failed load %s", async (_label, sameConnection) => {
    let failing = true;
    vi.resetModules();
    vi.doMock("undici", async (importOriginal) => {
      if (failing) throw new Error("undici is missing");
      return importOriginal();
    });
    onTestFinished(() => {
      vi.doUnmock("undici");
    });
    const reloaded = await import("../../../src/daemon/instances/network.js");
    const first = reloaded.networkFetch(networkSettings({}), spyLogger());
    fetches.push(first);

    await expect(first.fetch(plainUrl)).rejects.toThrow();
    failing = false;
    const next = sameConnection ? first : reloaded.networkFetch(networkSettings({}), spyLogger());
    fetches.push(next);

    expect((await next.fetch(plainUrl)).status).toBe(200);
  });

  it("refuses requests once closed", async () => {
    const created = open({});
    await (await created.fetch(plainUrl)).text();

    await created.close();

    await expect(created.fetch(plainUrl)).rejects.toThrow("network fetch is closed");
  });
});

describe.skipIf(process.platform === "win32" || !HAS_OPENSSL)("networkFetch in a daemon started with certificate settings of its own", () => {
  let dir: string;
  let certificate: SelfSignedCertificate;
  let server: https.Server;
  let url: string;
  let probe: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cbe-extra-ca-"));
    certificate = selfSignedCertificate(dir);
    server = https.createServer({ key: certificate.key, cert: certificate.cert }, (_req, res) => res.end("secure"));
    url = `https://127.0.0.1:${await listen(server)}/`;
    probe = await bundleForSubprocess("test/_helpers/subprocess/network-probe.ts", "network-probe");
  }, 30_000);

  afterAll(async () => {
    await close(server);
    await rm(dir, { recursive: true, force: true });
  });

  async function fetchFromDaemon(daemonEnv: Record<string, string>, clientEnv: Record<string, string>, cwd = process.cwd()): Promise<string> {
    const certificateSettings = ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "NODE_USE_SYSTEM_CA", "NODE_OPTIONS"];
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !certificateSettings.includes(name)));
    const { stdout } = await run(process.execPath, [probe, url, JSON.stringify(clientEnv)], { env: { ...inherited, ...daemonEnv }, cwd });
    return stdout.trim();
  }

  it("doesn't trust the daemon's own extra certificates for a client that has none", async () => {
    expect(await fetchFromDaemon({ NODE_EXTRA_CA_CERTS: certificate.certPath }, {})).toMatch(/^failed/);
  });

  it("uses the daemon's default store for a client that names the same extra file, even when the daemon was given it as a relative path", async () => {
    expect(await fetchFromDaemon({ NODE_EXTRA_CA_CERTS: certificate.certPath }, { NODE_EXTRA_CA_CERTS: certificate.certPath })).toBe("ok secure (default store)");
    const realDir = await realpath(dir);
    expect(await fetchFromDaemon({ NODE_EXTRA_CA_CERTS: "cert.pem" }, { NODE_EXTRA_CA_CERTS: join(realDir, "cert.pem") }, realDir)).toBe("ok secure (default store)");
  });

  it("builds its own list for a client that asks for the system's certificates when the daemon doesn't", async () => {
    expect(await fetchFromDaemon({}, { NODE_USE_SYSTEM_CA: "1", NODE_TLS_REJECT_UNAUTHORIZED: "0" })).toBe("ok secure (own list)");
  });

  it.each([
    ["alone", {}],
    ["with NODE_USE_SYSTEM_CA=1", { NODE_USE_SYSTEM_CA: "1" }],
  ])("trusts an SSL_CERT_FILE the client shares with the daemon, %s", async (_label, more) => {
    expect(await fetchFromDaemon({ SSL_CERT_FILE: certificate.certPath }, { SSL_CERT_FILE: certificate.certPath, ...more })).toBe("ok secure (own list)");
  });

  it("doesn't trust the daemon's own SSL_CERT_FILE for a client without one", async () => {
    expect(await fetchFromDaemon({ SSL_CERT_FILE: certificate.certPath }, {})).toMatch(/^failed/);
  });
});
