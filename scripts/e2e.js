#!/usr/bin/env node
/**
 * Runs the end-to-end check in test/e2e/run.ts against a fresh build of the
 * CLI. The build goes into a temporary folder, never the repo's dist/, which
 * a running manager may be using, and the check runs with HOME set to a
 * temporary folder, so it never touches the user's own config, manager or
 * npm cache. Exits with the check's exit code. Runs on macOS and Linux.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const tool = (name) => join(repo, "node_modules", ".bin", name);
const build = mkdtempSync(join(tmpdir(), "cbe-e2e-build-"));
const home = mkdtempSync(join(tmpdir(), "cbe-e2e-home-"));
mkdirSync(join(repo, ".test-bundles"), { recursive: true });
const bundleDir = mkdtempSync(join(repo, ".test-bundles", "e2e-"));
let exitCode = 1;

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {});

try {
  execFileSync(tool("tsup"), ["--out-dir", join(build, "dist")], { cwd: repo, stdio: ["ignore", "ignore", "inherit"] });
  copyFileSync(join(repo, "package.json"), join(build, "package.json"));
  cpSync(join(repo, "bin"), join(build, "bin"), { recursive: true });
  symlinkSync(join(repo, "node_modules"), join(build, "node_modules"));
  execFileSync(
    tool("esbuild"),
    [
      join(repo, "test", "e2e", "run.ts"),
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--target=node22",
      "--log-level=warning",
      `--outfile=${join(bundleDir, "run.mjs")}`,
      "--banner:js=import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
    ],
    { cwd: repo, stdio: "inherit" },
  );
  const run = spawnSync(process.execPath, [join(bundleDir, "run.mjs"), join(build, "dist", "index.js")], {
    cwd: repo,
    stdio: "inherit",
    env: { ...process.env, HOME: home, USERPROFILE: home, npm_config_cache: join(home, ".npm") },
  });
  exitCode = run.status ?? 1;
} finally {
  rmSync(build, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(bundleDir, { recursive: true, force: true });
}

process.exit(exitCode);
