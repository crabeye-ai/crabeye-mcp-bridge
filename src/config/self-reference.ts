import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { APP_NAME, PACKAGE_NAME } from "../constants.js";
import type { ServerConfig } from "./schema.js";

const QUOTES = "\"'";
const PACKAGE_FLAG_PREFIX = /^(?:--package|-p)=/;
const COMMAND_LINE_FLAG_PREFIX = /^(?:--call|--command|-c)=/;

const COMMAND_LINE_FLAG = /^(?:-[eilnuvx]{0,4}c[eilnuvx]{0,4}|\/[ck]|--?command|--call)$/i;
const LONG_OPTION = /^--[\w-]+$/;
const BOOLEAN_LAUNCHER_FLAGS = new Set([
  "--yes",
  "--no",
  "--quiet",
  "--silent",
  "--verbose",
  "--offline",
  "--force",
  "--bun",
  "--ignore-existing",
  "--ignore-scripts",
  "--legacy-peer-deps",
]);
const NO_VALUE_FLAG = /^--(?:no|prefer)-/;

const POSIX_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const WINDOWS_SHELLS = new Set(["cmd", "powershell", "pwsh"]);
const SHELLS_AND_ENV = new Set([...POSIX_SHELLS, ...WINDOWS_SHELLS, "env"]);
const SLASH_SWITCH = /^\/[a-z?]+(?::\S*)?$/i;
const POWERSHELL_VALUE_SWITCH =
  /^[-/](?:executionpolicy|ep|ex|windowstyle|w|version|v|outputformat|of|o|inputformat|if|configurationname|psconsolefile|workingdirectory|wd|settingsfile|custompipename)$/i;
const ENV_VALUE_OPTION = /^(?:-[uCaP]|--(?:unset|chdir|argv0))$/;

const BIN_DIRS = new Set(["bin", ".bin"]);
const WINDOWS_SHIM = /\.(cmd|exe|ps1)$/i;
const VERSION_SUFFIX = /(?<=.)@[^/@]*$/;
const NPM_ALIAS = /^(?:(?:@[^/@\s]+\/)?[^/@\s]+@)?npm:/i;
const GIT_OR_FILE_SPEC_PREFIX = /^(?:(?:github|gitlab|bitbucket|file|ssh|git|git\+[a-z]+):|[^@\s/]+@[^:.\s/]+\.[^:\s]+:)/i;
const OWN_REPO = PACKAGE_NAME.replace(/^@/, "");
const TARBALL = new RegExp(`^(?:${OWN_REPO.replace("/", "-")}|${APP_NAME})-\\d[\\w.+-]*\\.tgz$`, "i");
const ENTRY_FILES = [`bin/${APP_NAME}`, "dist/index.js", "src/index.ts"];
const ENTRY_NAMES = new Set(ENTRY_FILES.map((entry) => entry.split("/").at(-1)!));

const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const WHITESPACE = /\s+/;
const PATH_SEPARATOR = /[\\/]/;

type Role = "commandLine" | "optionValue" | "argument";
type PackageLookup = { found: false } | { found: true; name: string | undefined };

const verdicts = new WeakMap<ServerConfig, boolean>();

export function isSelfReference(server: ServerConfig): boolean {
  if (!("command" in server)) return false;
  let verdict = verdicts.get(server);
  if (verdict === undefined) {
    verdict = classify(server.command, server.args ?? [], server.cwd);
    verdicts.set(server, verdict);
  }
  return verdict;
}

function classify(command: string, args: string[], cwd: string | undefined): boolean {
  const commandLine = unwrapCommand(command.trim());
  const programName = fileName(commandProgram(commandLine, cwd));
  if (programName === APP_NAME || namesBridgeAs("commandLine", commandLine, cwd)) return true;
  const roles = argumentRoles(programName, args);
  return args.some((raw, index) => namesBridgeAs(roles[index]!, unwrapArgument(raw), cwd));
}

function unwrapCommand(text: string): string {
  return stripQuotes(text).replace(PACKAGE_FLAG_PREFIX, "");
}

function unwrapArgument(raw: string): string {
  return unwrapCommand(raw.replace(COMMAND_LINE_FLAG_PREFIX, ""));
}

function commandProgram(line: string, cwd: string | undefined): string {
  if (!WHITESPACE.test(line) || existingFile(resolveToken(line, cwd) ?? line) !== undefined) return line;
  return line.split(WHITESPACE)[0]!;
}

function argumentRoles(programName: string, args: string[]): Role[] {
  const operands = shellOperands(programName, args);
  return args.map((raw, index) => {
    const previous = args[index - 1] ?? "";
    if (operands.has(index) || COMMAND_LINE_FLAG_PREFIX.test(raw) || COMMAND_LINE_FLAG.test(previous)) return "commandLine";
    if (takesValue(previous) && previous !== "--package") return "optionValue";
    return "argument";
  });
}

function takesValue(option: string): boolean {
  return LONG_OPTION.test(option) && !BOOLEAN_LAUNCHER_FLAGS.has(option) && !NO_VALUE_FLAG.test(option);
}

function shellOperands(programName: string, args: string[]): Set<number> {
  const operands = new Set<number>();
  let program = programName;
  for (let index = 0; index < args.length && SHELLS_AND_ENV.has(program); index++) {
    const arg = args[index]!;
    if (!isShellOperand(program, arg, args[index - 1] ?? "")) continue;
    operands.add(index);
    if (POSIX_SHELLS.has(program)) break;
    program = fileName(unwrapCommand(arg));
  }
  return operands;
}

function isShellOperand(program: string, arg: string, previous: string): boolean {
  if (arg.startsWith("-")) return false;
  if (WINDOWS_SHELLS.has(program)) return !SLASH_SWITCH.test(arg) && !POWERSHELL_VALUE_SWITCH.test(previous);
  if (program === "env") return !arg.includes("=") && !ENV_VALUE_OPTION.test(previous);
  return true;
}

function namesBridgeAs(role: Role, token: string, cwd: string | undefined): boolean {
  if (token.length === 0) return false;
  switch (role) {
    case "commandLine":
      return namesBridgeAsCommandLine(token, cwd);
    case "optionValue":
      return namesBridgeUnambiguously(token, cwd);
    case "argument":
      return namesBridgeAsArgument(token, cwd);
  }
}

function namesBridgeAsCommandLine(line: string, cwd: string | undefined): boolean {
  return namesBridgeAsArgument(line, cwd) || namesBridgeWhenSplit(line, cwd);
}

function namesBridgeWhenSplit(line: string, cwd: string | undefined): boolean {
  const words = line
    .split(WHITESPACE)
    .map(unwrapArgument)
    .filter((word) => word.length > 0);
  if (words.length < 2 || !words.some((word) => namesBridgeAsArgument(word, cwd))) return false;
  return existingFile(resolveToken(line, cwd)) === undefined;
}

function namesBridgeAsArgument(token: string, cwd: string | undefined): boolean {
  return (
    isBareBin(token) ||
    isBinPath(token) ||
    isUnambiguousBridgeSpec(token) ||
    isAmbiguousBridgeSpec(token, cwd) ||
    namesEntryFile(token, cwd)
  );
}

function namesBridgeUnambiguously(token: string, cwd: string | undefined): boolean {
  return isBinPath(token) || isUnambiguousBridgeSpec(token) || namesEntryFile(token, cwd);
}

function isBareBin(token: string): boolean {
  return fileName(token) === APP_NAME && !PATH_SEPARATOR.test(token);
}

function isBinPath(token: string): boolean {
  if (fileName(token) !== APP_NAME) return false;
  return WINDOWS_SHIM.test(token) || BIN_DIRS.has(token.split(PATH_SEPARATOR).at(-2) ?? "");
}

function isUnambiguousBridgeSpec(spec: string): boolean {
  if (spec.startsWith("-")) return false;
  if (NPM_ALIAS.test(spec)) {
    const name = stripVersion(spec.replace(NPM_ALIAS, ""));
    return name === PACKAGE_NAME || name === APP_NAME;
  }
  return TARBALL.test(fileName(spec)) || stripVersion(spec) === PACKAGE_NAME;
}

function isAmbiguousBridgeSpec(spec: string, cwd: string | undefined): boolean {
  if (spec.startsWith("-") || NPM_ALIAS.test(spec)) return false;
  if (GIT_OR_FILE_SPEC_PREFIX.test(spec)) {
    const name = stripVersion(stripTrailingSlashes(beforeHash(spec.replace(GIT_OR_FILE_SPEC_PREFIX, ""))));
    return name === PACKAGE_NAME || stripGitSuffix(name.split("/").at(-1)!) === APP_NAME;
  }
  if (stripGitSuffix(beforeHash(spec)) === OWN_REPO) {
    const local = resolveToken(OWN_REPO, cwd);
    return local === undefined || safeStat(local) === undefined;
  }
  return stripVersion(spec) === APP_NAME;
}

function namesEntryFile(token: string, cwd: string | undefined): boolean {
  const resolved = resolveToken(token, cwd);
  if (ENTRY_NAMES.has(fileName(token))) {
    const real = existingFile(resolved);
    if (real !== undefined) return bridgeEntryOnDisk(real) ?? endsWithEntry(toPosix(real));
  }
  return [token, resolved].some((path) => path !== undefined && endsWithEntry(toPosix(path)));
}

function endsWithEntry(path: string): boolean {
  return ENTRY_FILES.some((entry) => path === `${APP_NAME}/${entry}` || path.endsWith(`/${APP_NAME}/${entry}`));
}

function bridgeEntryOnDisk(real: string): boolean | undefined {
  for (let dir = dirname(real); ; dir = dirname(dir)) {
    const lookup = readPackageName(join(dir, "package.json"));
    if (lookup.found) return lookup.name === PACKAGE_NAME && ENTRY_FILES.includes(toPosix(relative(dir, real)));
    if (dirname(dir) === dir) return undefined;
  }
}

function readPackageName(packageJson: string): PackageLookup {
  let fd: number;
  try {
    fd = openSync(packageJson, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return { found: false };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_PACKAGE_JSON_BYTES) return { found: false };
    const text = readCapped(fd, stat.size);
    if (text === undefined) return { found: false };
    const parsed = JSON.parse(text) as { name?: unknown };
    return { found: true, name: typeof parsed.name === "string" ? parsed.name : undefined };
  } catch {
    return { found: false };
  } finally {
    closeSync(fd);
  }
}

function readCapped(fd: number, expectedSize: number): string | undefined {
  let buffer = Buffer.alloc(Math.min(Math.max(expectedSize, 4096), MAX_PACKAGE_JSON_BYTES) + 1);
  let length = 0;
  for (;;) {
    const read = readSync(fd, buffer, length, buffer.length - length, null);
    if (read === 0) return buffer.toString("utf-8", 0, length);
    length += read;
    if (length > MAX_PACKAGE_JSON_BYTES) return undefined;
    if (length === buffer.length) {
      const grown = Buffer.alloc(Math.min(buffer.length * 2, MAX_PACKAGE_JSON_BYTES + 1));
      buffer.copy(grown, 0, 0, length);
      buffer = grown;
    }
  }
}

function resolveToken(token: string, cwd: string | undefined): string | undefined {
  if (isAbsolute(token)) return token;
  return cwd === undefined ? undefined : join(cwd, token);
}

function existingFile(path: string | undefined): string | undefined {
  if (path === undefined || !safeStat(path)?.isFile()) return undefined;
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function safeStat(path: string): Stats | undefined {
  try {
    return statSync(path, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
}

function stripQuotes(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && QUOTES.includes(text[start]!)) start++;
  while (end > start && QUOTES.includes(text[end - 1]!)) end--;
  return text.slice(start, end);
}

function stripVersion(spec: string): string {
  return spec.replace(VERSION_SUFFIX, "");
}

function stripTrailingSlashes(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === "/") end--;
  return text.slice(0, end);
}

function stripGitSuffix(name: string): string {
  return name.endsWith(".git") ? name.slice(0, -4) : name;
}

function beforeHash(text: string): string {
  const hash = text.indexOf("#");
  return hash === -1 ? text : text.slice(0, hash);
}

function fileName(token: string): string {
  return token.split(PATH_SEPARATOR).at(-1)!.replace(WINDOWS_SHIM, "").toLowerCase();
}

function toPosix(path: string): string {
  return path.split(PATH_SEPARATOR).join("/");
}
