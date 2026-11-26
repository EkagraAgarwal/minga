/**
 * `minga check <file...>`: run the project's check command locally, exactly as
 * the server will: `{files}` becomes the quoted file list, MINGA_FILES holds the
 * space-separated paths, and the command runs through `bun exec` (Bun's
 * cross-platform shell, what the server uses). Without Bun it falls back to the
 * system shell. Output is captured, never streamed, so the MCP stdio stream stays
 * clean; the tail is part of the result.
 *
 * node:child_process only: plain Node 20+, no dependencies.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { CommandResult } from "./commands.ts";

export type CheckSpawn = (
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; shell: boolean },
) => { status: number | null; error?: Error; output: string };

export interface CheckInput {
  dir: string;
  /** The project's check command from GET /api/project. */
  command: string;
  files: string[];
  /** Injectable for tests. */
  spawn?: CheckSpawn;
}

export interface CheckData {
  command: string;
  files: string[];
  exitCode: number;
  runner: "bun exec" | "shell";
  /** Last 60 lines of stdout+stderr. */
  outputTail: string;
}

function shellQuote(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

/**
 * The check runs submitted code on the volunteer's machine, so it gets a small
 * allowlisted environment rather than the full process env (which may hold
 * tokens, cloud credentials, SSH agent sockets, ...). A project can ask for
 * extra variables by listing their names in MINGA_CHECK_ENV (comma separated).
 */
const BASE_ENV_NAMES = [
  "PATH", "Path", "PATHEXT", "HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR",
  "SystemRoot", "SYSTEMROOT", "ComSpec", "WINDIR", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
  "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "OS", "USER", "USERNAME", "LOGNAME", "SHELL",
  "LANG", "LC_ALL", "TERM", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "BUN_INSTALL", "CI",
] as const;

export function checkEnv(files: string[]): NodeJS.ProcessEnv {
  const names = [
    ...BASE_ENV_NAMES,
    ...(process.env.MINGA_CHECK_ENV ?? "").split(",").map((name) => name.trim()).filter((name) => name.length > 0),
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  env.MINGA_FILES = files.join(" ");
  return env;
}

const defaultSpawn: CheckSpawn = (cmd, args, opts) => {
  const r = spawnSync(cmd, args, {
    ...opts, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status, ...(r.error ? { error: r.error } : {}), output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

export function checkCommand(input: CheckInput): CommandResult<CheckData> & { code: number } {
  if (input.files.length === 0) throw new Error("check needs the files you will submit, e.g. minga check src/a.ts");
  const cwd = resolve(input.dir);
  const files = input.files.map((f) => f.replaceAll("\\", "/").replace(/^\.\//, ""));
  for (const f of files) if (!existsSync(resolve(cwd, f))) throw new Error(`no such file: ${f}`);
  const command = input.command.replaceAll("{files}", () => files.map(shellQuote).join(" "));
  const env = checkEnv(files);
  const spawn = input.spawn ?? defaultSpawn;

  let runner: CheckData["runner"] = "bun exec";
  let out = spawn("bun", ["exec", command], { cwd, env, shell: false });
  if (out.error !== undefined) {
    // No bun on PATH (or only a shim the OS cannot exec directly): use the system shell.
    runner = "shell";
    out = spawn(command, [], { cwd, env, shell: true });
  }
  const exitCode = out.status ?? 1;
  const outputTail = out.output.split(/\r?\n/).slice(-60).join("\n").trimEnd();
  const verdict = exitCode === 0
    ? "check passed (exit 0): submit these files"
    : `check failed (exit ${exitCode}): fix it before submitting`;
  const text = [`ran: ${command}`, outputTail, verdict].filter((l) => l.length > 0).join("\n");
  return { text, data: { command, files, exitCode, runner, outputTail }, code: exitCode === 0 ? 0 : 2 };
}
