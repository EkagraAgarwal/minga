/**
 * `minga init`: non-interactive project.toml + head key scaffold for a
 * maintainer's agent. Generates TOML without importing Bun-only config code.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CommandResult } from "./commands.ts";
import { headKeygenCommand } from "./commands.ts";
import { readHead, writeHead } from "./store.ts";

export interface InitInput {
  dir: string;
  name: string;
  goal: string;
  scope: string;
  check: string;
  paths: string[];
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
  branch?: string;
  url?: string;
  head: string;
}

export function renderProjectToml(input: TomlInput): string {
  const paths = input.paths.map(tomlBasicString).join(", ");
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
