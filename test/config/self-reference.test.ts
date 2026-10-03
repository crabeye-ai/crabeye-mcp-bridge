import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isSelfReference } from "../../src/config/self-reference.js";
import { diffConfigs } from "../../src/config/config-diff.js";
import { BridgeConfigSchema, findSelfReferences, resolveUpstreams, type StdioServerConfig } from "../../src/config/schema.js";

const server = (command: string, args: string[] = [], cwd?: string): StdioServerConfig =>
  ({ command, args, ...(cwd !== undefined && { cwd }) }) as StdioServerConfig;

describe("isSelfReference", () => {
  it.each([
    ["npx as a single command string", server("npx crabeye-mcp-bridge")],
    ["npx with flags and a scoped, versioned spec", server("npx", ["-y", "@crabeye-ai/crabeye-mcp-bridge@2.0.0", "--config", "c.json"])],
    ["npx with the unscoped name at a dist tag", server("npx", ["crabeye-mcp-bridge@latest"])],
    ["npx --package", server("npx", ["-p", "@crabeye-ai/crabeye-mcp-bridge", "crabeye-mcp-bridge"])],
    ["npx --package=", server("npx", ["--package=@crabeye-ai/crabeye-mcp-bridge", "crabeye-mcp-bridge"])],
    ["pnpm dlx", server("pnpm", ["dlx", "crabeye-mcp-bridge"])],
    ["yarn dlx", server("yarn", ["dlx", "@crabeye-ai/crabeye-mcp-bridge"])],
    ["npm exec with --", server("npm", ["exec", "--", "crabeye-mcp-bridge"])],
    ["bunx", server("bunx", ["crabeye-mcp-bridge"])],
    ["the installed bin", server("crabeye-mcp-bridge", ["--config", "c.json"])],
    ["the bin by absolute path", server("/usr/local/bin/crabeye-mcp-bridge")],
    ["a Windows shim", server("C:\\Users\\me\\AppData\\Roaming\\npm\\crabeye-mcp-bridge.cmd")],
    ["node running the bin", server("node", ["/usr/local/bin/crabeye-mcp-bridge"])],
    ["node running a missing dist entry", server("node", ["/nowhere/crabeye-mcp-bridge/dist/index.js"])],
    ["node with a value-taking flag first", server("node", ["-r", "tsx/cjs", "/nowhere/crabeye-mcp-bridge/dist/index.js"])],
    ["a relative entry with no cwd", server("node", ["crabeye-mcp-bridge/dist/index.js"])],
    ["a Windows path to a missing bin", server("node", ["C:\\work\\crabeye-mcp-bridge\\bin\\crabeye-mcp-bridge"])],
    ["a Windows path to a missing dist entry", server("node", ["C:\\work\\crabeye-mcp-bridge\\dist\\index.js"])],
    ["node from Program Files running a Windows entry", server("C:\\Program Files\\nodejs\\node.exe", ["C:\\Users\\me\\crabeye-mcp-bridge\\dist\\index.js"])],
    ["cmd /c npx on Windows", server("cmd", ["/c", "npx", "-y", "@crabeye-ai/crabeye-mcp-bridge"])],
    ["sh -c with a command string", server("sh", ["-c", "npx crabeye-mcp-bridge --config c.json"])],
    ["env with variables first", server("env", ["FOO=1", "crabeye-mcp-bridge"])],
    ["an npx flag that takes a value", server("npx", ["--registry", "https://npm.example", "crabeye-mcp-bridge"])],
    ["npx tsx on a missing source entry", server("npx", ["tsx", "/x/crabeye-mcp-bridge/src/index.ts"])],
    ["bun run on a missing dist entry", server("bun", ["run", "/x/crabeye-mcp-bridge/dist/index.js"])],
    ["node --env-file before the entry", server("node", ["--env-file", ".env", "/x/crabeye-mcp-bridge/dist/index.js"])],
    ["upper-case Windows names", server("C:\\nodejs\\NPX.CMD", ["CRABEYE-MCP-BRIDGE"])],
    ["a quoted single-string command", server('node "/x/crabeye-mcp-bridge/dist/index.js"')],
    ["npm x", server("npm", ["x", "crabeye-mcp-bridge"])],
    ["pnpx", server("pnpx", ["crabeye-mcp-bridge"])],
    ["bun x", server("bun", ["x", "@crabeye-ai/crabeye-mcp-bridge"])],
    ["a local node_modules bin", server("./node_modules/.bin/crabeye-mcp-bridge")],
    ["the bare name as an argument to another runner", server("npm", ["run", "crabeye-mcp-bridge"])],
    ["an npm: alias spec", server("npx", ["-y", "npm:@crabeye-ai/crabeye-mcp-bridge@2.0.0"])],
    ["a github: spec", server("npx", ["-y", "github:crabeye-ai/crabeye-mcp-bridge#main"])],
    ["a git+https spec", server("npx", ["-y", "git+https://github.com/crabeye-ai/crabeye-mcp-bridge.git"])],
    ["a file: spec", server("npx", ["-y", "file:../crabeye-mcp-bridge"])],
    ["a relative entry under a missing cwd checkout", server("tsx", ["src/index.ts"], "/nowhere/crabeye-mcp-bridge")],
    ["a Windows relative entry under a Windows cwd", server("node", ["dist\\index.js"], "C:\\work\\crabeye-mcp-bridge")],
    ["the bare bin with a cwd set", server("crabeye-mcp-bridge", [], "/some/project")],
    ["the bare Windows shim", server("crabeye-mcp-bridge.cmd")],
    ["pnpm's global bin directory", server("/Users/me/Library/pnpm/crabeye-mcp-bridge")],
    ["an asdf shim", server("/Users/me/.asdf/shims/crabeye-mcp-bridge", ["--config", "c.json"])],
    ["an unscoped npm: alias with a version", server("npx", ["-y", "npm:crabeye-mcp-bridge@2.0.0"])],
    ["the GitHub shorthand at a ref", server("npx", ["-y", "crabeye-ai/crabeye-mcp-bridge#main"])],
    ["a packed tarball", server("npx", ["-y", "./crabeye-ai-crabeye-mcp-bridge-2.0.0.tgz"])],
    ["a shim path as the first word of a single-string command", server("/Users/me/.asdf/shims/crabeye-mcp-bridge --config c.json")],
    ["npx --yes", server("npx", ["--yes", "crabeye-mcp-bridge"])],
    ["npm exec --call", server("npm", ["exec", '--call="crabeye-mcp-bridge --config x"'])],
    ["cmd /d /s /c with a command string", server("cmd", ["/d", "/s", "/c", "npx -y @crabeye-ai/crabeye-mcp-bridge"])],
    ["bash -lc with a command string", server("bash", ["-lc", "npx crabeye-mcp-bridge"])],
    ["an aliased npm: spec", server("npx", ["-y", "bridge@npm:@crabeye-ai/crabeye-mcp-bridge"])],
    ["an scp-style git spec", server("npx", ["-y", "git@github.com:crabeye-ai/crabeye-mcp-bridge.git"])],
    ["an ssh:// git spec", server("npx", ["-y", "ssh://git@github.com/crabeye-ai/crabeye-mcp-bridge.git"])],
    ["the GitHub shorthand with .git", server("npx", ["-y", "crabeye-ai/crabeye-mcp-bridge.git"])],
    ["a Windows shim run through cmd /c", server("cmd", ["/c", "C:\\Users\\me\\AppData\\Roaming\\npm\\crabeye-mcp-bridge.cmd"])],
    ["a PowerShell shim run with -File", server("powershell", ["-File", "C:\\Users\\me\\AppData\\Roaming\\npm\\crabeye-mcp-bridge.ps1"])],
    ["a node_modules bin run through node", server("node", ["/nowhere/node_modules/.bin/crabeye-mcp-bridge"])],
    ["the scoped name after an unfamiliar long flag", server("npx", ["--some-new-flag", "@crabeye-ai/crabeye-mcp-bridge"])],
    ["bunx --bun", server("bunx", ["--bun", "crabeye-mcp-bridge"])],
    ["bunx --bun with the scoped name", server("bunx", ["--bun", "@crabeye-ai/crabeye-mcp-bridge@latest"])],
    ["bun x --bun", server("bun", ["x", "--bun", "crabeye-mcp-bridge"])],
    ["deno run with a permission flag", server("deno", ["run", "--allow-all", "npm:@crabeye-ai/crabeye-mcp-bridge"])],
    ["npx with an unlisted no-value flag before the scoped name", server("npx", ["-y", "--no-update-notifier", "@crabeye-ai/crabeye-mcp-bridge"])],
    ["npm exec --yes --offline", server("npm", ["exec", "--yes", "--offline", "crabeye-mcp-bridge"])],
    ["powershell with the command as a bare argument", server("powershell", ["-NoProfile", "npx -y @crabeye-ai/crabeye-mcp-bridge"])],
    ["powershell -Command", server("powershell", ["-NoProfile", "-Command", "npx -y crabeye-mcp-bridge"])],
    ["pwsh --command", server("pwsh", ["--command", "npx -y @crabeye-ai/crabeye-mcp-bridge"])],
    ["bash -c --", server("bash", ["-c", "--", "npx crabeye-mcp-bridge"])],
    ["bash -cl", server("bash", ["-cl", "npx crabeye-mcp-bridge"])],
    ["cmd /k", server("cmd", ["/k", "npx crabeye-mcp-bridge"])],
    ["npm exec --call with a separate value", server("npm", ["exec", "--call", "crabeye-mcp-bridge --config x"])],
    ["a single-string npm exec --call=", server("npm exec --call=crabeye-mcp-bridge")],
    ["sh -c running npm exec --call=", server("sh", ["-c", "npm exec --call=crabeye-mcp-bridge"])],
    ["npm exec -c=", server("npm", ["exec", "-c=crabeye-mcp-bridge --config x"])],
    ["npm exec --call= as its own argument", server("npm", ["exec", "--call=crabeye-mcp-bridge"])],
    ["powershell.exe with the command as a bare argument", server("powershell.exe", ["-NoProfile", "npx -y @crabeye-ai/crabeye-mcp-bridge"])],
    ["powershell by its full Windows path", server("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", ["-NoProfile", "npx -y @crabeye-ai/crabeye-mcp-bridge"])],
    ["upper-case PWSH.EXE --command", server("PWSH.EXE", ["--command", "npx -y @crabeye-ai/crabeye-mcp-bridge"])],
    ["/bin/bash -c --", server("/bin/bash", ["-c", "--", "npx crabeye-mcp-bridge"])],
    ["powershell with a slash-style switch before the command", server("powershell", ["/NoProfile", "npx -y @crabeye-ai/crabeye-mcp-bridge"])],
    ["powershell with -ExecutionPolicy before the command", server("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "npx -y @crabeye-ai/crabeye-mcp-bridge"])],
    ["powershell with -WindowStyle before the command", server("powershell", ["-WindowStyle", "Hidden", "npx -y crabeye-mcp-bridge"])],
    ["cmd /c running powershell", server("cmd", ["/c", "powershell", "-NoProfile", "npx -y @crabeye-ai/crabeye-mcp-bridge"])],
    ["cmd /c running bash -c --", server("cmd", ["/c", "bash", "-c", "--", "npx crabeye-mcp-bridge"])],
    ["fish --command=", server("fish", ["-l", "--command=npx -y @crabeye-ai/crabeye-mcp-bridge"])],
    ["env running bash -lc", server("env", ["bash", "-lc", "npx crabeye-mcp-bridge"])],
    ["env running pwsh --command", server("env", ["FOO=1", "pwsh", "--command", "npx crabeye-mcp-bridge"])],
    ["env running cmd /k", server("env", ["cmd", "/k", "npx crabeye-mcp-bridge"])],
    ["env running a PowerShell implicit command", server("env", ["FOO=1", "pwsh", "-NoProfile", "npx -y crabeye-mcp-bridge"])],
    ["wsl running bash -lc", server("wsl", ["bash", "-lc", "npx crabeye-mcp-bridge"])],
    ["wsl running pwsh --command", server("wsl", ["pwsh", "--command", "npx crabeye-mcp-bridge"])],
    ["wsl running cmd /k", server("wsl", ["cmd", "/k", "npx crabeye-mcp-bridge"])],
    ["wsl running bash -cl", server("wsl", ["bash", "-cl", "npx crabeye-mcp-bridge"])],
    ["three levels of shells", server("env", ["cmd", "/c", "pwsh", "-NoProfile", "npx crabeye-mcp-bridge"])],
    ["a nested PowerShell given by full path", server("cmd", ["/c", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-NoProfile", "npx crabeye-mcp-bridge"])],
    ["env with an option value before the shell", server("env", ["-u", "HOME", "bash", "-fc", "npx crabeye-mcp-bridge"])],
    ["cmd /c with a nested bash -cl", server("cmd", ["/c", "bash", "-cl", "npx crabeye-mcp-bridge"])],
    ["a tarball after an unfamiliar long flag", server("npx", ["--some-new-flag", "./crabeye-ai-crabeye-mcp-bridge-2.0.0.tgz"])],
    ["an npm: alias after an unfamiliar long flag", server("npx", ["--some-new-flag", "npm:@crabeye-ai/crabeye-mcp-bridge"])],
    ["a versioned scoped name after an unfamiliar long flag", server("npx", ["--some-new-flag", "@crabeye-ai/crabeye-mcp-bridge@2.0.0"])],
    ["deno run with permission flags and an npm: spec", server("deno", ["run", "--allow-net", "--allow-env", "npm:crabeye-mcp-bridge@1.2.3"])],
  ])("treats %s as the bridge itself", (_label, config) => {
    expect(isSelfReference(config)).toBe(true);
  });

  it.each([
    ["a script elsewhere in a checkout path", server("node", ["/work/crabeye-mcp-bridge/tools/server.js"])],
    ["a flag value that contains the name", server("node", ["server.js", "--root", "/x/crabeye-mcp-bridge"])],
    ["a log file under a path containing the name", server("node", ["upstream.mjs", "/tmp/claude/-Users-me-dev-crabeye-mcp-bridge/run.log"])],
    ["npx running another package", server("npx", ["-y", "some-other-pkg", "crabeye-mcp-bridge.json"])],
    ["a package with a longer name", server("npx", ["crabeye-mcp-bridge-plugin"])],
    ["a different scope", server("npx", ["@someone/crabeye-mcp-bridge"])],
    ["an inline flag value that contains the name", server("node", ["server.js", "--root=/x/crabeye-mcp-bridge"])],
    ["a file named after the bridge with an extension", server("node", ["server.js", "crabeye-mcp-bridge.json"])],
    ["a remote server whose URL ends in the name", server("npx", ["mcp-remote", "https://gitmcp.io/crabeye-ai/crabeye-mcp-bridge"])],
    ["a repository URL for another fork", server("node", ["s.js", "--repo", "https://github.com/acme/crabeye-mcp-bridge"])],
    ["another project's dist entry", server("node", ["/work/weather/dist/index.js"])],
    ["another project's source entry", server("tsx", ["src/index.ts"], "/work/other")],
    ["a directory whose name only ends with the bridge's", server("node", ["/work/my-crabeye-mcp-bridge/dist/index.js"])],
    ["a single-string command whose argument is a path named after the bridge", server("node server.js --root /x/crabeye-mcp-bridge")],
    ["an npm: alias for another scope", server("npx", ["-y", "npm:@someone/crabeye-mcp-bridge"])],
    ["a relative source entry with no cwd", server("tsx", ["src/index.ts"])],
    ["a repository given as an option value", server("npx", ["-y", "@acme/github-mcp", "--repo", "crabeye-ai/crabeye-mcp-bridge"])],
    ["a repository given as an inline option value", server("npx", ["-y", "@acme/github-mcp", "--repo=crabeye-ai/crabeye-mcp-bridge"])],
    ["a project name given as an option value", server("node", ["sentry.js", "--project", "crabeye-mcp-bridge"])],
    ["a container name given inline", server("docker", ["run", "-i", "--name=crabeye-mcp-bridge", "img"])],
    ["a prompt that mentions the bridge", server("node", ["server.js", "--prompt", "You maintain crabeye-mcp-bridge and nothing else"])],
    ["a positional sentence that mentions the bridge", server("node", ["server.js", "You maintain crabeye-mcp-bridge and nothing else"])],
    ["a git URL given as an inline option value", server("npx", ["-y", "@acme/git-mcp", "--clone=git@github.com:crabeye-ai/crabeye-mcp-bridge.git"])],
    ["an npm alias given as an inline option value", server("npx", ["-y", "@acme/tool", "--alias=b@npm:@crabeye-ai/crabeye-mcp-bridge"])],
    ["a git URL given as a separate option value", server("npx", ["-y", "@acme/git-mcp", "--clone", "git@github.com:crabeye-ai/crabeye-mcp-bridge.git"])],
    ["a repository option after cmd /c", server("cmd", ["/c", "npx", "-y", "@modelcontextprotocol/server-github", "--repo", "crabeye-ai/crabeye-mcp-bridge"])],
    ["a project option after a bash script", server("bash", ["/opt/mcp/sentry.sh", "--project", "crabeye-mcp-bridge"])],
    ["a sentence after cmd /c", server("cmd", ["/c", "node", "server.js", "You maintain crabeye-mcp-bridge and nothing else"])],
    ["a sentence after a zsh script", server("zsh", ["run.zsh", "You maintain crabeye-mcp-bridge"])],
    ["script parameters after bash -c", server("bash", ["-c", 'exec npx -y @acme/gh "$@"', "_", "--repo", "crabeye-ai/crabeye-mcp-bridge"])],
    ["a value for an --allow- option", server("node", ["x.js", "--allow-origin", "crabeye-ai/crabeye-mcp-bridge"])],
    ["a PowerShell script on macOS or Linux given a sentence", server("pwsh", ["-ExecutionPolicy", "Bypass", "-File", "/opt/mcp/server.ps1", "You maintain crabeye-mcp-bridge and nothing else"])],
    ["env changing into a directory named after the bridge", server("env", ["--chdir", "crabeye-mcp-bridge", "npx", "-y", "@modelcontextprotocol/server-filesystem", "."])],
    ["env setting argv0 to the bridge's name", server("env", ["--argv0", "crabeye-mcp-bridge", "node", "x.js"])],
    ["a shell's script parameters that name another shell", server("sh", ["-c", "cmd", "sh", "You maintain crabeye-mcp-bridge"])],
    ["a sentence after the Go-style flag -config", server("mcp-x", ["-config", "You maintain crabeye-mcp-bridge"])],
    ["a sentence after the Go-style flag -source", server("mcp-x", ["-source", "You maintain crabeye-mcp-bridge"])],
    ["a sentence after the Go-style flag -scope", server("mcp-x", ["-scope", "You maintain crabeye-mcp-bridge"])],
    ["a sentence after the Go-style flag -cert", server("mcp-x", ["-cert", "You maintain crabeye-mcp-bridge"])],
    ["a sentence after the Go-style flag -cwd", server("mcp-x", ["-cwd", "You maintain crabeye-mcp-bridge"])],
    ["a sentence after the Go-style flag -cache", server("mcp-x", ["-cache", "You maintain crabeye-mcp-bridge"])],
    ["a sentence after the Go-style flag -secret", server("mcp-x", ["-secret", "You maintain crabeye-mcp-bridge"])],
    ["a runtime with no script", server("node", ["--version"])],
  ])("keeps %s", (_label, config) => {
    expect(isSelfReference(config)).toBe(false);
  });

  describe("with checkouts on disk", () => {
    let root: string;
    let clone: string;
    let impostor: string;
    let nested: string;

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "self-ref-"));
      clone = join(root, "my-clone");
      impostor = join(root, "crabeye-mcp-bridge");
      for (const [dir, name] of [
        [clone, "@crabeye-ai/crabeye-mcp-bridge"],
        [impostor, "something-else"],
      ] as const) {
        for (const sub of ["dist", "src", "bin", "tools"]) await mkdir(join(dir, sub), { recursive: true });
        await writeFile(join(dir, "package.json"), JSON.stringify({ name }));
        for (const file of ["dist/index.js", "src/index.ts", "bin/crabeye-mcp-bridge", "tools/server.js", "tools/index.js"]) {
          await writeFile(join(dir, file), "");
        }
      }
      nested = join(clone, "packages", "foo");
      await mkdir(join(nested, "dist"), { recursive: true });
      await writeFile(join(nested, "package.json"), JSON.stringify({ name: "foo" }));
      await writeFile(join(nested, "dist", "index.js"), "");
      await mkdir(join(clone, "unnamed", "dist"), { recursive: true });
      await writeFile(join(clone, "unnamed", "package.json"), JSON.stringify({ private: true }));
      await writeFile(join(clone, "unnamed", "dist", "index.js"), "");
      await mkdir(join(root, "linked"), { recursive: true });
      await symlink(join(clone, "dist", "index.js"), join(root, "linked", "index.js"));
    });

    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it("treats a bridge checkout's entry files as the bridge, whatever the directory is called", () => {
      expect(isSelfReference(server("node", [join(clone, "dist/index.js")]))).toBe(true);
      expect(isSelfReference(server("tsx", ["src/index.ts"], clone))).toBe(true);
      expect(isSelfReference(server("node", ["bin/crabeye-mcp-bridge"], clone))).toBe(true);
    });

    it("keeps other files in a bridge checkout, including ones named like an entry", () => {
      expect(isSelfReference(server("node", ["tools/server.js"], clone))).toBe(false);
      expect(isSelfReference(server("node", [join(clone, "tools", "index.js")]))).toBe(false);
      expect(isSelfReference(server("node", ["tools/index.js"], clone))).toBe(false);
    });

    it("keeps an entry-shaped file in a directory named after the bridge that is another package", () => {
      expect(isSelfReference(server("node", [join(impostor, "dist/index.js")]))).toBe(false);
    });

    it("decides by the nearest package.json, even one without a name", () => {
      expect(isSelfReference(server("node", [join(nested, "dist/index.js")]))).toBe(false);
      expect(isSelfReference(server("node", ["unnamed/dist/index.js"], clone))).toBe(false);
    });

    it("follows a symlink to a bridge entry file", () => {
      expect(isSelfReference(server("node", [join(root, "linked", "index.js")]))).toBe(true);
    });

    it("treats an existing entry file with no package.json above it by its path", async () => {
      const bundle = join(root, "loose", "crabeye-mcp-bridge", "dist");
      await mkdir(bundle, { recursive: true });
      await writeFile(join(bundle, "index.js"), "");
      expect(isSelfReference(server("node", [join(bundle, "index.js")]))).toBe(true);
    });

    it("does not trust a package.json too large to read", async () => {
      const big = join(root, "big");
      await mkdir(join(big, "dist"), { recursive: true });
      await writeFile(join(big, "package.json"), JSON.stringify({ name: "@crabeye-ai/crabeye-mcp-bridge", pad: "x".repeat(1024 * 1024) }));
      await writeFile(join(big, "dist", "index.js"), "");
      expect(isSelfReference(server("node", [join(big, "dist", "index.js")]))).toBe(false);
    });

    it("does not split a real file path that contains a space", async () => {
      const spaced = join(root, "John Smith", "crabeye-mcp-bridge");
      await mkdir(join(spaced, "dist"), { recursive: true });
      await writeFile(join(spaced, "package.json"), JSON.stringify({ name: "something-else" }));
      await writeFile(join(spaced, "dist", "index.js"), "");
      const script = join(spaced, "dist", "index.js");
      expect(isSelfReference(server("node", [script]))).toBe(false);
      expect(isSelfReference(server(script))).toBe(false);
      expect(isSelfReference(server("sh", ["-c", script]))).toBe(false);
    });

    it.skipIf(process.platform === "win32")("does not hang on a package.json that is a pipe", async () => {
      const piped = join(root, "piped");
      await mkdir(join(piped, "dist"), { recursive: true });
      execFileSync("mkfifo", [join(piped, "package.json")]);
      await writeFile(join(piped, "dist", "index.js"), "");
      expect(isSelfReference(server("node", [join(piped, "dist", "index.js")]))).toBe(false);
    });

    it("treats a project's local bridge bin as the bridge even inside another package", async () => {
      const app = join(root, "my-app");
      await mkdir(join(app, "node_modules", ".bin"), { recursive: true });
      await writeFile(join(app, "package.json"), JSON.stringify({ name: "my-app" }));
      await writeFile(join(app, "node_modules", ".bin", "crabeye-mcp-bridge"), "#!/bin/sh\n");
      expect(isSelfReference(server("node_modules/.bin/crabeye-mcp-bridge", [], app))).toBe(true);
    });

    it("keeps the verdict made when a config was loaded, even after the files change", async () => {
      const later = join(root, "later");
      await mkdir(join(later, "dist"), { recursive: true });
      await writeFile(join(later, "package.json"), JSON.stringify({ name: "@crabeye-ai/crabeye-mcp-bridge" }));
      const raw = { mcpServers: { x: { command: "node", args: [join(later, "dist", "index.js")] } } };
      const before = BridgeConfigSchema.parse(raw);
      expect(Object.keys(resolveUpstreams(before))).toEqual(["x"]);

      await writeFile(join(later, "dist", "index.js"), "");
      const after = BridgeConfigSchema.parse(raw);

      expect(diffConfigs(before, after).servers.removed).toEqual(["x"]);
    });

    it("keeps an existing script under a folder whose name starts with the bridge's", async () => {
      const copy = join(root, "crabeye-mcp-bridge copy", "scripts");
      await mkdir(copy, { recursive: true });
      await writeFile(join(copy, "weather.sh"), "");
      expect(isSelfReference(server(join(copy, "weather.sh")))).toBe(false);
    });

    it("keeps a local directory that looks like the GitHub shorthand", async () => {
      await mkdir(join(root, "crabeye-ai", "crabeye-mcp-bridge"), { recursive: true });
      expect(isSelfReference(server("node", ["server.js", "crabeye-ai/crabeye-mcp-bridge"], root))).toBe(false);
    });

    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("does not throw on paths it is not allowed to read", async () => {
      const locked = join(root, "locked");
      await mkdir(join(locked, "dist"), { recursive: true });
      await writeFile(join(locked, "dist", "index.js"), "");
      await chmod(locked, 0o000);
      try {
        expect(isSelfReference(server("node", [join(locked, "dist", "index.js")]))).toBe(false);
        expect(isSelfReference(server("node", ["server.js"], locked))).toBe(false);
      } finally {
        await chmod(locked, 0o755);
      }
    });

    it("treats a wrapper script named after the bridge in a bin directory as the bridge", async () => {
      const wrapper = join(root, "bin", "crabeye-mcp-bridge");
      await mkdir(join(root, "bin"), { recursive: true });
      await writeFile(wrapper, "#!/bin/sh\n");
      expect(isSelfReference(server(wrapper))).toBe(true);
    });

    it("keeps a directory named after the bridge passed as an argument", () => {
      expect(isSelfReference(server("node", ["server.js", impostor]))).toBe(false);
    });
  });
});

describe("launcher flags that take no value", () => {
  it.each(["--yes", "--no", "--quiet", "--silent", "--verbose", "--offline", "--force", "--bun", "--ignore-existing", "--ignore-scripts", "--legacy-peer-deps", "--prefer-offline", "--no-install"])(
    "still sees the bridge after %s",
    (flag) => {
      expect(isSelfReference(server("npx", [flag, "crabeye-mcp-bridge"]))).toBe(true);
    },
  );
});

describe("shells", () => {
  it.each(["sh", "bash", "zsh", "dash", "ksh", "fish", "cmd", "powershell", "pwsh"])("reads the command string run by %s", (shell) => {
    for (const program of [shell, `${shell}.exe`, `/usr/bin/${shell}`]) {
      expect(isSelfReference(server(program, ["--", "npx crabeye-mcp-bridge"]))).toBe(true);
    }
  });
});

describe("shell command flags", () => {
  it.each(["-c", "-ec", "-ic", "-lc", "-nc", "-uc", "-vc", "-xc", "-cl", "-ilc", "-euxc"])("reads the string after %s", (flag) => {
    expect(isSelfReference(server("wsl", ["sh", flag, "npx crabeye-mcp-bridge"]))).toBe(true);
  });
});

describe("PowerShell switches that take a value", () => {
  const switches = [
    "ExecutionPolicy", "ep", "ex", "WindowStyle", "w", "Version", "v", "OutputFormat", "of", "o",
    "InputFormat", "if", "ConfigurationName", "PSConsoleFile", "WorkingDirectory", "wd", "SettingsFile", "CustomPipeName",
  ];
  it.each(switches.flatMap((name) => [`-${name}`, `/${name}`]))("skips the value of %s", (sw) => {
    expect(isSelfReference(server("powershell", [sw, "x", "npx crabeye-mcp-bridge"]))).toBe(true);
  });
});

describe("pathological configs", () => {
  it.each([
    ["a long chain of shells", server("sh", Array(50_000).fill("sh"))],
    ["a long chain of cmd /c", server("cmd", Array.from({ length: 25_000 }, () => ["/c", "cmd"]).flat())],
    ["a long chain of env", server("env", Array(50_000).fill("env"))],
  ])("handles %s quickly without throwing", (_label, config) => {
    const startedAt = Date.now();
    expect(isSelfReference(config)).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});

describe("version suffix handling", () => {
  it.each([
    ["@ signs", `a${"@".repeat(60_000)}/`],
    ["quotes", `x${"'".repeat(60_000)}x`],
    ["slashes in an install spec", `file:a${"/".repeat(60_000)}x`],
    ["hashes in an install spec", `github:${"#".repeat(60_000)}\nx`],
  ])("stays fast on long arguments full of %s", (_label, arg) => {
    const startedAt = Date.now();
    isSelfReference(server("node", ["s.js", arg]));
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it.each([
    ["a long prompt with spaces", server("node", ["server.js", "--prompt", `You are a helpful assistant ${"x ".repeat(300)}`], "/tmp")],
    ["a long inline script", server("node", ["-e", `console.log(${"1+".repeat(1_000)}1)`], "/tmp")],
    ["an over-long script path", server("node", [`/tmp/${"a".repeat(300)}/index.js`])],
    ["a NUL byte", server("node", ["/tmp/a\u0000b/index.js"])],
  ])("never throws on %s", (_label, config) => {
    expect(() => isSelfReference(config)).not.toThrow();
    expect(isSelfReference(config)).toBe(false);
  });
});

describe("findSelfReferences", () => {
  it("names self-references in the imported client keys only", () => {
    const config = BridgeConfigSchema.parse({
      mcpServers: { bridge: { command: "npx", args: ["-y", "crabeye-mcp-bridge"] }, other: { command: "node", args: ["s.js"] } },
      context_servers: { zed: { command: "crabeye-mcp-bridge" } },
      upstreamMcpServers: { explicit: { command: "npx", args: ["crabeye-mcp-bridge"] } },
      servers: { vscode: { command: "npx crabeye-mcp-bridge" } },
      upstreamServers: { legacy: { command: "crabeye-mcp-bridge" } },
    });

    expect(findSelfReferences(config).sort()).toEqual(["bridge", "zed"]);
  });

  it("does not name a server that runs anyway under the same name from another key", () => {
    const config = BridgeConfigSchema.parse({
      mcpServers: { x: { command: "node", args: ["s.js"] }, y: { command: "crabeye-mcp-bridge" } },
      context_servers: { x: { command: "npx", args: ["crabeye-mcp-bridge"] } },
      upstreamMcpServers: { y: { command: "node", args: ["real.js"] } },
    });

    expect(findSelfReferences(config)).toEqual([]);
  });

  it("names a server once when both imported keys launch the bridge under that name", () => {
    const config = BridgeConfigSchema.parse({
      mcpServers: { b: { command: "crabeye-mcp-bridge" } },
      context_servers: { b: { command: "npx", args: ["crabeye-mcp-bridge"] } },
    });

    expect(findSelfReferences(config)).toEqual(["b"]);
  });

  it("ignores HTTP servers", () => {
    const config = BridgeConfigSchema.parse({ mcpServers: { remote: { url: "https://example.com/crabeye-mcp-bridge" } } });

    expect(findSelfReferences(config)).toEqual([]);
  });
});
