import { describe, expect, test } from "bun:test";
import type { FileChange } from "../src/core/contracts.ts";
import type { Gates } from "../src/core/types.ts";
import { DEFAULT_GATE_SUGGESTIONS, evaluateGates } from "../src/verify/gates.ts";

const gates = (overrides: Partial<Gates> = {}): Gates => ({
  maxFiles: 0,
  maxChangedLines: 0,
  forbid: [],
  warn: [],
  ...overrides,
});

const change = (before: string | null, after: string, path = "f"): FileChange => ({ path, before, after });

describe("evaluateGates", () => {
  test("maxFiles counts changed files", () => {
    const report = evaluateGates(gates({ maxFiles: 2 }), [
      change(null, "a\n", "a.ts"),
      change(null, "", "b.ts"),
      change(null, "c\n", "c.ts"),
    ]);
    expect(report.violations).toEqual(["writes 3 files; this project allows at most 2 per submission"]);
    expect(report.warnings).toEqual([]);
  });

  test("maxChangedLines counts added plus removed lines", () => {
    const report = evaluateGates(gates({ maxChangedLines: 1 }), [change("a\nb\n", "a\nx\n")]);
    expect(report.violations).toEqual(["changes 2 lines; this project allows at most 1 per submission"]);
    expect(report.added).toBe(1);
    expect(report.removed).toBe(1);
  });

  test("limits of zero are unlimited and totals add up across files", () => {
    const report = evaluateGates(gates(), [
      change(null, "a\nb\n", "a.ts"),
      change("x\n", "", "b.ts"),
    ]);
    expect(report).toEqual({ violations: [], warnings: [], added: 2, removed: 1 });
  });

  test("forbid rules inspect added lines only", () => {
    const rule = { pattern: "\\.only\\(", paths: ["**/*.test.*"], reason: "focused test" };
    const before = 'describe("x", () => {\n  it("a", () => {});\n  it("b", () => {});\n});\n';
    const without = evaluateGates(gates({ forbid: [rule] }), [change(before, before, "test/a.test.ts")]);
    expect(without.violations).toEqual([]);
    expect(without.added).toBe(0);

    const after = before.replace('  it("b", () => {});', '  it.only("b", () => {});');
    const withShortcut = evaluateGates(gates({ forbid: [rule] }), [change(before, after, "test/a.test.ts")]);
    expect(withShortcut.violations).toEqual(['test/a.test.ts:3 adds ".only(": focused test']);
  });

  test("path globs scope rules to matching files", () => {
    const rule = { pattern: "\\.only\\(", paths: ["**/*.test.*"], reason: "focused test" };
    const added = 'it.only("x", () => {});\n';
    expect(evaluateGates(gates({ forbid: [rule] }), [change(null, added, "src/a.ts")]).violations).toEqual([]);
    expect(evaluateGates(gates({ forbid: [rule] }), [change(null, added, "test/a.test.ts")]).violations).toEqual([
      'test/a.test.ts:1 adds ".only(": focused test',
    ]);
  });

  test("warn rules populate warnings, not violations; reason is optional", () => {
    const rule = { pattern: "@ts-ignore" };
    const changeSet = [change(null, "// @ts-ignore\n", "src/a.ts")];
    const warned = evaluateGates(gates({ warn: [rule] }), changeSet);
    expect(warned.violations).toEqual([]);
    expect(warned.warnings).toEqual(['src/a.ts:1 adds "@ts-ignore"']);

    const forbidden = evaluateGates(gates({ forbid: [rule] }), changeSet);
    expect(forbidden.warnings).toEqual([]);
    expect(forbidden.violations).toEqual(['src/a.ts:1 adds "@ts-ignore"']);
  });

  test("messages are capped at 20 per rule plus a count of the rest", () => {
    const after = Array.from({ length: 25 }, (_, i) => `// @ts-ignore ${i}\n`).join("");
    const report = evaluateGates(
      gates({ forbid: [{ pattern: "@ts-ignore", paths: ["src/**"], reason: "suppressed diagnostic" }] }),
      [change(null, after, "src/a.ts")],
    );
    expect(report.violations).toHaveLength(21);
    expect(report.violations[0]).toBe('src/a.ts:1 adds "@ts-ignore": suppressed diagnostic');
    expect(report.violations[19]).toBe('src/a.ts:20 adds "@ts-ignore": suppressed diagnostic');
    expect(report.violations[20]).toBe("... and 5 more");
  });

  test("matched text is truncated to 40 characters", () => {
    const long = "x".repeat(60);
    const report = evaluateGates(gates({ warn: [{ pattern: "x{50}" }] }), [change(null, `${long}\n`)]);
    expect(report.warnings).toEqual([`f:1 adds "${"x".repeat(40)}"`]);
  });
});

describe("DEFAULT_GATE_SUGGESTIONS", () => {
  test("rules are valid regexes with reasons", () => {
    expect(DEFAULT_GATE_SUGGESTIONS).toHaveLength(3);
    for (const rule of DEFAULT_GATE_SUGGESTIONS) {
      expect(() => new RegExp(rule.pattern)).not.toThrow();
      expect(rule.reason).toBeTruthy();
    }
  });

  test("catches focused tests, suppressions and exit-code games", () => {
    const report = evaluateGates(gates({ forbid: DEFAULT_GATE_SUGGESTIONS }), [
      change(null, 'it.only("x", () => {});\n', "test/a.test.ts"),
      change(null, "// @ts-ignore\n", "src/a.ts"),
      change(null, "exit 0 || true\n", "scripts/check.sh"),
    ]);
    expect(report.violations).toHaveLength(3);
    expect(report.violations.some((line) => line.includes("focused or skipped test"))).toBe(true);
    expect(report.violations.some((line) => line.includes("suppressed diagnostic"))).toBe(true);
    expect(report.violations.some((line) => line.includes("check exit code forced to success"))).toBe(true);
  });
});
