/**
 * `minga init`: non-interactive project.toml + head key scaffold for a
 * maintainer's agent. Generates TOML without importing Bun-only config code.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ReviewPolicy } from "../core/types.ts";
import type { CommandResult } from "./commands.ts";
import { formatReviewPolicy, headKeygenCommand } from "./commands.ts";
import { readHead, writeHead } from "./store.ts";

export interface InitInput {
  dir: string;
  name: string;
  goal: string;
  scope: string;
  check: string;
  paths: string[];
  /** Globs the server refuses to accept from a submission. */
  protect?: string[];
  /** Who admits work that passed the check (and the holdout). */
  review?: ReviewPolicy;
  branch?: string;
  force?: boolean;
  url?: string;
}

export interface InitOutput {
  projectToml: string;
  headKeyFile: string;
  head: string;
  next: string[];
}

/** TOML basic string with correct escaping of quotes, backslashes and controls. */
export function tomlBasicString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\u0008/g, "\\b")
    .replace(/\u0009/g, "\\t")
    .replace(/\u000a/g, "\\n")
    .replace(/\u000c/g, "\\f")
    .replace(/\u000d/g, "\\r")
    .replace(/[\u0000-\u001f\u007f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `"${escaped}"`;
}

export interface TomlInput {
  name: string;
  goal: string;
  scope: string;
  check: string;
  paths: string[];
  protect?: string[];
  review?: ReviewPolicy;
  branch?: string;
  url?: string;
  head: string;
}

export function renderProjectToml(input: TomlInput): string {
  const paths = input.paths.map(tomlBasicString).join(", ");
  const protect = input.protect ?? [];
  const review = input.review ?? { mode: "none" };
  const forbid = [
    { pattern: "\\.(only|skip)\\(", paths: ["**/*.test.*", "**/*.spec.*", "test/**"], reason: "focused or skipped tests" },
    { pattern: "@ts-ignore", reason: "suppressed type error" },
    { pattern: "eslint-disable", reason: "suppressed lint warning" },
  ].map((rule) => {
    const parts = [`pattern = ${tomlBasicString(rule.pattern)}`];
    if (rule.paths) parts.push(`paths = [${rule.paths.map(tomlBasicString).join(", ")}]`);
    if (rule.reason) parts.push(`reason = ${tomlBasicString(rule.reason)}`);
    return `#   { ${parts.join(", ")} },`;
  });
  return [
    "# Minga project configuration. Edit freely; the server re-reads it on restart.",
    `name = ${tomlBasicString(input.name)}`,
    `goal = ${tomlBasicString(input.goal)}`,
    `scope = ${tomlBasicString(input.scope)}`,
    `check = ${tomlBasicString(input.check)}`,
    `paths = [${paths}]`,
    `head = ${tomlBasicString(input.head)}`,
    "# Accepted work is committed here. Keep it a branch nobody has checked out; serve creates it.",
    `branch = ${tomlBasicString(input.branch ?? "minga")}`,
    "# Safety: protected paths are never accepted; review gates work that passed the check.",
    protect.length > 0
      ? `protect = [${protect.map(tomlBasicString).join(", ")}]`
      : '# protect = ["project.toml", "test/**"]',
    review.mode !== "none"
      ? `review = ${tomlBasicString(formatReviewPolicy(review))}`
      : '# review = "head"',
    "",
    "[rules]",
    "# width = 3",
    "# lease_minutes = 45",
    "# max_attempts_per_agent = 1",
    "# default_points = 10",
    '# accept = "head-or-votes:3"',
    "",
    "[rules.roles]",
    "# explore = 2",
    "# build = 5",
    "# attack = 2",
    "# distill = 1",
    "# plan = 0",
    "",
    "# SAFETY — optional guards for the gate. Uncomment what you need.",
    "# [gates]",
    "# max_files = 40",
    "# max_changed_lines = 2000",
    "# forbid = [",
    ...forbid,
    "# ]",
    "# warn = []",
    "# [holdout]",
    '# command = "bun test .holdout/"      # dir is laid over the checkout: keep tests in <dir>/.holdout/',
    '# dir = ".minga/holdout"          # server-only, never tracked by git',
    "# [sandbox]",
    '# mode = "docker"                 # fails closed when Docker is missing',
    '# image = "oven/bun:1"',
    '# network = "none"',
    "",
    "# [[task]]",
    '# title = "Describe the first task"',
    '# body = "What should agents do?"',
    "# points = 10",
    "",
  ].join("\n");
}

/** Files written + exact next commands; refuses to clobber project.toml. */
export function initCommand(input: InitInput): CommandResult<InitOutput> {
  const dir = resolve(input.dir);

  if (!existsSync(join(dir, ".git"))) {
    throw new Error(`${dir} is not a git repository; run "git init ${dir}" first`);
  }

  const tomlPath = join(dir, "project.toml");
  if (existsSync(tomlPath) && input.force !== true) {
    throw new Error(`${tomlPath} already exists; pass --force to overwrite it`);
  }

  const { identity, result } = headKeygenCommand(readHead(dir), input.url);
  const headKeyFile = writeHead(dir, identity);
  const projectToml = renderProjectToml({ ...input, head: result.data.head });
  writeFileSync(tomlPath, projectToml, "utf8");

  const gitignore = join(dir, ".gitignore");
  const current = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
  const hasIgnore = current.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return trimmed === ".minga" || trimmed === ".minga/";
  });
  if (!hasIgnore) {
    const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    writeFileSync(gitignore, `${current}${prefix}.minga/\n`, "utf8");
  }

  const baseUrl = (input.url ?? "http://127.0.0.1:7777").replace(/\/+$/, "");
  const next = [`minga serve --repo ${dir}`, `share ${baseUrl}/join`];
  const written = [tomlPath, headKeyFile];
  if (!hasIgnore) written.push(gitignore);

  return {
    text: [
      `wrote ${written.join("\nwrote ")}`,
      "next:",
      ...next.map((line) => `  ${line}`),
    ].join("\n"),
    data: { projectToml, headKeyFile, head: result.data.head, next },
  };
}
