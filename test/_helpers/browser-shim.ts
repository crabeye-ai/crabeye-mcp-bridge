import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

export interface BrowserShim {
  /** A PATH that finds the shim's `open` and `xdg-open` before any browser launcher. */
  path: string;
  /** The authorization URLs the shim was asked to open. */
  opened: () => Promise<string[]>;
  /** Why following an authorization URL failed, one line per failure. */
  failures: () => Promise<string[]>;
}

/**
 * Stands in for the browser `crabeye-mcp-bridge auth` opens: follows the
 * authorization URL's redirect back to the CLI's loopback listener, as a user
 * approving the request would, and records the URL.
 */
export async function browserShim(dir: string): Promise<BrowserShim> {
  const bin = join(dir, "browser-shim");
  const log = join(bin, "opened.txt");
  const failed = join(bin, "failed.txt");
  await mkdir(bin, { recursive: true });
  const script = `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const url = process.argv[2];
appendFileSync(${JSON.stringify(log)}, url + "\\n");
fetch(url, { redirect: "manual" })
  .then((response) => fetch(response.headers.get("location")))
  .catch((err) => appendFileSync(${JSON.stringify(failed)}, err.message + "\\n"));
`;
  for (const name of ["open", "xdg-open"]) {
    await writeFile(join(bin, name), script);
    await chmod(join(bin, name), 0o755);
  }
  return {
    path: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    opened: () => linesOf(log),
    failures: () => linesOf(failed),
  };
}

async function linesOf(path: string): Promise<string[]> {
  return (await readFile(path, "utf8").catch(() => "")).split("\n").filter(Boolean);
}
