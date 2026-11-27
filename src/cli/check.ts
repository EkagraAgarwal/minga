/**
 * `minga check <file...>`: run the project's check command locally, exactly as
 * the server will: `{files}` becomes the quoted file list, MINGA_FILES holds the
 * space-separated paths, and the command runs through `bun exec` (Bun's
 * cross-platform shell, what the server uses). Without Bun it falls back to the
 * system shell. Output is captured, never streamed, so the MCP stdio stream stays
 * clean; the tail is part of the result.
 *
 * With `--sandbox docker` the command runs in a throwaway container instead:
 * only the checkout is mounted at /work, its .git and .minga are hidden behind
 * read-only empty mounts, the network is off by default, and Docker is required
 * (a missing daemon never falls back to an unsandboxed run). This mirrors
 * src/verify/runner.ts on the server.
 *
 * node:child_process / node:fs only: plain Node 20+, no dependencies.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CommandResult } from "./commands.ts";

export type CheckSpawn = (
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; shell: boolean; timeout?: number },
) => { status: number | null; error?: Error; output: string; timedOut?: boolean };

export interface CheckInput {
  dir: string;
  /** The project's check command from GET /api/project. */
  command: string;
  files: string[];
  /** Injectable for tests. */
  spawn?: CheckSpawn;
  sandbox?: "docker";
  image?: string;
  network?: "none" | "bridge";
  /** Test hook: path to the docker binary (or MINGA_DOCKER_BIN). */
  dockerBin?: string;
  /** Container wall-clock limit; the container is removed when it expires. */
  timeoutMs?: number;
}

export interface CheckData {
  command: string;
  files: string[];
  exitCode: number;
  runner: "bun exec" | "shell" | "docker";
  /** Last 60 lines of stdout+stderr. */
  outputTail: string;
  sandbox?: "docker";
  image?: string;
  container?: string;
}

export const DEFAULT_CHECK_IMAGE = "oven/bun:1";
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

function shellQuote(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

function oneLine(value: string): string {
  return value.replace(/\s*\r?\n\s*/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, 300);
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

const extraEnvNames = (): string[] =>
  (process.env.MINGA_CHECK_ENV ?? "").split(",").map((name) => name.trim()).filter((name) => name.length > 0);

export function checkEnv(files: string[]): NodeJS.ProcessEnv {
  const names = [...BASE_ENV_NAMES, ...extraEnvNames()];
  const env: NodeJS.ProcessEnv = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  env.MINGA_FILES = files.join(" ");
  return env;
}

/** Container environment: never the host's PATH, HOME or other variables. */
function dockerEnv(files: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { MINGA_FILES: files.join(" "), HOME: "/tmp" };
  for (const name of extraEnvNames()) {
    if (name === "HOME" || name === "MINGA_FILES") continue;
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

const defaultSpawn: CheckSpawn = (cmd, args, opts) => {
  const r = spawnSync(cmd, args, {
    ...opts, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: r.status,
    ...(r.error ? { error: r.error } : {}),
    output: `${r.stdout ?? ""}${r.stderr ?? ""}`,
    timedOut: (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || r.signal === "SIGTERM",
  };
};

function dockerResult(
  input: CheckInput, command: string, files: string[], cwd: string, spawn: CheckSpawn,
  sandbox: "docker", image: string, network: "none" | "bridge", timeoutMs: number,
): CommandResult<CheckData> & { code: number } {
  const dockerBin = input.dockerBin ?? process.env.MINGA_DOCKER_BIN ?? "docker";
  const mounts = mkdtempSync(`${tmpdir()}/minga-vcheck-`);
  const name = `minga-vcheck-${randomBytes(8).toString("hex")}`;
  let gitMount = "";
  try {
    // A worktree's .git is a FILE (gitdir pointer), a clone's is a DIRECTORY;
    // the hiding mount must have the same type.
    const gitPath = resolve(cwd, ".git");
    let gitIsFile = false;
    try { gitIsFile = lstatSync(gitPath).isFile(); } catch { /* no .git: use a directory */ }
    gitMount = join(mounts, gitIsFile ? "gitfile" : "gitdir");
    if (gitIsFile) writeFileSync(gitMount, "");
    else mkdirSync(gitMount);
    const mingaMount = join(mounts, "minga");
    mkdirSync(mingaMount);

    const argv = [
      "run", "--rm", "--name", name,
      "--network", network,
      "--memory", "2g", "--cpus", "2", "--pids-limit", "512",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only",
      "--tmpfs", "/tmp:rw,exec,size=512m",
      "-v", `${cwd}:/work`,
      "-v", `${gitMount}:/work/.git:ro`,
      "-v", `${mingaMount}:/work/.minga:ro`,
      "-w", "/work",
    ];
    for (const [key, value] of Object.entries(dockerEnv(files))) {
      argv.push("-e", `${key}=${value}`);
    }
    if (process.platform !== "win32" && typeof process.getuid === "function" && typeof process.getgid === "function") {
      argv.push("--user", `${process.getuid()}:${process.getgid()}`);
    }
    argv.push(image, "sh", "-c", command);

    // The docker CLI itself needs the host env (PATH, its config and context); the
    // container gets only the -e variables above.
    const out = spawn(dockerBin, argv, { cwd, env: process.env, shell: false, timeout: timeoutMs });
    const timedOut = out.timedOut === true || /ETIMEDOUT|timed out/i.test(out.error?.message ?? "");
    if (timedOut) {
      try {
        spawn(dockerBin, ["rm", "-f", name], { cwd, env: process.env, shell: false, timeout: 15_000 });
      } catch { /* best effort cleanup */ }
      throw new Error(
        `check timed out after ${Math.round(timeoutMs / 1000)}s in ${name}; the container was removed` +
        "\nnext: fix the check or raise its limit, then re-run minga check",
      );
    }
    if (out.error !== undefined || out.status === null) {
      const reason = oneLine(out.error?.message ?? out.output) || `exit ${out.status}`;
      throw new Error(
        `docker is not available: ${reason}; the check did not run unsandboxed` +
        "\nnext: install Docker (or start Docker Desktop), then re-run minga check --sandbox docker",
      );
    }
    const exitCode = out.status ?? 1;
    const outputTail = out.output.split(/\r?\n/).slice(-60).join("\n").trimEnd();
    const imageNote = input.image === undefined && process.env.MINGA_SANDBOX_IMAGE === undefined
      ? `using ${DEFAULT_CHECK_IMAGE} (the project's sandbox image is not published by the protocol; pass --image to override)`
      : `image ${image}`;
    const text = [
      `sandbox: docker, network ${network}, ${imageNote}, container ${name}`,
      outputTail,
      exitCode === 0
        ? "check passed (exit 0): submit these files"
        : `check failed (exit ${exitCode}): fix it before submitting`,
    ].filter((line) => line.length > 0).join("\n");
    return {
      text,
      data: { command, files, exitCode, runner: "docker", outputTail, sandbox, image, container: name },
      code: exitCode === 0 ? 0 : 2,
    };
  } finally {
    try { rmSync(mounts, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

export function checkCommand(input: CheckInput): CommandResult<CheckData> & { code: number } {
  if (input.files.length === 0) throw new Error("check needs the files you will submit, e.g. minga check src/a.ts");
  const cwd = resolve(input.dir);
  const files = input.files.map((f) => f.replaceAll("\\", "/").replace(/^\.\//, ""));
  for (const f of files) if (!existsSync(resolve(cwd, f))) throw new Error(`no such file: ${f}`);
  const command = input.command.replaceAll("{files}", () => files.map(shellQuote).join(" "));
  const spawn = input.spawn ?? defaultSpawn;

  const sandbox = input.sandbox ?? (process.env.MINGA_SANDBOX === "docker" ? "docker" : undefined);
  if (sandbox === "docker") {
    const network = input.network ?? "none";
    if (network !== "none" && network !== "bridge") throw new Error(`--network must be none or bridge, got "${network}"`);
    const image = input.image ?? process.env.MINGA_SANDBOX_IMAGE ?? DEFAULT_CHECK_IMAGE;
    return dockerResult(
      input, command, files, cwd, spawn, "docker", image, network, Math.max(1, input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    );
  }
  if (sandbox !== undefined) throw new Error(`unknown sandbox: ${sandbox} (use --sandbox docker)`);

  const env = checkEnv(files);
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
  const text = [`ran: ${command}`, outputTail, verdict].filter((line) => line.length > 0).join("\n");
  return { text, data: { command, files, exitCode, runner, outputTail }, code: exitCode === 0 ? 0 : 2 };
}
