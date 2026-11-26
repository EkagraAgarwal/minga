import { describe, expect, test } from "bun:test";
import { DEFAULTS, parseArgs } from "./lib/args.ts";

describe("parseArgs", () => {
  test("returns the documented defaults", () => {
    expect(parseArgs([])).toEqual(DEFAULTS);
  });

  test("accepts --key value and --key=value forms", () => {
    const options = parseArgs([
      "--agents", "300", "--duration=60", "--cores", "3", "--tasks=100",
      "--port", "7801", "--ramp=25", "--pass", "0.9",
    ]);
    expect(options.agents).toBe(300);
    expect(options.duration).toBe(60);
    expect(options.cores).toBe(3);
    expect(options.tasks).toBe(100);
    expect(options.port).toBe(7801);
    expect(options.ramp).toBe(25);
    expect(options.pass).toBe(0.9);
  });

  test("parses think ranges and single values", () => {
    expect(parseArgs(["--think", "2-20"])).toMatchObject({ thinkMin: 2, thinkMax: 20 });
    expect(parseArgs(["--think=5"])).toMatchObject({ thinkMin: 5, thinkMax: 5 });
  });

  test("parses an existing server URL", () => {
    expect(parseArgs(["--url", "http://127.0.0.1:7777/"]).url).toBe("http://127.0.0.1:7777");
    expect(() => parseArgs(["--url", "ftp://example.com"])).toThrow(/http/);
    expect(() => parseArgs(["--url", "not-a-url"])).toThrow(/--url/);
  });

  test("rejects invalid numbers, ranges and unknown flags", () => {
    expect(() => parseArgs(["--agents", "0"])).toThrow(/agents/);
    expect(() => parseArgs(["--agents", "abc"])).toThrow(/agents/);
    expect(() => parseArgs(["--cores", "999"])).toThrow(/cores/);
    expect(() => parseArgs(["--port", "70000"])).toThrow(/port/);
    expect(() => parseArgs(["--pass", "1.5"])).toThrow(/pass/);
    expect(() => parseArgs(["--think", "20-2"])).toThrow(/think/);
    expect(() => parseArgs(["--mystery", "1"])).toThrow(/unknown option/);
    expect(() => parseArgs(["--agents"])).toThrow(/needs a value/);
    expect(() => parseArgs(["300"])).toThrow(/unexpected argument/);
  });
});
