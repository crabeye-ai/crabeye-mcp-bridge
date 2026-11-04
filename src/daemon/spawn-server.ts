import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithStdioTuple, type StdioPipe } from "node:child_process";
import { createRequire } from "node:module";
import { normalize } from "node:path";
import { system32Path } from "../process/process-utils.js";

type PipedSpawnOptions = SpawnOptionsWithStdioTuple<StdioPipe, StdioPipe, StdioPipe>;

interface ParsedCommand {
  command: string;
  args: string[];
  options: PipedSpawnOptions;
  file?: string;
  original: { command: string; args: string[] };
}

const requireFromHere = createRequire(import.meta.url);
const crossSpawn = requireFromHere("cross-spawn") as {
  _parse(command: string, args: string[], options: PipedSpawnOptions): ParsedCommand;
  _enoent: { hookChildProcess(child: ChildProcessWithoutNullStreams, parsed: ParsedCommand): void };
};
const readShebang = requireFromHere("cross-spawn/lib/util/readShebang.js") as (file: string) => string | null;
const resolveCommand = requireFromHere("cross-spawn/lib/util/resolveCommand.js") as (parsed: Pick<ParsedCommand, "command" | "options">) => string | undefined;
const CMD_SPECIAL = /[()\][%!^"`<>&|;, *?]/g;
const PERCENT_WITHOUT_CARET = /%(?!\^|$)/g;
const BATCH_FILE = /\.(?:cmd|bat)\s*$/i;
const LINE_BREAK = /[\r\n]/;
const CMD_EXE_SWITCHES = ["/d", "/v:off", "/s", "/c"];

/**
 * Spawns `command` as cross-spawn does, except that on Windows `cmd.exe` is always the one in System32, whatever
 * `COMSPEC` says, and gets the command and arguments escaped for `cmd.exe`, and escaped again for the batch file when
 * it runs a `.cmd` or `.bat` file such as `npx.cmd`. A script whose shebang names an interpreter that `cmd.exe` runs,
 * such as `tsx` through `tsx.cmd`, is run as that interpreter with the script and arguments.
 */
export function spawnServer(command: string, args: string[], options: PipedSpawnOptions): ChildProcessWithoutNullStreams {
  const parsed = crossSpawn._parse(command, args, options);
  if (parsed.options.windowsVerbatimArguments) {
    parsed.command = system32Path("cmd.exe");
    const runsThroughShebang = parsed.original.args.length !== args.length;
    parsed.args = runsThroughShebang ? shebangCmdExeArgs(parsed) : cmdExeArgs(command, args, BATCH_FILE.test(parsed.file ?? command));
  }
  const child = spawn(parsed.command, parsed.args, parsed.options);
  crossSpawn._enoent.hookChildProcess(child, parsed);
  return child;
}

/**
 * The arguments for `cmd.exe` to run `command` with `args`, with delayed expansion off: the normalized command,
 * escaped for `cmd.exe`, and each argument quoted for the C runtime, then escaped for `cmd.exe` and, when `batchFile`
 * is true, again for the batch file. A caret follows each `%` except one that ends the command, so that no `%NAME%` is
 * expanded. Throws for a command or an argument with a line break.
 */
export function cmdExeArgs(command: string, args: string[], batchFile: boolean): string[] {
  if ([command, ...args].some((part) => LINE_BREAK.test(part))) throw new Error("a command or argument with a line break can't be passed to cmd.exe");
  const carets = batchFile ? "^^^" : "^";
  const line = [escapeForCmd(normalize(command), "^"), ...args.map((arg) => escapeForCmd(quoteForCRuntime(arg), carets))].join(" ");
  return [...CMD_EXE_SWITCHES, `"${line}"`];
}

function shebangCmdExeArgs(parsed: ParsedCommand): string[] {
  const interpreter = readShebang(parsed.file!)!;
  const interpreterFile = resolveCommand({ command: interpreter, options: parsed.options });
  const scriptAndArgs = parsed.original.args;
  return cmdExeArgs(interpreter, scriptAndArgs, BATCH_FILE.test(interpreterFile ?? interpreter));
}

function escapeForCmd(text: string, carets: string): string {
  return text.replace(CMD_SPECIAL, `${carets}$&`).replace(PERCENT_WITHOUT_CARET, "%^");
}

function quoteForCRuntime(arg: string): string {
  return `"${arg.replace(/(\\+)"|(\\+)$|\\+|"/g, (match, beforeQuote?: string, atEnd?: string) => {
    if (beforeQuote !== undefined) return `${beforeQuote}${beforeQuote}\\"`;
    if (atEnd !== undefined) return atEnd + atEnd;
    return match === '"' ? '\\"' : match;
  })}"`;
}
