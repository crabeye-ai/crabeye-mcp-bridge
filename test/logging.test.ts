import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createLogger, createNoopLogger } from "../src/logging/index.js";

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

  describe("JSON format", () => {
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
