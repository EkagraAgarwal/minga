/**
 * src/verify/gates.ts — static checks over a submission's diff. Pure apart
 * from `Bun.Glob` for path matching; no I/O.
 *
 * Only lines added by the diff are inspected, so a pre-existing shortcut in
 * `before` never flags a submission that did not introduce it.
 */
import type { EvaluateGates, FileChange } from "../core/contracts.ts";
import type { GateRule } from "../core/types.ts";
import { addedLines, unifiedDiff } from "./diff.ts";

const MAX_MESSAGES_PER_RULE = 20;

function pathsMatch(paths: string[] | undefined, path: string): boolean {
  if (!paths || paths.length === 0) return true;
  return paths.some((pattern) => new Bun.Glob(pattern).match(path));
}

/** One-line messages for a rule, capped at 20 plus a `... and K more` line. */
function ruleMessages(rule: GateRule, changes: FileChange[]): string[] {
  let regex: RegExp;
  try {
    regex = new RegExp(rule.pattern);
  } catch {
    // A malformed pattern cannot be applied; it must not crash the gate.
    return [];
  }

  const messages: string[] = [];
  let matches = 0;
  for (const change of changes) {
    if (!pathsMatch(rule.paths, change.path)) continue;
    for (const { line, text } of addedLines(change)) {
      regex.lastIndex = 0;
      const match = regex.exec(text);
      if (match === null) continue;
      matches++;
      let message = `${change.path}:${line} adds "${match[0].slice(0, 40)}"`;
      if (rule.reason) message += `: ${rule.reason}`;
      if (messages.length < MAX_MESSAGES_PER_RULE) messages.push(message);
    }
  }
  if (matches > MAX_MESSAGES_PER_RULE) {
    messages.push(`... and ${matches - MAX_MESSAGES_PER_RULE} more`);
  }
  return messages;
}

export const evaluateGates: EvaluateGates = (gates, changes) => {
  const violations: string[] = [];
  const warnings: string[] = [];
  let added = 0;
  let removed = 0;
  for (const change of changes) {
    const diff = unifiedDiff(change);
    added += diff.added;
    removed += diff.removed;
  }

  if (gates.maxFiles > 0 && changes.length > gates.maxFiles) {
    violations.push(`writes ${changes.length} files; this project allows at most ${gates.maxFiles} per submission`);
  }
  if (gates.maxChangedLines > 0 && added + removed > gates.maxChangedLines) {
    violations.push(
      `changes ${added + removed} lines; this project allows at most ${gates.maxChangedLines} per submission`,
    );
  }
  for (const rule of gates.forbid ?? []) violations.push(...ruleMessages(rule, changes));
  for (const rule of gates.warn ?? []) warnings.push(...ruleMessages(rule, changes));

  return { violations, warnings, added, removed };
};

/** Ready-made rules a host can offer as project.toml [gates] suggestions. */
export const DEFAULT_GATE_SUGGESTIONS: GateRule[] = [
  {
    pattern: "\\.only\\(|\\.skip\\(|\\bxit\\(|\\bxdescribe\\(|test\\.todo\\(",
    paths: ["**/*.test.*", "**/*.spec.*", "**/test/**", "**/tests/**", "**/__tests__/**"],
    reason: "focused or skipped test",
  },
  {
    pattern: "@ts-ignore|@ts-nocheck|eslint-disable|# type: ignore|#\\[allow\\(",
    reason: "suppressed diagnostic",
  },
  {
    pattern: "process\\.exit\\(0\\)|\\|\\| true\\b|sys\\.exit\\(0\\)",
    reason: "check exit code forced to success",
  },
];
