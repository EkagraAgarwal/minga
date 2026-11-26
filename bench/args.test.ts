import { describe, expect, test } from "bun:test";
import { DEFAULTS, defaultProcs, parseArgs } from "./lib/args.ts";

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

  test("check-concurrency defaults to cores - 1 (min 1) and can be overridden", () => {
    expect(parseArgs([]).checkConcurrency).toBe(1);
    expect(parseArgs(["--cores", "2"]).checkConcurrency).toBe(1);
    expect(parseArgs(["--cores", "3"]).checkConcurrency).toBe(2);
    expect(parseArgs(["--cores", "1"]).checkConcurrency).toBe(1);
    expect(parseArgs(["--cores", "3", "--check-concurrency", "1"]).checkConcurrency).toBe(1);
    expect(parseArgs(["--check-concurrency=4", "--cores", "2"]).checkConcurrency).toBe(4);
    expect(() => parseArgs(["--check-concurrency", "0"])).toThrow(/check-concurrency/);
  });

  test("defaults worker count to one per 250 agents and parses --procs", () => {
    expect(defaultProcs(1)).toBe(1);
    expect(defaultProcs(250)).toBe(1);
    expect(defaultProcs(251)).toBe(2);
    expect(defaultProcs(1000)).toBe(4);
    expect(defaultProcs(2500)).toBe(10);
    expect(parseArgs([]).procs).toBeUndefined();
    expect(parseArgs(["--agents", "1000", "--procs", "5"]).procs).toBe(5);
    expect(parseArgs(["--procs=2"]).procs).toBe(2);
    expect(() => parseArgs(["--procs", "0"])).toThrow(/procs/);
  });

  test("accepts the hidden worker flags", () => {
    const options = parseArgs([
      "--worker", "--worker-id", "3", "--agents", "250", "--agent-offset", "750",
      "--viewer-count", "2", "--probe-count", "0", "--sample-metrics=false",
      "--url", "http://127.0.0.1:1",
    ]);
    expect(options.worker).toBe(true);
    expect(options.workerId).toBe(3);
    expect(options.agents).toBe(250);
    expect(options.agentOffset).toBe(750);
    expect(options.viewerCount).toBe(2);
    expect(options.probeCount).toBe(0);
    expect(options.sampleMetrics).toBe(false);
    expect(parseArgs(["--worker=false"]).worker).toBe(false);
  });

  test("parses the boolean --keep flag without consuming the next argument", () => {
    expect(parseArgs([]).keep).toBe(false);
    expect(parseArgs(["--keep"]).keep).toBe(true);
    expect(parseArgs(["--keep", "--agents", "300"])).toMatchObject({ keep: true, agents: 300 });
    expect(parseArgs(["--keep=false"]).keep).toBe(false);
    expect(() => parseArgs(["--keep=yes"])).toThrow(/keep/);
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
