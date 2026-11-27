import { describe, expect, test } from "bun:test";
import type { FileChange } from "../src/core/contracts.ts";
import { addedLines, unifiedDiff } from "../src/verify/diff.ts";

const change = (before: string | null, after: string, path = "f"): FileChange => ({ path, before, after });
const lf = (text: string): string => text.replaceAll("\r\n", "\n");

describe("unifiedDiff", () => {
  test("identical text yields an empty diff", () => {
    expect(unifiedDiff(change("a\nb\n", "a\nb\n"))).toEqual({ text: "", added: 0, removed: 0 });
    expect(unifiedDiff(change(null, ""))).toEqual({ text: "", added: 0, removed: 0 });
  });

  test("exact git-style output for an added line", () => {
    expect(unifiedDiff(change("a\nb\n", "a\nx\nb\n"))).toEqual({
      text: "--- a/f\n+++ b/f\n@@ -1,2 +1,3 @@\n a\n+x\n b\n",
      added: 1,
      removed: 0,
    });
  });

  test("exact git-style output for a removed line", () => {
    expect(unifiedDiff(change("a\nx\nb\n", "a\nb\n"))).toEqual({
      text: "--- a/f\n+++ b/f\n@@ -1,3 +1,2 @@\n a\n-x\n b\n",
      added: 0,
      removed: 1,
    });
  });

  test("exact git-style output for a modified line", () => {
    expect(unifiedDiff(change("a\nx\nb\n", "a\ny\nb\n"))).toEqual({
      text: "--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\n-x\n+y\n b\n",
      added: 1,
      removed: 1,
    });
  });

  test("a new file is diffed against /dev/null", () => {
    expect(unifiedDiff(change(null, "a\nb\n", "new.ts"))).toEqual({
      text: "--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n",
      added: 2,
      removed: 0,
    });
  });

  test("an emptied file removes every line", () => {
    expect(unifiedDiff(change("a\nb\n", ""))).toEqual({
      text: "--- a/f\n+++ b/f\n@@ -1,2 +0,0 @@\n-a\n-b\n",
      added: 0,
      removed: 2,
    });
  });

  test("a missing final newline is a change with git's marker", () => {
    expect(unifiedDiff(change("a", "a\n"))).toEqual({
      text: "--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@\n-a\n\\ No newline at end of file\n+a\n",
      added: 1,
      removed: 1,
    });
  });

  test("CRLF and LF produce the same diff", () => {
    const crlf = unifiedDiff(change("a\r\nx\r\nb\r\n", "a\r\ny\r\nb\r\n"));
    const lfDiff = unifiedDiff(change("a\nx\nb\n", "a\ny\nb\n"));
    expect(lf(crlf.text)).toBe(lfDiff.text);
    expect(crlf.added).toBe(lfDiff.added);
    expect(crlf.removed).toBe(lfDiff.removed);
  });

  test("two nearby changes merge into one hunk; small context splits them", () => {
    const before = Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join("\n") + "\n";
    const afterLines = Array.from({ length: 10 }, (_, i) => (i === 2 ? "X3" : i === 6 ? "X7" : `L${i + 1}`));
    const after = afterLines.join("\n") + "\n";

    expect(lf(unifiedDiff(change(before, after), 1).text)).toBe(
      "--- a/f\n+++ b/f\n" +
      "@@ -2,3 +2,3 @@\n L2\n-L3\n+X3\n L4\n" +
      "@@ -6,3 +6,3 @@\n L6\n-L7\n+X7\n L8\n",
    );
    expect(lf(unifiedDiff(change(before, after), 3).text)).toBe(
      "--- a/f\n+++ b/f\n@@ -1,10 +1,10 @@\n" +
      " L1\n L2\n-L3\n+X3\n L4\n L5\n L6\n-L7\n+X7\n L8\n L9\n L10\n",
    );
  });

  test("a 200k-line file with one change is diffed quickly", () => {
    const lines = Array.from({ length: 200_000 }, (_, i) => `line ${i}`);
    const before = lines.join("\n") + "\n";
    lines[100_000] = "changed";
    const after = lines.join("\n") + "\n";
    const start = performance.now();
    const result = unifiedDiff(change(before, after, "big.txt"));
    const elapsed = performance.now() - start;
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.text).toContain("-line 100000\n+changed\n");
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("addedLines", () => {
  test("returns 1-based line numbers in after", () => {
    expect(addedLines(change("a\nb\nc\n", "a\nx\ny\nc\n"))).toEqual([
      { line: 2, text: "x" },
      { line: 3, text: "y" },
    ]);
  });

  test("returns all lines of a new file and none for an unchanged file", () => {
    expect(addedLines(change(null, "a\nb\n"))).toEqual([
      { line: 1, text: "a" },
      { line: 2, text: "b" },
    ]);
    expect(addedLines(change("a\n", "a\n"))).toEqual([]);
  });
});
