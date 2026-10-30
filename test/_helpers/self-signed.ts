import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface SelfSignedCertificate {
  key: string;
  cert: string;
  certPath: string;
}

export const HAS_OPENSSL = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** A certificate for 127.0.0.1 written to `dir`. */
export function selfSignedCertificate(dir: string): SelfSignedCertificate {
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"],
    { stdio: "ignore" },
  );
  return { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8"), certPath };
}
