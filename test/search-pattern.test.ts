import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseRegex, prefixOrRegex } from "../src/search/search-pattern.js";
import { bundleForSubprocess } from "./_helpers/subprocess-bundle.js";

const DESCRIPTION = "Create a new issue in the tracker with a title and a description for the team today.".repeat(4);
const RUN_OF_AS = `${"a".repeat(40)}!`;

const BACKTRACKING = [
  ["nested quantifiers", "regex:(.*.*)*Z", DESCRIPTION],
  ["a repeated group anchored at the end", "regex:^(\\w+\\s?)*$", `${DESCRIPTION}!`],
  ["nested pluses, case-insensitive", "/^(a+)+$/i", RUN_OF_AS],
  ["nested quantifiers, multiline and dot-all", "/(.*.*)*Z/ms", DESCRIPTION],
  ["a nested quantifier beside a small bounded repeat", "regex:(\\w+)+!|x{0,3}", DESCRIPTION],
] as const;

/** Times each pattern against its text in a child process, so a pattern that backtracks without end fails the test instead of hanging the run. */
function timeInChild(bundle: string, cases: ReadonlyArray<readonly [string, string, string]>): Array<number | null> | "timed out" {
  const script = `
    const { parseRegex } = await import(process.argv[1]);
    const timings = JSON.parse(process.argv[2]).map(([, input, text]) => {
      const pattern = parseRegex(input);
      if (pattern === null) return null;
      const startedAt = performance.now();
      pattern.test(text);
      return performance.now() - startedAt;
    });
    console.log(JSON.stringify(timings));`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script, pathToFileURL(bundle).href, JSON.stringify(cases)], {
    encoding: "utf8",
    timeout: 20_000,
  });
  return run.error === undefined && run.status === 0 ? JSON.parse(run.stdout) : "timed out";
}

describe("search patterns", () => {
  let timings: ReturnType<typeof timeInChild>;

  beforeAll(async () => {
    timings = timeInChild(await bundleForSubprocess("src/search/search-pattern.ts", "search-pattern"), BACKTRACKING);
  }, 30_000);

  it.each(BACKTRACKING.map(([name], index) => [name, index] as const))("finishes %s at once", (_case, index) => {
    expect(timings).not.toBe("timed out");
    expect((timings as Array<number | null>)[index]).toBeLessThan(500);
  });

  it.each([
    ["a backreference", "regex:(a)\\1"],
    ["a named backreference", "regex:(?<x>a)\\k<x>"],
    ["a lookahead", "regex:create(?=_issue)"],
    ["a bounded repeat over 16", "regex:(a+)+b|x{17}"],
    ["nested bounded repeats over 16", "regex:(a{4}){5}"],
    ["an inline case-insensitive group", "regex:(?i:(a+)+b)"],
    ["the u flag", "/issue/u"],
    ["the v flag", "/issue/v"],
    ["a Unicode property escape, which would match its own text", "regex:\\p{Lu}"],
    ["a negated Unicode property escape", "regex:\\P{Lu}"],
    ["a Unicode property escape after other text", "regex:a\\p{Lu}"],
    ["a Unicode property escape after an escaped backslash", "regex:\\\\\\p{Lu}"],
    ["a pattern over 200 characters", `regex:${"a".repeat(201)}`],
    ["an invalid pattern", "regex:[unclosed"],
  ])("isn't a regex with %s", (_case, input) => {
    expect(parseRegex(input)).toBeNull();
  });

  it("matches /…/i ignoring case, keeping the meaning of escapes", () => {
    expect(parseRegex("/^CREATE\\W/i")!.test("create issue")).toBe(true);
    expect(parseRegex("/^CREATE\\W/i")!.test("createissue")).toBe(false);
    expect(parseRegex("regex:^Create")!.test("create issue")).toBe(false);
    expect(parseRegex("/^create/i")!.test("CREATE issue")).toBe(true);
  });

  it.each([
    ["a word-final Greek sigma", "/ΟΔΟΣ/i", "ΟΔΟΣ"],
    ["a sigma before a space", "/ΟΔΟΣ ΚΑΙ/i", "ΟΔΟΣ ΚΑΙ"],
    ["a final sigma written in lower case", "/σ$/i", "ΟΔΟΣ"],
    ["an escaped upper-case letter", "/\\K/i", "K"],
    ["an escaped upper-case letter in a class", "/[\\K]/i", "K"],
    ["a letter outside the Basic Multilingual Plane", "/𐐀/i", "𐐀"],
  ])("matches %s under /…/i as the i flag would", (_case, input, text) => {
    expect(parseRegex(input)!.test(text)).toBe(true);
  });

  it("keeps the escapes \\B, \\D, \\S and \\W meaning what they mean under /…/i", () => {
    expect(parseRegex("/^\\D\\S\\W$/i")!.test("ab ")).toBe(true);
    expect(parseRegex("/a\\Bb/i")!.test("AB")).toBe(true);
    expect(parseRegex("/^\\D$/i")!.test("1")).toBe(false);
  });

  it("matches a letter written as a hex escape under /…/i ignoring its case", () => {
    expect(parseRegex("/\\x53earch/i")!.test("Search tools")).toBe(true);
    expect(parseRegex("/\\u0053EARCH/i")!.test("search tools")).toBe(true);
    expect(parseRegex("/\\x2e/i")!.test("a.b")).toBe(true);
  });

  it("matches a regex, or else a prefix ignoring case", () => {
    expect(prefixOrRegex("regex:manage").test("project management")).toBe(true);
    expect(prefixOrRegex("PROJ").test("project management")).toBe(true);
    expect(prefixOrRegex("manage").test("project management")).toBe(false);
  });

  it("checks before each test, letting what it throws stop the search", () => {
    let checks = 0;
    const pattern = parseRegex("regex:issue", () => {
      if (++checks > 2) throw new Error("too long");
    })!;

    expect([pattern.test("issue"), pattern.test("other")]).toEqual([true, false]);
    expect(() => pattern.test("issue")).toThrow("too long");
  });

  it("treats an escaped backslash before p{ as a regex, not a Unicode property escape", () => {
    expect(parseRegex("regex:\\\\p{2}")!.test("a\\pp")).toBe(true);
  });

  it("matches every value it is given with g or y, not only the first", () => {
    for (const input of ["/issue/g", "/issue/y", "/^issue/gy"]) {
      const pattern = parseRegex(input)!;
      expect(["issue one", "issue two", "issue three"].map((value) => pattern.test(value)), input).toEqual([true, true, true]);
    }
  });
});
