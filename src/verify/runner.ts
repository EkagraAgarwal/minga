/**
 * src/verify/runner.ts — runs the project's check command in a pool of warm
 * git worktrees.
 *
 * The maintainer's repository (`repoDir`) is never modified: its branch is
 * attached to each slot worktree once, at creation time, and every run only
 * touches that slot (`checkout --detach --force <base>`, `clean -ffdx` with
 * `keep` exclusions, then the submitted files). Build caches placed under a
 * `keep` path survive between runs in the same slot. NOTE: those keep paths
 * stay writable for every check, persist across submissions, and can be
 * poisoned by one check for the next one; only trusted build caches belong
 * there.
 *
 * An optional holdout overlay is copied over the submitted files after they
 * are written. Overlay files are never committed: the next run's
 * `checkout --force` resets overlay files that overwrote tracked files and
 * `clean -ffdx` removes the rest.
 *
 * Without a sandbox the command runs through Bun Shell (`bun exec "<command>"`)
 * so quoting and builtins behave the same on Windows and POSIX. With
 * `sandbox.mode === "docker"` it runs in a throwaway container instead: only
 * the slot is mounted at /work, its `.git` is hidden behind a read-only empty
 * mount of the same type, and the container gets neither the host's git
 * metadata nor its environment. `{files}` is replaced with the submitted
 * repo-relative paths, each single-quoted POSIX-style.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";
import type {
  CheckInput,
  CheckPool,
  CheckPoolOptions,
  CheckResult,
  CreateCheckPool,
} from "../core/contracts.ts";
import type { Sandbox } from "../core/types.ts";

const DEFAULT_MAX_OUTPUT = 8000;
const DOCKER_PROBE_MS = 15_000;
const DOCKER_PULL_MS = 300_000;
const DOCKER_REPROBE_MS = 60_000;

type DockerSandbox = Extract<Sandbox, { mode: "docker" }>;

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface KillableProcess {
  readonly pid: number;
  kill(exitCode?: number | NodeJS.Signals): void;
}

/** The part of Bun's Subprocess this module uses (Bun.spawn is overloaded). */
interface SpawnedProcess extends KillableProcess {
  readonly stdout: ReadableStream<Uint8Array> | undefined;
  readonly stderr: ReadableStream<Uint8Array> | undefined;
  readonly exited: Promise<number>;
}

interface ProcessOutput {
  code: number;
  timedOut: boolean;
  stdout: Uint8Array;
  stderr: Uint8Array;
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

/**
 * Environment passed with `docker run -e`: MINGA_FILES, the names explicitly
 * listed in MINGA_CHECK_ENV, and HOME=/tmp. The container has its own PATH and
 * toolchain; the host's PATH/HOME (and every other host variable) stay out.
 */
function dockerEnv(mingaFiles: string): Record<string, string> {
  const env: Record<string, string> = { MINGA_FILES: mingaFiles, HOME: "/tmp" };
  for (const name of (process.env.MINGA_CHECK_ENV ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    if (name === "HOME" || name === "MINGA_FILES") continue;
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
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

/** Single-line, bounded text for a fail-closed reason. */
function oneLine(value: string): string {
  return value.replace(/\s*\r?\n\s*/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, 400);
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

/** Recursively copy an overlay, skipping symlinks so nothing outside it is read. */
async function copyOverlay(from: string, to: string): Promise<void> {
  const entries = await readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) {
      await mkdir(dst, { recursive: true });
      await copyOverlay(src, dst);
    } else if (entry.isFile()) {
      await mkdir(dirname(dst), { recursive: true });
      await copyFile(src, dst);
    }
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

/**
 * Spawn without a shell, drain both pipes, kill the whole process tree on
 * timeout, and call `onTimeout` first (used to remove a timed-out container).
 */
async function runProcess(
  argv: string[],
  timeoutMs: number,
  opts: { cwd?: string; env?: Record<string, string>; onTimeout?: () => void } = {},
): Promise<ProcessOutput> {
  let proc: SpawnedProcess;
  try {
    proc = Bun.spawn(argv, {
      cwd: opts.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      ...(opts.env === undefined ? {} : { env: opts.env }),
      // POSIX: detached makes the child a process-group leader.
      ...(process.platform === "win32" ? {} : { detached: true }),
    }) as SpawnedProcess;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { code: -1, timedOut: false, stdout: new Uint8Array(0), stderr: Buffer.from(message, "utf8") };
  }

  const stdoutPromise = readAll(proc.stdout);
  const stderrPromise = readAll(proc.stderr);
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolveExit) => {
      timer = setTimeout(() => {
        timedOut = true;
        try { opts.onTimeout?.(); } catch { /* cleanup is best effort */ }
        void killProcessTree(proc).then(resolveExit, resolveExit);
      }, Math.max(1, Math.round(timeoutMs)));
      void proc.exited.then(() => resolveExit(), () => resolveExit());
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  const [rawExitCode, stdout, stderr] = await Promise.all([
    proc.exited.catch(() => -1), stdoutPromise, stderrPromise,
  ]);
  return {
    code: Number.isFinite(rawExitCode) ? rawExitCode : -1,
    timedOut,
    stdout,
    stderr,
  };
}

/** Short text form of `runProcess`, for docker probes and cleanup commands. */
async function runCommand(argv: string[], timeoutMs: number): Promise<GitResult> {
  const out = await runProcess(argv, timeoutMs);
  const decoder = new TextDecoder();
  return {
    code: out.code,
    stdout: decoder.decode(out.stdout),
    stderr: decoder.decode(out.stderr),
  };
}

/** Was the slot's `.git` pointer changed by the check? `null` means a directory. */
async function gitPointerChanged(slotPath: string, original: string | null): Promise<boolean> {
  const gitPath = join(slotPath, ".git");
  try {
    const stat = await lstat(gitPath);
    if (original === null) return !stat.isDirectory() || stat.isSymbolicLink();
    if (!stat.isFile() || stat.isSymbolicLink()) return true;
    return (await readFile(gitPath, "utf8")) !== original;
  } catch {
    return true;
  }
}

/** Restore a tampered `.git` pointer so the next host git command is safe. */
async function restoreGitPointer(slotPath: string, original: string | null): Promise<void> {
  const gitPath = join(slotPath, ".git");
  try {
    const stat = await lstat(gitPath);
    const wrongType = original === null
      ? !stat.isDirectory() || stat.isSymbolicLink()
      : !stat.isFile() || stat.isSymbolicLink();
    if (wrongType) await rm(gitPath, { recursive: true, force: true });
    if (original === null) await mkdir(gitPath, { recursive: true });
    else await writeFile(gitPath, original, "utf8");
  } catch {
    // Best effort: the slot is recreated from scratch if it is unusable.
  }
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
  const dir = resolve(opts.dir ?? join(repoDir, ".minga", "worktrees"));
  await mkdir(dir, { recursive: true });

  // Test hook only: not part of the CheckPoolOptions contract.
  const dockerBin = (opts as unknown as { dockerBin?: string }).dockerBin ?? "docker";
  const sandbox = opts.sandbox ?? ({ mode: "none" } as Sandbox);
  const docker: DockerSandbox | null = sandbox.mode === "docker" ? sandbox : null;
  const emptyDir = join(dir, ".empty");
  const emptyFile = join(dir, ".emptyfile");
  if (docker !== null) {
    // Mounted read-only over the slot's /work/.git: an empty directory when
    // .git is a directory, an empty file when .git is a worktree gitdir pointer.
    await mkdir(emptyDir, { recursive: true });
    await writeFile(emptyFile, "", "utf8");
  }

  const headResult = await git(repoDir, ["rev-parse", "--verify", "HEAD"]);
  if (headResult.code !== 0) throw new Error(`cannot create a check pool: ${repoDir} has no HEAD commit`);
  const initial = headResult.stdout.trim();

  const slots: Slot[] = [];
  for (let index = 0; index < opts.size; index++) {
    slots.push(await prepareSlot(repoDir, dir, index, initial));
  }

  // Docker availability is probed once at creation and at most once every
  // 60 s afterwards (so starting Docker later recovers). A failed probe never
  // leads to an unsandboxed run.
  let probeAt = 0;
  let probe: { ok: boolean; reason: string } = { ok: false, reason: "not probed yet" };
  let probing: Promise<{ ok: boolean; reason: string }> | null = null;

  const doProbe = async (): Promise<{ ok: boolean; reason: string }> => {
    const version = await runCommand([dockerBin, "version", "--format", "{{.Server.Version}}"], DOCKER_PROBE_MS);
    if (version.code !== 0) {
      return { ok: false, reason: oneLine(version.stderr || version.stdout || `exit ${version.code}`) };
    }
    const inspect = await runCommand([dockerBin, "image", "inspect", docker!.image], DOCKER_PROBE_MS);
    if (inspect.code !== 0) {
      const pull = await runCommand([dockerBin, "pull", docker!.image], DOCKER_PULL_MS);
      if (pull.code !== 0) {
        return { ok: false, reason: oneLine(pull.stderr || pull.stdout || `exit ${pull.code}`) };
      }
    }
    return { ok: true, reason: "" };
  };

  const ensureProbe = (): Promise<{ ok: boolean; reason: string }> => {
    if (probing !== null) return probing;
    if (probe.ok || Date.now() - probeAt < DOCKER_REPROBE_MS) return Promise.resolve(probe);
    probing = doProbe().then((result) => {
      probe = result;
      probeAt = Date.now();
      return result;
    }).finally(() => {
      probing = null;
    });
    return probing;
  };

  if (docker !== null) await ensureProbe();

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

  const enqueue = (input: CheckInput, resolve: (result: CheckResult) => void, reject: (error: unknown) => void): void => {
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

    if (input.overlayDir !== undefined) {
      await copyOverlay(resolve(input.overlayDir), slot.path);
    }

    const filesArg = paths.map(shellQuote).join(" ");
    const finalCommand = input.command.replaceAll("{files}", () => filesArg);
    const timeoutMs = Math.max(1, Math.round(input.timeoutSeconds * 1000));
    const started = performance.now();

    // A slot worktree's .git is a FILE (a gitdir pointer), otherwise a
    // directory. Remember its exact original state so it can be verified after
    // every run, sandboxed or not.
    const gitPath = join(slot.path, ".git");
    const gitStat = await lstat(gitPath);
    const gitIsFile = !gitStat.isDirectory() && !gitStat.isSymbolicLink();
    const gitOriginal = gitIsFile ? await readFile(gitPath, "utf8") : null;

    let out: ProcessOutput;
    if (docker !== null) {
      // The mount type must match: an empty file over a gitdir pointer file,
      // an empty directory over a .git directory. Mounting it read-only hides
      // git metadata from the check; the main repository's .git is never
      // mounted at all.
      const mountSource = gitIsFile ? emptyFile : emptyDir;
      // On Windows pass the absolute slot path as-is: Docker Desktop accepts
      // e.g. D:\x\y:/work.
      const slotAbs = resolve(slot.path);

      const name = `minga-check-${randomBytes(8).toString("hex")}`;
      const argv = [
        dockerBin, "run", "--rm", "--name", name,
        "--network", docker.network,
        "--memory", docker.memory,
        "--cpus", String(docker.cpus),
        "--pids-limit", String(docker.pids),
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--read-only",
        "--tmpfs", "/tmp:rw,exec,size=512m",
        "-v", `${slotAbs}:/work`,
        "-v", `${mountSource}:/work/.git:ro`,
        "-w", "/work",
      ];
      if (process.platform !== "win32" && typeof process.getuid === "function" && typeof process.getgid === "function") {
        argv.push("--user", `${process.getuid()}:${process.getgid()}`);
      }
      for (const [key, value] of Object.entries(dockerEnv(paths.join(" ")))) {
        argv.push("-e", `${key}=${value}`);
      }
      argv.push(docker.image, "sh", "-c", finalCommand);

      out = await runProcess(argv, timeoutMs, {
        cwd: slot.path,
        onTimeout: () => { void runCommand([dockerBin, "rm", "-f", name], DOCKER_PROBE_MS); },
      });
    } else {
      out = await runProcess([process.execPath, "exec", finalCommand], timeoutMs, {
        cwd: slot.path,
        env: processEnv({ MINGA_FILES: paths.join(" ") }),
      });
    }

    // Even with a read-only mount, verify the pointer on the host before any
    // later checkout/clean can act on it. Hooks/config for worktrees live in
    // the main repo, which is never mounted; this guards the pointer itself.
    if (await gitPointerChanged(slot.path, gitOriginal)) {
      await restoreGitPointer(slot.path, gitOriginal);
      return {
        ok: false,
        exitCode: -1,
        timedOut: out.timedOut,
        outputTail: "the check tampered with .git",
        durationMs: Math.round(performance.now() - started),
      };
    }

    const exitCode = Number.isFinite(out.code) ? out.code : -1;
    const durationMs = Math.round(performance.now() - started);

    const combined = concatBytes(out.stdout, out.stderr);
    const tail = combined.length > maxOutput ? combined.subarray(combined.length - maxOutput) : combined;

    return {
      ok: exitCode === 0 && !out.timedOut,
      exitCode,
      timedOut: out.timedOut,
      outputTail: new TextDecoder().decode(tail),
      durationMs,
    };
  };

  const run = (input: CheckInput): Promise<CheckResult> => new Promise<CheckResult>((resolve, reject) => {
    if (closed) {
      reject(new Error("check pool is closed"));
      return;
    }
    if (docker !== null) {
      void ensureProbe().then((result) => {
        if (!result.ok) {
          resolve({
            ok: false,
            exitCode: -1,
            timedOut: false,
            outputTail: `sandbox: docker is not available on the server (${result.reason}); the check did not run`,
            durationMs: 0,
          });
          return;
        }
        enqueue(input, resolve, reject);
      }, reject);
      return;
    }
    enqueue(input, resolve, reject);
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
