import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readFile, rename, rm, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const RELEASED_PACKAGE = "@crabeye-ai/crabeye-mcp-bridge";
const FIXTURE_LOCKFILE = "package-lock.fixture.json";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function fixtureDir(version: string): string {
  return join(repoRoot, "test", "fixtures", `released-${version}`);
}

async function installDir(version: string): Promise<string> {
  const lock = await readFile(join(fixtureDir(version), FIXTURE_LOCKFILE));
  const key = createHash("sha256").update(lock).digest("hex").slice(0, 16);
  return join(repoRoot, "node_modules", ".cache", `crabeye-mcp-bridge-${version}-${key}`);
}

/** Installs the published `version` from its committed lockfile, once per lockfile, and returns the install dir. */
export async function installReleasedBridge(version: string): Promise<string> {
  const dir = await installDir(version);
  if (existsSync(join(dir, "node_modules", RELEASED_PACKAGE, "dist", "index.js"))) return dir;
  await mkdir(dirname(dir), { recursive: true });
  const staging = await mkdtemp(`${dir}.staging-`);
  try {
    await copyFile(join(fixtureDir(version), "package.json"), join(staging, "package.json"));
    await copyFile(join(fixtureDir(version), FIXTURE_LOCKFILE), join(staging, "package-lock.json"));
    await promisify(execFile)("npm", ["ci", "--prefix", staging, "--ignore-scripts", "--no-bin-links", "--no-audit", "--no-fund"]);
    await rename(staging, dir).catch(async (err: NodeJS.ErrnoException) => {
      if (!existsSync(dir)) throw err;
    });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return dir;
}

/** Copies the published `version` into `root` and returns its CLI entry script. */
export async function releasedBridgeAt(version: string, root: string): Promise<string> {
  const installed = await installReleasedBridge(version);
  const pkg = join(installed, "node_modules", RELEASED_PACKAGE);
  await cp(join(pkg, "dist"), join(root, "dist"), { recursive: true });
  await cp(join(pkg, "package.json"), join(root, "package.json"));
  await symlink(join(installed, "node_modules"), join(root, "node_modules"));
  return join(root, "dist", "index.js");
}
