import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createLogger, createNoopLogger } from "../src/logging/index.js";

const HOSTILE = "a\r\n\t\x00\x1b[31m\x7f\x80\x9b\x9f\u2028\u2029z";

describe("Logger", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  describe("level filtering", () => {
    it("suppresses debug messages at info level", () => {
      const logger = createLogger({ level: "info", format: "text" });
      logger.debug("hidden");
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it("passes info messages at info level", () => {
      const logger = createLogger({ level: "info", format: "text" });
      logger.info("visible");
      expect(stderrSpy).toHaveBeenCalledTimes(1);
    });

    it("passes warn and error messages at info level", () => {
      const logger = createLogger({ level: "info", format: "text" });
      logger.warn("warning");
      logger.error("error");
      expect(stderrSpy).toHaveBeenCalledTimes(2);
    });

    it("shows debug messages at debug level", () => {
      const logger = createLogger({ level: "debug", format: "text" });
      logger.debug("visible");
      expect(stderrSpy).toHaveBeenCalledTimes(1);
    });

    it("suppresses info and warn at error level", () => {
      const logger = createLogger({ level: "error", format: "text" });
      logger.debug("hidden");
      logger.info("hidden");
      logger.warn("hidden");
      expect(stderrSpy).not.toHaveBeenCalled();
      logger.error("visible");
      expect(stderrSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("text format", () => {
    it("matches expected pattern with component and server", () => {
      const logger = createLogger({ level: "info", format: "text" });
      logger.info("3 tools discovered", { component: "upstream", server: "linear" });

      const output = stderrSpy.mock.calls[0][0] as string;
      expect(output).toMatch(
        /^\d{2}:\d{2}:\d{2}\.\d{3} INFO  \[upstream:linear\] 3 tools discovered\n$/,
      );
    });

    it("shows component-only prefix when no server", () => {
      const logger = createLogger({ level: "info", format: "text" });
      logger.info("starting", { component: "bridge" });

      const output = stderrSpy.mock.calls[0][0] as string;
      expect(output).toMatch(/\[bridge\] starting/);
    });

    it("appends extra context as key=value pairs", () => {
      const logger = createLogger({ level: "info", format: "text" });
      logger.info("connected", { component: "upstream", server: "gh", retries: 3 });

      const output = stderrSpy.mock.calls[0][0] as string;
      expect(output).toContain("retries=3");
    });

    it("shows server-only prefix when no component", () => {
      const logger = createLogger({ level: "info", format: "text" });
      logger.info("ready", { server: "linear" });

      const output = stderrSpy.mock.calls[0][0] as string;
      expect(output).toMatch(/\[linear\] ready/);
    });

    it("serializes object context values as JSON", () => {
      const logger = createLogger({ level: "info", format: "text" });
      logger.info("event", { data: { a: 1 }, list: [1, 2] });

      const output = stderrSpy.mock.calls[0][0] as string;
      expect(output).toContain('data={"a":1}');
      expect(output).toContain("list=[1,2]");
    });

    it("renders null context values as 'null'", () => {
      const logger = createLogger({ level: "info", format: "text" });
      logger.info("event", { value: null });

      const output = stderrSpy.mock.calls[0][0] as string;
      expect(output).toContain("value=null");
    });

    it("skips undefined context values", () => {
      const logger = createLogger({ level: "info", format: "text" });
      logger.info("event", { present: "yes", missing: undefined });

      const output = stderrSpy.mock.calls[0][0] as string;
      expect(output).toContain("present=yes");
      expect(output).not.toContain("missing");
    });

    it("escapes newlines in messages", () => {
      const logger = createLogger({ level: "info", format: "text" });
      logger.info("line1\nline2");

      const output = stderrSpy.mock.calls[0][0] as string;
      expect(output).toContain("line1\\nline2");
      // Should be a single line ending with \n
      expect(output.split("\n")).toHaveLength(2); // content + trailing empty string from final \n
    });

    it("pads level names to 5 characters", () => {
      const logger = createLogger({ level: "debug", format: "text" });
      logger.debug("d");
      logger.info("i");
      logger.warn("w");
      logger.error("e");

      const calls = stderrSpy.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(calls[0]).toContain("DEBUG");
      expect(calls[1]).toContain("INFO ");
      expect(calls[2]).toContain("WARN ");
      expect(calls[3]).toContain("ERROR");
    });
  });

  describe("text format control characters", () => {
    const RAW_CONTROL_CHARACTER = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;
    const CASES: Array<[string, string]> = [
      ["\\r", "\r"],
      ["\\n", "\n"],
      ["\\t", "\t"],
      ["\\x00", "\x00"],
      ["\\x1b", "\x1b"],
      ["\\x1f", "\x1f"],
      ["\\x7f", "\x7f"],
      ["\\x80", "\x80"],
      ["\\x9b", "\x9b"],
      ["\\x9f", "\x9f"],
      ["\\u2028", "\u2028"],
      ["\\u2029", "\u2029"],
    ];

    function textLine(message: string, context?: Record<string, unknown>): string {
      createLogger({ level: "info", format: "text" }).info(message, context);
      return stderrSpy.mock.calls.at(-1)![0] as string;
    }

    function withoutTrailingNewline(line: string): string {
      expect(line.endsWith("\n")).toBe(true);
      return line.slice(0, -1);
    }

    it.each(CASES)("escapes %s the same way in the message, the server prefix and a context value", (escaped, raw) => {
      const line = withoutTrailingNewline(textLine(`m${raw}m`, { component: "c", server: `s${raw}s`, detail: `v${raw}v` }));

      expect(line).toContain(`[c:s${escaped}s] m${escaped}m detail=v${escaped}v`);
      expect(line).not.toMatch(RAW_CONTROL_CHARACTER);
    });

    it("keeps a value with a newline and a fake log prefix on one line", () => {
      const line = withoutTrailingNewline(textLine("client connected", { clientName: "x\n12:00:00.000 ERROR [bridge] forged" }));

      expect(line).toContain("clientName=x\\n12:00:00.000 ERROR [bridge] forged");
      expect(line).not.toContain("\n");
    });

    it("shows a terminal colour sequence as text instead of sending it", () => {
      const line = withoutTrailingNewline(textLine("event", { clientName: "\x1b[31mred" }));

      expect(line).toContain("clientName=\\x1b[31mred");
      expect(line).not.toContain("\x1b");
    });

    it("escapes the component prefix", () => {
      const line = withoutTrailingNewline(textLine("event", { component: "c\x1b" }));

      expect(line).toContain("[c\\x1b] event");
    });

    it("escapes DEL, C1 and line separators inside object values without escaping twice", () => {
      const line = withoutTrailingNewline(textLine("event", { data: { text: "a\x1b\x7f\x9b\u2028b" } }));

      expect(line).toContain('data={"text":"a\\u001b\\x7f\\x9b\\u2028b"}');
      expect(line).not.toMatch(RAW_CONTROL_CHARACTER);
    });

    it("never writes a control character other than the final newline, whatever the input", () => {
      const line = withoutTrailingNewline(textLine(HOSTILE, { component: HOSTILE, server: HOSTILE, text: HOSTILE, data: { nested: HOSTILE }, list: [HOSTILE] }));

      expect(line).not.toMatch(RAW_CONTROL_CHARACTER);
    });

    it.each([
      ["space", " "],
      ["tilde", "~"],
      ["no-break space", "\xa0"],
      ["accented letters", "José Müller"],
      ["emoji", "🦀"],
      ["CJK", "日本語"],
      ["bidi overrides", "\u202a\u202e\u2066\u2069"],
      ["the characters next to the line separators", "\u2027\u202a"],
      ["a Windows path", "C:\\Users\\x\\new"],
    ])("leaves %s unchanged", (_label, text) => {
      const line = withoutTrailingNewline(textLine(`m${text}m`, { component: "c", server: `s${text}s`, detail: `v${text}v` }));

      expect(line).toContain(`[c:s${text}s] m${text}m detail=v${text}v`);
    });

    it("renders an object whose JSON form is undefined as undefined, without throwing", () => {
      const line = withoutTrailingNewline(textLine("event", { data: { toJSON: () => undefined } }));

      expect(line).toMatch(/ event data=undefined$/);
    });

    it("leaves numbers, booleans and null unchanged", () => {
      const line = withoutTrailingNewline(textLine("event", { retries: 3, ok: true, value: null }));

      expect(line).toMatch(/ event retries=3 ok=true value=null$/);
    });

    it("renders an empty message and an empty value", () => {
      const line = withoutTrailingNewline(textLine("", { component: "c", empty: "" }));

      expect(line).toMatch(/\[c\]  empty=$/);
    });
  });

  describe("JSON format", () => {
    it("writes hostile input exactly as JSON.stringify does", () => {
      vi.useFakeTimers({ now: new Date("2026-01-02T03:04:05.006Z") });
      try {
        const context = { component: HOSTILE, server: HOSTILE, text: HOSTILE, data: { nested: HOSTILE } };
        createLogger({ level: "info", format: "json" }).info(HOSTILE, context);

        expect(stderrSpy.mock.calls[0][0]).toBe(
          JSON.stringify({ ...context, time: "2026-01-02T03:04:05.006Z", level: "info", msg: HOSTILE }) + "\n",
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("outputs parseable JSON with correct fields", () => {
      const logger = createLogger({ level: "info", format: "json" });
      logger.info("connected", { component: "upstream", server: "linear" });

      const output = stderrSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output.trim());

      expect(parsed.level).toBe("info");
      expect(parsed.msg).toBe("connected");
      expect(parsed.component).toBe("upstream");
      expect(parsed.server).toBe("linear");
      expect(parsed.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("structural fields cannot be overridden by context", () => {
      const logger = createLogger({ level: "info", format: "json" });
      logger.info("real message", { time: "fake", level: "fake", msg: "fake" });

      const parsed = JSON.parse((stderrSpy.mock.calls[0][0] as string).trim());
      expect(parsed.level).toBe("info");
      expect(parsed.msg).toBe("real message");
      expect(parsed.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("outputs one JSON object per line", () => {
      const logger = createLogger({ level: "info", format: "json" });
      logger.info("first");
      logger.info("second");

      expect(stderrSpy).toHaveBeenCalledTimes(2);
      const first = stderrSpy.mock.calls[0][0] as string;
      const second = stderrSpy.mock.calls[1][0] as string;
      expect(first.endsWith("\n")).toBe(true);
      expect(second.endsWith("\n")).toBe(true);
      // Each line should be independently parseable
      JSON.parse(first);
      JSON.parse(second);
    });
  });

  describe("child()", () => {
    it("merges default context into every log call", () => {
      const logger = createLogger({ level: "info", format: "json" });
      const child = logger.child({ component: "upstream", server: "gh" });
      child.info("ready");

      const parsed = JSON.parse((stderrSpy.mock.calls[0][0] as string).trim());
      expect(parsed.component).toBe("upstream");
      expect(parsed.server).toBe("gh");
      expect(parsed.msg).toBe("ready");
    });

    it("call-site context overrides child defaults", () => {
      const logger = createLogger({ level: "info", format: "json" });
      const child = logger.child({ component: "upstream", server: "gh" });
      child.info("override", { server: "linear" });

      const parsed = JSON.parse((stderrSpy.mock.calls[0][0] as string).trim());
      expect(parsed.server).toBe("linear");
    });

    it("preserves parent level filtering", () => {
      const logger = createLogger({ level: "warn", format: "text" });
      const child = logger.child({ component: "upstream" });
      child.info("hidden");
      child.debug("hidden");
      expect(stderrSpy).not.toHaveBeenCalled();
      child.warn("visible");
      expect(stderrSpy).toHaveBeenCalledTimes(1);
    });

    it("child of child merges all contexts", () => {
      const logger = createLogger({ level: "info", format: "json" });
      const child1 = logger.child({ component: "upstream" });
      const child2 = child1.child({ server: "linear" });
      child2.info("deep");

      const parsed = JSON.parse((stderrSpy.mock.calls[0][0] as string).trim());
      expect(parsed.component).toBe("upstream");
      expect(parsed.server).toBe("linear");
    });
  });

  describe("stdout safety", () => {
    it("never writes to stdout", () => {
      const logger = createLogger({ level: "debug", format: "text" });
      logger.debug("d");
      logger.info("i");
      logger.warn("w");
      logger.error("e");
      expect(stdoutSpy).not.toHaveBeenCalled();
    });

    it("JSON format never writes to stdout", () => {
      const logger = createLogger({ level: "debug", format: "json" });
      logger.debug("d");
      logger.info("i");
      logger.warn("w");
      logger.error("e");
      expect(stdoutSpy).not.toHaveBeenCalled();
    });
  });

  describe("setLevel", () => {
    it("changes the threshold for the logger and all children", () => {
      const logger = createLogger({ level: "error", format: "text" });
      const child = logger.child({ component: "test" });

      // At error level, info is suppressed
      child.info("hidden");
      expect(stderrSpy).not.toHaveBeenCalled();

      // Change to debug — both parent and child should see info
      logger.setLevel("debug");
      logger.info("parent visible");
      child.info("child visible");
      expect(stderrSpy).toHaveBeenCalledTimes(2);
    });

    it("child setLevel affects parent and siblings", () => {
      const logger = createLogger({ level: "error", format: "text" });
      const child1 = logger.child({ component: "a" });
      const child2 = logger.child({ component: "b" });

      child1.setLevel("info");
      logger.info("parent");
      child2.info("sibling");
      expect(stderrSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe("custom sink", () => {
    function capturing(options: Partial<Parameters<typeof createLogger>[0]> = {}) {
      const lines: string[] = [];
      const logger = createLogger({ level: "info", format: "text", write: (line) => lines.push(line), ...options });
      return { logger, lines };
    }

    it("sends every line to the sink instead of stderr", () => {
      const { logger, lines } = capturing();
      logger.info("one");
      logger.warn("two");
      expect(lines).toHaveLength(2);
      expect(lines[1]).toMatch(/WARN  two\n$/);
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it("adds the date and the pid when asked", () => {
      const { logger, lines } = capturing({ dated: true, pid: 4321 });
      logger.info("started", { component: "daemon" });
      expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2} \[4321\] INFO  \[daemon\] started\n$/);
    });

    describe("UTC offset", () => {
      const savedTz = process.env.TZ;

      afterEach(() => {
        if (savedTz === undefined) delete process.env.TZ;
        else process.env.TZ = savedTz;
      });

      it.each([
        ["UTC", /\+00:00$/],
        ["Asia/Kolkata", /\+05:30$/],
        ["America/St_Johns", /-0[23]:30$/],
        ["Pacific/Chatham", /\+1[23]:45$/],
      ])("matches the local time in %s", (tz, offset) => {
        process.env.TZ = tz;
        const { logger, lines } = capturing({ dated: true });
        logger.info("now");
        const stamp = lines[0].split(" ")[0];
        expect(stamp).toMatch(offset);
        expect(Math.abs(Date.parse(stamp) - Date.now())).toBeLessThan(5_000);
      });
    });

    it("gives child loggers the same sink, style and level", () => {
      const { logger, lines } = capturing({ dated: true, pid: 7 });
      const child = logger.child({ component: "child" });
      child.debug("hidden");
      child.info("shown");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/ \[7\] INFO  \[child\] shown\n$/);
      logger.setLevel("debug");
      child.debug("now shown");
      expect(lines).toHaveLength(2);
    });
  });

  describe("createNoopLogger", () => {
    it("does not write anything", () => {
      const logger = createNoopLogger();
      logger.debug("d");
      logger.info("i");
      logger.warn("w");
      logger.error("e");
      logger.child({ a: 1 }).info("also silent");
      expect(stderrSpy).not.toHaveBeenCalled();
      expect(stdoutSpy).not.toHaveBeenCalled();
    });
  });
});
