/**
 * src/verify/runner.ts — runs the project's check command against a submission.
 *
 * The maintainer's repository (`repoDir`) is never touched: the branch is
 * checked out into a throwaway `git worktree` under the OS temp directory, the
 * submitted files are written there, and the command runs with that worktree as
 * its cwd. The worktree is always removed again (even on errors and timeouts).
 *
 * The command runs through Bun Shell (`bun exec "<command>"`) so quoting and
 * builtins behave the same on every OS. `{files}` is replaced with the
 * submitted repo-relative paths, each single-quoted POSIX-style.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CheckInput, CheckResult, RunCheck } from "../core/contracts.ts";

const DEFAULT_MAX_OUTPUT = 8000;

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
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

async function git(repoDir: string, args: string[]): Promise<GitResult> {
  const proc = Bun.spawn(["git", "-C", repoDir, ...args], {
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

/**
 * Best-effort teardown: `git worktree remove --force`, fall back to deleting the
 * directory, then prune the now-dangling worktree metadata. Never throws.
 */
async function removeWorktree(repoDir: string, worktree: string): Promise<void> {
  try {
    await git(repoDir, ["worktree", "remove", "--force", worktree]);
  } catch {
    // fall through to the rm fallback
  }
  await removeDir(worktree);
  try {
    await git(repoDir, ["worktree", "prune"]);
  } catch {
    // best effort only
  }
}

export const runCheck: RunCheck = async (input: CheckInput): Promise<CheckResult> => {
  const maxOutput = Math.max(0, input.maxOutput ?? DEFAULT_MAX_OUTPUT);
  const paths = Object.keys(input.files);
  const worktree = await mkdtemp(join(tmpdir(), "minga-check-"));

  try {
    const add = await git(input.repoDir, ["worktree", "add", "--detach", worktree, input.branch]);
    if (add.code !== 0) {
      throw new Error(
        `git worktree add failed for branch ${input.branch} (exit ${add.code}): ${(add.stderr || add.stdout).trim()}`,
      );
    }

    for (const relPath of paths) {
      const target = join(worktree, ...relPath.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, input.files[relPath] ?? "", "utf8");
    }

    const filesArg = paths.map(shellQuote).join(" ");
    const finalCommand = input.command.replaceAll("{files}", () => filesArg);

    const started = performance.now();
    const proc = Bun.spawn([process.execPath, "exec", finalCommand], {
      cwd: worktree,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: processEnv({ MINGA_FILES: paths.join(" ") }),
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
          try {
            proc.kill("SIGKILL");
          } catch {
            // already gone
          }
          resolveExit();
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
  } finally {
    await removeWorktree(input.repoDir, worktree);
  }
};
