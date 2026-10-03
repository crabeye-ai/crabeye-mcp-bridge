import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { APP_NAME, PACKAGE_NAME } from "../constants.js";
import type { ServerConfig } from "./schema.js";

const ENTRY_FILES = [`bin/${APP_NAME}`, "dist/index.js", "src/index.ts"];
const BIN_DIRS = new Set(["bin", ".bin"]);
const WINDOWS_SHIM = /\.(cmd|exe|ps1)$/i;
const ENTRY_NAMES = new Set(ENTRY_FILES.map((entry) => entry.split("/").at(-1)!));
const VERSION_SUFFIX = /(?<=.)@[^/@]*$/;
const PACKAGE_FLAG_PREFIX = /^(?:--package|-p)=/;
const CALL_FLAG_PREFIX = /^(?:--call|--command|-c)=/;
const LONG_OPTION = /^--[\w-]+$/;
const SHELL_COMMAND_FLAG = /^(?:-[eilnuvx]{0,4}c[eilnuvx]{0,4}|\/[ck]|--?command|--call)$/i;
const SLASH_SWITCH = /^\/[a-z?]+(?::\S*)?$/i;
const ENV_VALUE_OPTION = /^(?:-[uCaP]|--(?:unset|chdir|argv0))$/;
const POWERSHELL_VALUE_SWITCH =
  /^[-/](?:executionpolicy|ep|ex|windowstyle|w|version|v|outputformat|of|o|inputformat|if|configurationname|psconsolefile|workingdirectory|wd|settingsfile|custompipename)$/i;
const PACKAGE_OPTIONS = new Set(["--package"]);
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
const WHITESPACE = /\s+/;
const NPM_ALIAS = /^(?:(?:@[^/@\s]+\/)?[^/@\s]+@)?npm:/i;
const PREFIXED_SPEC = /^(?:(?:github|gitlab|bitbucket|file|ssh|git|git\+[a-z]+):|[^@\s/]+@[^:.\s/]+\.[^:\s]+:)/i;
const OWN_REPO = PACKAGE_NAME.replace(/^@/, "");
const TARBALL = new RegExp(`^(?:${OWN_REPO.replace("/", "-")}|${APP_NAME})-\\d[\\w.+-]*\\.tgz$`, "i");
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;

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
  const program = clean(command.trim());
  const programFile = fileName(programPath(program, cwd));
  if (programFile === APP_NAME) return true;
  if (commandLineNamesBridge(program, cwd)) return true;
  const commandLines = commandLineIndexes(programFile, args);
  return args.some((raw, index) => {
    const previous = args[index - 1];
    const token = clean(raw.replace(CALL_FLAG_PREFIX, ""));
    if (token.length === 0) return false;
    if (commandLines.has(index) || CALL_FLAG_PREFIX.test(raw) || (previous !== undefined && SHELL_COMMAND_FLAG.test(previous))) {
      return commandLineNamesBridge(token, cwd);
    }
    return tokenNamesBridge(token, cwd, isOptionValue(previous));
  });
}

function commandLineIndexes(programFile: string, args: string[]): Set<number> {
  const indexes = new Set<number>();
  for (let program = programFile, start = 0; ; ) {
    const operand = operandIndex(program, args, start);
    if (operand === -1 || POSIX_SHELLS.has(program)) {
      if (operand !== -1) indexes.add(operand);
      return indexes;
    }
    indexes.add(operand);
    program = fileName(clean(args[operand]!));
    start = operand + 1;
  }
}

function operandIndex(programFile: string, args: string[], start: number): number {
  const isOperand = operandTest(programFile);
  if (isOperand === undefined) return -1;
  for (let index = start; index < args.length; index++) {
    if (isOperand(args[index]!, index > start ? args[index - 1]! : "")) return index;
  }
  return -1;
}

function operandTest(programFile: string): ((arg: string, previous: string) => boolean) | undefined {
  if (POSIX_SHELLS.has(programFile)) return (arg) => !arg.startsWith("-");
  if (WINDOWS_SHELLS.has(programFile)) {
    return (arg, previous) => !arg.startsWith("-") && !SLASH_SWITCH.test(arg) && !POWERSHELL_VALUE_SWITCH.test(previous);
  }
  if (programFile === "env") {
    return (arg, previous) => !arg.startsWith("-") && !arg.includes("=") && !ENV_VALUE_OPTION.test(previous);
  }
  return undefined;
}

function isOptionValue(previous: string | undefined): boolean {
  if (previous === undefined || !LONG_OPTION.test(previous)) return false;
  return !PACKAGE_OPTIONS.has(previous) && !BOOLEAN_LAUNCHER_FLAGS.has(previous) && !NO_VALUE_FLAG.test(previous);
}

function commandLineNamesBridge(line: string, cwd: string | undefined): boolean {
  return line.length > 0 && (tokenNamesBridge(line, cwd, false) || piecesNameBridge(line, cwd));
}

function programPath(program: string, cwd: string | undefined): string {
  if (!WHITESPACE.test(program) || existingFile(resolveToken(program, cwd) ?? program) !== undefined) return program;
  return program.split(WHITESPACE)[0]!;
}

function piecesNameBridge(line: string, cwd: string | undefined): boolean {
  const pieces = line
    .split(WHITESPACE)
    .map((piece) => clean(piece.replace(CALL_FLAG_PREFIX, "")))
    .filter((piece) => piece.length > 0);
  if (pieces.length < 2 || !pieces.some((piece) => tokenNamesBridge(piece, cwd, false))) return false;
  return existingFile(resolveToken(line, cwd)) === undefined;
}

function tokenNamesBridge(token: string, cwd: string | undefined, optionValue: boolean): boolean {
  if (namesBin(token, optionValue) || isBridgePackage(token, cwd, optionValue)) return true;
  const resolved = resolveToken(token, cwd);
  if (ENTRY_NAMES.has(fileName(token))) {
    const real = existingFile(resolved);
    if (real !== undefined) return bridgeEntryOnDisk(real) ?? endsWithEntry(toPosix(real));
  }
  return [token, resolved].some((path) => path !== undefined && endsWithEntry(toPosix(path)));
}

function namesBin(token: string, optionValue: boolean): boolean {
  if (fileName(token) !== APP_NAME) return false;
  const segments = toPosix(token).split("/");
  return WINDOWS_SHIM.test(token) || (segments.length === 1 && !optionValue) || BIN_DIRS.has(segments.at(-2)!);
}

function isBridgePackage(spec: string, cwd: string | undefined, optionValue: boolean): boolean {
  if (spec.startsWith("-")) return false;
  if (NPM_ALIAS.test(spec)) {
    const name = spec.replace(NPM_ALIAS, "").replace(VERSION_SUFFIX, "");
    return name === PACKAGE_NAME || name === APP_NAME;
  }
  if (TARBALL.test(fileName(spec))) return true;
  const withoutVersion = spec.replace(VERSION_SUFFIX, "");
  if (withoutVersion === PACKAGE_NAME) return true;
  if (optionValue) return false;
  if (PREFIXED_SPEC.test(spec)) {
    const name = trimTrailing(beforeHash(spec.replace(PREFIXED_SPEC, "")), "/").replace(VERSION_SUFFIX, "");
    return name === PACKAGE_NAME || stripGitSuffix(name.split("/").at(-1)!) === APP_NAME;
  }
  if (stripGitSuffix(beforeHash(spec)) === OWN_REPO) {
    const local = resolveToken(OWN_REPO, cwd);
    return local === undefined || !pathExists(local);
  }
  return withoutVersion === APP_NAME;
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

function pathExists(path: string): boolean {
  return safeStat(path) !== undefined;
}

function safeStat(path: string): Stats | undefined {
  try {
    return statSync(path, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
}

function clean(token: string): string {
  return trimTrailing(trimLeading(token, "\"'"), "\"'").replace(PACKAGE_FLAG_PREFIX, "");
}

function trimLeading(text: string, chars: string): string {
  let start = 0;
  while (start < text.length && chars.includes(text[start]!)) start++;
  return text.slice(start);
}

function trimTrailing(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1]!)) end--;
  return text.slice(0, end);
}

function beforeHash(text: string): string {
  const hash = text.indexOf("#");
  return hash === -1 ? text : text.slice(0, hash);
}

function stripGitSuffix(name: string): string {
  return name.endsWith(".git") ? name.slice(0, -4) : name;
}

function fileName(token: string): string {
  return toPosix(token).split("/").at(-1)!.replace(WINDOWS_SHIM, "").toLowerCase();
}

function toPosix(path: string): string {
  return path.split(/[\\/]/).join("/");
}
