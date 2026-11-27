/**
 * src/verify/diff.ts — pure, line-based unified diffs.
 *
 * No Bun APIs and no I/O: this module is also bundled into the Node CLI.
 *
 * Conventions (kept explicit so callers can rely on them):
 * - CRLF is normalized to LF before line splitting. A trailing `\n` is not an
 *   extra blank line, but a *missing* one is recorded on the final line and
 *   rendered with git's `\ No newline at end of file` marker. So `"a"` ->
 *   `"a\n"` is a one-line change, not an added empty line.
 * - Hunk headers always print both counts (`@@ -1,1 +1,2 @@`). Git drops a
 *   `,1`, but the module contract requires `-start,count +start,count`.
 * - After trimming the common prefix/suffix, a Myers O(ND) trace computes the
 *   middle. When either middle side exceeds 20,000 lines or D would exceed
 *   4,000, the middle is emitted as a single whole-block replacement; this
 *   bounds both time and memory on large, wholly rewritten files.
 */
import type { FileChange, UnifiedDiff } from "../core/contracts.ts";

interface Line {
  text: string;
  /** True only for the last line of a file that did not end in `\n`. */
  noNewline: boolean;
}

type Op =
  | { kind: "equal"; a: number; b: number }
  | { kind: "del"; a: number }
  | { kind: "ins"; b: number };

interface Range {
  start: number;
  end: number;
}

interface DiffResult {
  ops: Op[];
  a: Line[];
  b: Line[];
  oldBefore: Int32Array;
  newBefore: Int32Array;
  added: number;
  removed: number;
}

const MAX_MIDDLE = 20_000;
const MAX_D = 4_000;

/** Split normalized content into lines; an empty string has no lines. */
function splitLines(content: string): Line[] {
  const normalized = content.replaceAll("\r\n", "\n");
  if (normalized === "") return [];
  const parts = normalized.split("\n");
  let missingFinalNewline = false;
  if (parts[parts.length - 1] === "") {
    parts.pop();
  } else {
    missingFinalNewline = true;
  }
  const last = parts.length - 1;
  return parts.map((text, index) => ({ text, noNewline: missingFinalNewline && index === last }));
}

function sameLine(a: Line, b: Line): boolean {
  return a.text === b.text && a.noNewline === b.noNewline;
}

/** Read a diagonal from a trace snapshot; unvisited diagonals hold -1. */
function traceAt(snapshot: Int32Array, half: number, k: number): number {
  const index = half + k;
  return index >= 0 && index < snapshot.length ? snapshot[index]! : -1;
}

/**
 * Reconstruct the shortest edit script from Myers' trace. `trace[d]` is the
 * state before round d, so it contains every diagonal visited in round d-1.
 */
function backtrack(trace: Int32Array[], n: number, m: number, d: number): Op[] {
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let depth = d; depth >= 1; depth--) {
    const snapshot = trace[depth]!;
    const k = x - y;
    const down = k === -depth ||
      (k !== depth && traceAt(snapshot, depth, k - 1) < traceAt(snapshot, depth, k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = traceAt(snapshot, depth, prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: "equal", a: x - 1, b: y - 1 });
      x--;
      y--;
    }
    if (x === prevX) {
      ops.push({ kind: "ins", b: y - 1 });
      y--;
    } else {
      ops.push({ kind: "del", a: x - 1 });
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ kind: "equal", a: x - 1, b: y - 1 });
    x--;
    y--;
  }
  while (x > 0) {
    ops.push({ kind: "del", a: x - 1 });
    x--;
  }
  while (y > 0) {
    ops.push({ kind: "ins", b: y - 1 });
    y--;
  }
  ops.reverse();
  return ops;
}

/** Myers O(ND). Returns null when the D budget is exhausted. */
function myers(a: Line[], b: Line[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((_, index) => ({ kind: "ins", b: index }) as Op);
  if (m === 0) return a.map((_, index) => ({ kind: "del", a: index }) as Op);

  const offset = MAX_D + 1;
  const v = new Int32Array(2 * offset + 1).fill(-1);
  v[offset + 1] = 0;
  const trace: Int32Array[] = [];

  for (let d = 0; d <= MAX_D; d++) {
    // Snapshot only the diagonals reachable so far: sum(d) ~ D^2/2 ints.
    const snapshot = new Int32Array(2 * d + 1).fill(-1);
    for (let k = -d; k <= d; k++) snapshot[d + k] = v[offset + k]!;
    trace.push(snapshot);

    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!);
      let x = down ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && sameLine(a[x]!, b[y]!)) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m, d);
    }
  }
  return null;
}

/** Compute the edit script plus the prefix counts needed for rendering. */
function compute(change: FileChange): DiffResult {
  const a = change.before === null ? [] : splitLines(change.before);
  const b = splitLines(change.after);

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && sameLine(a[prefix]!, b[prefix]!)) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix && suffix < b.length - prefix &&
    sameLine(a[a.length - 1 - suffix]!, b[b.length - 1 - suffix]!)
  ) suffix++;

  const aEnd = a.length - suffix;
  const bEnd = b.length - suffix;
  const aMid = a.slice(prefix, aEnd);
  const bMid = b.slice(prefix, bEnd);

  let middle: Op[];
  if (aMid.length > MAX_MIDDLE || bMid.length > MAX_MIDDLE) {
    middle = [
      ...aMid.map((_, index) => ({ kind: "del", a: index }) as Op),
      ...bMid.map((_, index) => ({ kind: "ins", b: index }) as Op),
    ];
  } else {
    middle = myers(aMid, bMid) ?? [
      ...aMid.map((_, index) => ({ kind: "del", a: index }) as Op),
      ...bMid.map((_, index) => ({ kind: "ins", b: index }) as Op),
    ];
  }

  const ops: Op[] = [];
  for (let i = 0; i < prefix; i++) ops.push({ kind: "equal", a: i, b: i });
  for (const op of middle) {
    if (op.kind === "equal") ops.push({ kind: "equal", a: op.a + prefix, b: op.b + prefix });
    else if (op.kind === "del") ops.push({ kind: "del", a: op.a + prefix });
    else ops.push({ kind: "ins", b: op.b + prefix });
  }
  for (let i = 0; i < suffix; i++) ops.push({ kind: "equal", a: aEnd + i, b: bEnd + i });

  const oldBefore = new Int32Array(ops.length + 1);
  const newBefore = new Int32Array(ops.length + 1);
  let added = 0;
  let removed = 0;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    oldBefore[i + 1] = oldBefore[i]! + (op.kind === "ins" ? 0 : 1);
    newBefore[i + 1] = newBefore[i]! + (op.kind === "del" ? 0 : 1);
    if (op.kind === "ins") added++;
    else if (op.kind === "del") removed++;
  }
  return { ops, a, b, oldBefore, newBefore, added, removed };
}

/** Group changed ops into hunks, expanding by `context` lines and merging overlaps. */
function hunkRanges(ops: Op[], context: number): Range[] {
  const ranges: Range[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i]!.kind === "equal") {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < ops.length && ops[j + 1]!.kind !== "equal") j++;
    const range: Range = {
      start: Math.max(0, i - context),
      end: Math.min(ops.length - 1, j + context),
    };
    const last = ranges[ranges.length - 1];
    if (last && range.start <= last.end + 1) last.end = Math.max(last.end, range.end);
    else ranges.push(range);
    i = j + 1;
  }
  return ranges;
}

/** Renders the body of one hunk. */
function hunkBody(result: DiffResult, range: Range): string[] {
  const lines: string[] = [];
  for (let index = range.start; index <= range.end; index++) {
    const op = result.ops[index]!;
    if (op.kind === "equal") {
      lines.push(` ${result.a[op.a]!.text}`);
    } else if (op.kind === "del") {
      const line = result.a[op.a]!;
      lines.push(`-${line.text}`);
      if (line.noNewline) lines.push("\\ No newline at end of file");
    } else {
      const line = result.b[op.b]!;
      lines.push(`+${line.text}`);
      if (line.noNewline) lines.push("\\ No newline at end of file");
    }
  }
  return lines;
}

export const unifiedDiff: UnifiedDiff = (change, context = 3) => {
  const result = compute(change);
  if (result.added === 0 && result.removed === 0) return { text: "", added: 0, removed: 0 };

  const ctx = Number.isFinite(context) ? Math.max(0, Math.floor(context)) : 3;
  const out: string[] = [
    change.before === null ? "--- /dev/null" : `--- a/${change.path}`,
    `+++ b/${change.path}`,
  ];
  for (const range of hunkRanges(result.ops, ctx)) {
    let oldCount = 0;
    let newCount = 0;
    for (let index = range.start; index <= range.end; index++) {
      const op = result.ops[index]!;
      if (op.kind !== "ins") oldCount++;
      if (op.kind !== "del") newCount++;
    }
    const oldStart = oldCount === 0 ? result.oldBefore[range.start]! : result.oldBefore[range.start]! + 1;
    const newStart = newCount === 0 ? result.newBefore[range.start]! : result.newBefore[range.start]! + 1;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    out.push(...hunkBody(result, range));
  }
  return { text: out.join("\n") + "\n", added: result.added, removed: result.removed };
};

/** 1-based line numbers in `after` for every line the diff adds. */
export function addedLines(change: FileChange): { line: number; text: string }[] {
  const result = compute(change);
  const added: { line: number; text: string }[] = [];
  for (let index = 0; index < result.ops.length; index++) {
    const op = result.ops[index]!;
    if (op.kind === "ins") {
      added.push({ line: result.newBefore[index]! + 1, text: result.b[op.b]!.text });
    }
  }
  return added;
}
