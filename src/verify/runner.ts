/**
 * src/verify/runner.ts — runs the project's check command in a pool of warm
 * git worktrees.
 *
 * The maintainer's repository (`repoDir`) is never modified: its branch is
 * attached to each slot worktree once, at creation time, and every run only
 * touches that slot (`checkout --detach --force <base>`, `clean -ffdx` with
 * `keep` exclusions, then the submitted files). Build caches placed under a
 * `keep` path survive between runs in the same slot.
 *
 * The command runs through Bun Shell (`bun exec "<command>"`) so quoting and
 * builtins behave the same on Windows and POSIX. `{files}` is replaced with the
 * submitted repo-relative paths, each single-quoted POSIX-style.
 */
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";
import type {
  CheckInput,
  CheckPool,
  CheckPoolOptions,
  CheckResult,
  CreateCheckPool,
} from "../core/contracts.ts";

const DEFAULT_MAX_OUTPUT = 8000;

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface KillableProcess {
  readonly pid: number;
  kill(exitCode?: number | NodeJS.Signals): void;
}

/**
 * Variables the check may see. The check runs agent-submitted files and its
 * output is published to everyone, so the server's own secrets (tokens, keys,
 * cloud credentials) must never reach it. Toolchains find themselves via PATH
 * and the home/temp/locale variables below; projects that need more can add
 * names to MINGA_CHECK_ENV (comma-separated) when starting the server.
 */
const CHECK_ENV_ALLOW = [
  "PATH", "Path", "PATHEXT", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC",
  "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "APPDATA", "LOCALAPPDATA",
  "ELAN_HOME", "LAKE_HOME", "CARGO_HOME", "RUSTUP_HOME", "GOPATH", "GOCACHE", "PYTHONPATH", "NODE_PATH", "BUN_INSTALL",
];

/** Allowlisted process env as a plain string map, with `extra` layered on top. */
function processEnv(extra: Record<string, string> = {}): Record<string, string> {
  const allow = new Set([
    ...CHECK_ENV_ALLOW,
    ...(process.env.MINGA_CHECK_ENV ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  ]);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && allow.has(key)) env[key] = value;
  }
  return { ...env, ...extra };
}

/** Runs git in `cwd`, without a shell. */
async function git(cwd: string, args: string[]): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

async function readAll(stream: ReadableStream<Uint8Array> | undefined): Promise<Uint8Array> {
  if (!stream) return new Uint8Array(0);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** POSIX single-quote a path; `'` becomes `'\''` (Bun Shell accepts this form). */
function shellQuote(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

/** Remove a directory, retrying briefly: Windows can keep handles open for a moment. */
async function removeDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/** Same path on both OSes (drive-letter case and separators included). */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => normalize(resolve(p)).toLowerCase();
  return norm(a) === norm(b);
}

/** True when `path` is still a usable git worktree rooted exactly there. */
async function isHealthyWorktree(path: string): Promise<boolean> {
  try {
    if (!existsSync(join(path, ".git"))) return false;
    const result = await git(path, ["rev-parse", "--show-toplevel"]);
    return result.code === 0 && samePath(result.stdout.trim(), path);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------ process trees

/**
 * Windows: taskkill /T walks the whole descendant tree. POSIX: the check is
 * spawned detached so it leads its own process group; killing the negative
 * pid kills the group, including grandchildren. If the group kill fails, fall
 * back to pkill -P applied recursively.
 */
async function killProcessTree(proc: KillableProcess): Promise<void> {
  const pid = proc.pid;
  if (!Number.isFinite(pid) || pid <= 0) {
    try { proc.kill(); } catch { /* already gone */ }
    return;
  }

  if (process.platform === "win32") {
    const killer = Bun.spawn(["taskkill", "/pid", String(pid), "/T", "/F"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    await killer.exited.catch(() => undefined);
    try { proc.kill(); } catch { /* already gone */ }
    return;
  }

  // Only signal a negative pid when the child really is a group leader;
  // otherwise that number could name an unrelated process group.
  const pgid = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
  }).stdout.toString().trim();
  let groupKilled = false;
  if (pgid === String(pid)) {
    try {
      process.kill(-pid, "SIGKILL");
      groupKilled = true;
    } catch {
      // The group vanished between the check and the signal.
    }
  }
  if (!groupKilled) await killPosixTree(pid);
  try { proc.kill("SIGKILL"); } catch { /* already gone */ }
}

/** pkill -P, recursively, with a depth cap and cycle protection. */
async function killPosixTree(pid: number, seen = new Set<number>(), depth = 0): Promise<void> {
  if (depth > 32 || seen.has(pid)) return;
  seen.add(pid);

  const listed = Bun.spawnSync(["pgrep", "-P", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const children = listed.stdout.toString().split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
  for (const child of children) await killPosixTree(child, seen, depth + 1);

  Bun.spawnSync(["pkill", "-P", String(pid)], { stdout: "ignore", stderr: "ignore" });
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

// -------------------------------------------------------------------- pool

interface Slot {
  path: string;
  busy: boolean;
}

interface Waiter {
  grant(slot: Slot): void;
  reject(error: unknown): void;
}

/** Reuse a healthy worktree, otherwise prune stale metadata and re-add it. */
async function prepareSlot(repoDir: string, dir: string, index: number, base: string): Promise<Slot> {
  const path = join(dir, String(index));
  if (!(await isHealthyWorktree(path))) {
    await git(repoDir, ["worktree", "prune"]);
    if (existsSync(path)) await removeDir(path);
    await mkdir(dirname(path), { recursive: true });
    const add = await git(repoDir, ["worktree", "add", "--detach", "--force", path, base]);
    if (add.code !== 0) {
      throw new Error(
        `git worktree add failed for slot ${index} (exit ${add.code}): ${(add.stderr || add.stdout).trim()}`,
      );
    }
  }
  return { path, busy: false };
}

export const createCheckPool: CreateCheckPool = async (opts: CheckPoolOptions): Promise<CheckPool> => {
  if (!Number.isInteger(opts.size) || opts.size < 1) throw new Error("check pool size must be an integer >= 1");

  const repoDir = resolve(opts.repoDir);
  const dir = opts.dir ?? join(repoDir, ".minga", "worktrees");
  await mkdir(resolve(dir), { recursive: true });

  const headResult = await git(repoDir, ["rev-parse", "--verify", "HEAD"]);
  if (headResult.code !== 0) throw new Error(`cannot create a check pool: ${repoDir} has no HEAD commit`);
  const initial = headResult.stdout.trim();

  const slots: Slot[] = [];
  for (let index = 0; index < opts.size; index++) {
    slots.push(await prepareSlot(repoDir, resolve(dir), index, initial));
  }

  const queue: Waiter[] = [];
  const active = new Set<Promise<void>>();
  let busyCount = 0;
  let closed = false;

  /** Grants free slots to waiters in arrival (FIFO) order. */
  const dispatch = (): void => {
    while (queue.length > 0) {
      const slot = slots.find((candidate) => !candidate.busy);
      if (!slot) return;
      const waiter = queue.shift()!;
      slot.busy = true;
      busyCount++;
      waiter.grant(slot);
    }
  };

  const execute = async (slot: Slot, input: CheckInput): Promise<CheckResult> => {
    const maxOutput = Math.max(0, input.maxOutput ?? DEFAULT_MAX_OUTPUT);
    const paths = Object.keys(input.files);

    const checkout = await git(slot.path, ["checkout", "--detach", "--force", input.base]);
    if (checkout.code !== 0) {
      throw new Error(`git checkout ${input.base} failed in ${slot.path}: ${(checkout.stderr || checkout.stdout).trim()}`);
    }

    const cleanArgs = ["clean", "-ffdx"];
    for (const keep of opts.keep) cleanArgs.push("-e", keep);
    const clean = await git(slot.path, cleanArgs);
    if (clean.code !== 0) {
      throw new Error(`git clean failed in ${slot.path}: ${(clean.stderr || clean.stdout).trim()}`);
    }

    for (const relPath of paths) {
      const target = join(slot.path, ...relPath.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, input.files[relPath] ?? "", "utf8");
    }

    const filesArg = paths.map(shellQuote).join(" ");
    const finalCommand = input.command.replaceAll("{files}", () => filesArg);

    const started = performance.now();
    const proc = Bun.spawn([process.execPath, "exec", finalCommand], {
      cwd: slot.path,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: processEnv({ MINGA_FILES: paths.join(" ") }),
      // POSIX: setsid() makes the child its own process-group leader, so a
      // single negative-pid kill reaches grandchildren too.
      ...(process.platform === "win32" ? {} : { detached: true }),
    });

    // Drain the pipes immediately so the child can never block on a full buffer.
    const stdoutPromise = readAll(proc.stdout);
    const stderrPromise = readAll(proc.stderr);

    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolveExit) => {
        timer = setTimeout(() => {
          timedOut = true;
          // Kill first, then release the wait: descendants must be gone when
          // the result is reported.
          void killProcessTree(proc).then(resolveExit, resolveExit);
        }, Math.max(1, Math.round(input.timeoutSeconds * 1000)));
        void proc.exited.then(() => resolveExit());
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    const [rawExitCode, stdout, stderr] = await Promise.all([proc.exited, stdoutPromise, stderrPromise]);
    const exitCode = Number.isFinite(rawExitCode) ? rawExitCode : -1;
    const durationMs = Math.round(performance.now() - started);

    const combined = concatBytes(stdout, stderr);
    const tail = combined.length > maxOutput ? combined.subarray(combined.length - maxOutput) : combined;

    return {
      ok: exitCode === 0 && !timedOut,
      exitCode,
      timedOut,
      outputTail: new TextDecoder().decode(tail),
      durationMs,
    };
  };

  const run = (input: CheckInput): Promise<CheckResult> => new Promise<CheckResult>((resolve, reject) => {
    if (closed) {
      reject(new Error("check pool is closed"));
      return;
    }
    queue.push({
      reject,
      grant(slot) {
        const work = execute(slot, input)
          .then(resolve, reject)
          .finally(() => {
            slot.busy = false;
            busyCount--;
            active.delete(work);
            dispatch();
          });
        active.add(work);
      },
    });
    dispatch();
  });

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    for (const waiter of queue.splice(0)) waiter.reject(new Error("check pool is closed"));
    await Promise.allSettled([...active]);

    for (const slot of slots) {
      const removed = await git(repoDir, ["worktree", "remove", "--force", slot.path]);
      if (removed.code !== 0) await removeDir(slot.path);
    }
    await git(repoDir, ["worktree", "prune"]);
  };

  return {
    run,
    size: opts.size,
    get busy(): number { return busyCount; },
    close,
  };
};
