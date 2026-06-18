import { readFileSync, writeFileSync } from "node:fs";

export function syncPluginVersion(packageJsonPath, manifestPath) {
  const pkgVersion = JSON.parse(readFileSync(packageJsonPath, "utf-8")).version;
  if (typeof pkgVersion !== "string") {
    throw new Error(`No version field in ${packageJsonPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  if (manifest.version === pkgVersion) {
    return { changed: false, version: pkgVersion };
  }
  manifest.version = pkgVersion;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return { changed: true, version: pkgVersion };
}

if (import.meta.filename === process.argv[1]) {
  const result = syncPluginVersion("package.json", ".claude-plugin/plugin.json");
  if (result.changed) {
    console.log(`Synced .claude-plugin/plugin.json → version ${result.version}`);
  }
}
