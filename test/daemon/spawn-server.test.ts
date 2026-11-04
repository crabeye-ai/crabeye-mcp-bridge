import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { cmdExeArgs } from "../../src/daemon/spawn-server.js";

const SHIM = "C:\\shim (x) & ^ %OS% dir\\stub.cmd";
const PROGRAM = "C:\\app (x) & ^ %OS% dir\\server.exe";
const ARGS_TO_PASS_UNCHANGED = [
  "a b", "", '"q"', '{"q":"a&b"}', 'x"|y', 'a"^b', '"<z>"&', "(x) !y! ;,", "%PATH%", "%PATH:x=y%", "%", "%%", "%1", "%~1", "%*",
  "C:\\a b\\", "a\\\\", 'a\\\\"b', 'a\\"b', '{"root":"C:\\\\"}', "\\\\server\\share", "a=b", "C:\\Users\\José\\日本",
];

const UNESCAPED_QUOTE_OR_OPERATOR = /(^|[^^])(\^\^)*["&|<>()]/;
const PERCENT_WITHOUT_CARET = /%(?!\^)/;

function cmdPass(line: string): string {
  return line.replace(/\^(.)/g, "$1");
}

function cRuntimeArgv(line: string): string[] {
  const args: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (line[i] === " ") i++;
    if (i >= line.length) break;
    let arg = "";
    let quoted = false;
    while (i < line.length && (quoted || line[i] !== " ")) {
      let backslashes = 0;
      while (line[i] === "\\") {
        backslashes++;
        i++;
      }
      if (line[i] === '"') {
        arg += "\\".repeat(Math.floor(backslashes / 2));
        if (backslashes % 2 === 1) arg += '"';
        else quoted = !quoted;
        i++;
      } else {
        arg += "\\".repeat(backslashes);
        if (backslashes === 0) arg += line[i++];
      }
    }
    args.push(arg);
  }
  return args;
}

function commandLine(command: string, args: string[], batchFile: boolean): string {
  return cmdExeArgs(command, args, batchFile).at(-1)!.slice(1, -1);
}

function argvAfterCmdPasses(command: string, args: string[], batchFile: boolean): string[] {
  const lineCmdRuns = cmdPass(commandLine(command, args, batchFile));
  expect(lineCmdRuns.slice(0, command.length + 1)).toBe(`${command} `);
  const argsPart = lineCmdRuns.slice(command.length + 1);
  return cRuntimeArgv(batchFile ? cmdPass(argsPart) : argsPart);
}

describe("cmdExeArgs", () => {
  it.each(ARGS_TO_PASS_UNCHANGED)("gives a batch file's server %j unchanged after cmd.exe and then the batch file read the line", (arg) => {
    expect(argvAfterCmdPasses(SHIM, [arg], true)).toEqual([arg]);
  });

  it.each(ARGS_TO_PASS_UNCHANGED)("gives a program cmd.exe runs %j unchanged after cmd.exe read the line", (arg) => {
    expect(argvAfterCmdPasses(PROGRAM, [arg], false)).toEqual([arg]);
  });

  it("gives the server every argument unchanged when they come together", () => {
    expect(argvAfterCmdPasses(SHIM, ARGS_TO_PASS_UNCHANGED, true)).toEqual(ARGS_TO_PASS_UNCHANGED);
    expect(argvAfterCmdPasses(PROGRAM, ARGS_TO_PASS_UNCHANGED, false)).toEqual(ARGS_TO_PASS_UNCHANGED);
  });

  it.each(ARGS_TO_PASS_UNCHANGED)("leaves no quote, operator or variable for cmd.exe to act on with %j", (arg) => {
    for (const [command, batchFile] of [[SHIM, true], [PROGRAM, false]] as const) {
      const line = commandLine(command, [arg], batchFile);
      expect(line).not.toMatch(UNESCAPED_QUOTE_OR_OPERATOR);
      expect(line).not.toMatch(PERCENT_WITHOUT_CARET);
      if (batchFile) expect(cmdPass(line).slice(command.length + 1)).not.toMatch(UNESCAPED_QUOTE_OR_OPERATOR);
    }
  });

  it("keeps the space after a command that ends in %", () => {
    expect(commandLine("C:\\x\\a100%", ["b"], false)).toBe('C:\\x\\a100^% ^"b^"');
  });

  it("runs cmd.exe without AutoRun commands and with delayed expansion off", () => {
    expect(cmdExeArgs(SHIM, [], true).slice(0, 4)).toEqual(["/d", "/v:off", "/s", "/c"]);
  });

  it.each(["a\nb", "a\rb", "%\r&x"])("refuses the argument %j, which cmd.exe would cut off at its line break", (arg) => {
    expect(() => cmdExeArgs(SHIM, [arg], true)).toThrow("a command or argument with a line break can't be passed to cmd.exe");
  });

  it("refuses a command with a line break", () => {
    expect(() => cmdExeArgs("npx\nfoo", [], true)).toThrow("a command or argument with a line break can't be passed to cmd.exe");
  });

  it("quotes a long run of backslashes quickly", () => {
    const started = performance.now();
    cmdExeArgs(SHIM, [`${"\\".repeat(100_000)}x`], true);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("spawnServer", () => {
  it("runs on the cross-spawn version whose internals it uses", () => {
    expect((createRequire(import.meta.url)("cross-spawn/package.json") as { version: string }).version).toBe("7.0.6");
  });
});
