import { build } from "esbuild";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const bundleDir = join(repoRoot, ".test-bundles");

export async function bundleForSubprocess(entry: string, name: string): Promise<string> {
  const outfile = join(bundleDir, `${name}-${process.env.VITEST_POOL_ID ?? "0"}.mjs`);
  await build({
    entryPoints: [resolve(repoRoot, entry)],
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    outfile,
    logLevel: "silent",
  });
  return outfile;
}
