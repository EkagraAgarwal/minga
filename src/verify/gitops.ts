/**
 * src/verify/gitops.ts — commits accepted submissions with plumbing only.
 *
 * Nothing here touches the maintainer's working tree or real index: a private
 * temp index is seeded from the branch head with `read-tree`, the submitted
 * blobs are written with `hash-object`, the tree with `write-tree`, the commit
 * with `commit-tree`, and the branch is moved with a compare-and-swap
 * `update-ref <new> <old>`. If the branch moved in the meantime the whole
 * sequence is retried a few times. Concurrent calls for the same repository are
 * serialized in-process.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CommitAccepted, CommitInput } from "../core/contracts.ts";

const CAS_ATTEMPTS = 3;

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Process env as a plain string map, with `extra` layered on top. */
function processEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

/** Runs git without a shell, in `repoDir`. Optional `stdin` is written and closed. */
async function gitRaw(
  repoDir: string,
  args: string[],
  opts: { env?: Record<string, string>; stdin?: string } = {},
): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: repoDir,
    stdin: opts.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    ...(opts.env === undefined ? {} : { env: opts.env }),
  });

  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  const sink = proc.stdin;
  if (opts.stdin !== undefined) {
    if (!sink) throw new Error(`git ${args.join(" ")}: stdin pipe unavailable`);
    await sink.write(opts.stdin);
    await sink.end();
  }

  const [stdout, stderr, code] = await Promise.all([stdoutPromise, stderrPromise, proc.exited]);
  return { code, stdout, stderr };
}

/** Same as `gitRaw` but throws an Error carrying stderr on a non-zero exit. */
async function git(
  repoDir: string,
  args: string[],
  opts: { env?: Record<string, string>; stdin?: string } = {},
): Promise<string> {
  const result = await gitRaw(repoDir, args, opts);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${result.code}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

// ------------------------------------------------------------------- locking

const repoLocks = new Map<string, Promise<void>>();

/** Serializes async work per resolved repository path (an in-process mutex). */
function withRepoLock<T>(repoDir: string, work: () => Promise<T>): Promise<T> {
  const key = resolve(repoDir);
  const previous = repoLocks.get(key) ?? Promise.resolve();
  const result = previous.then(work, work);
  const tail: Promise<void> = result.then(
    () => undefined,
    () => undefined,
  );
  repoLocks.set(key, tail);
  void tail.then(() => {
    if (repoLocks.get(key) === tail) repoLocks.delete(key);
  });
  return result;
}

// ------------------------------------------------------------------- helpers

/** Lowercase ASCII slug suitable for an email local part. */
function slug(value: string): string {
  const out = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return out.length > 0 ? out : "agent";
}

function commitMessage(message: string, trailers: Record<string, string>): string {
  const lines = Object.entries(trailers).map(([key, value]) => `${key}: ${value}`);
  if (lines.length === 0) return message;
  return `${message}\n\n${lines.join("\n")}`;
}

// ------------------------------------------------------------------- commit

async function commitOnce(input: CommitInput): Promise<string> {
  const ref = `refs/heads/${input.branch}`;
  const email = `${slug(input.author)}@minga.invalid`;
  const message = commitMessage(input.message, input.trailers);
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= CAS_ATTEMPTS; attempt++) {
    const old = (await git(input.repoDir, ["rev-parse", "--verify", ref])).trim();

    const indexDir = await mkdtemp(join(tmpdir(), "minga-index-"));
    const indexFile = join(indexDir, "index").replaceAll("\\", "/");
    const env = processEnv({
      GIT_INDEX_FILE: indexFile,
      GIT_AUTHOR_NAME: input.author,
      GIT_COMMITTER_NAME: input.author,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_EMAIL: email,
    });

    try {
      await git(input.repoDir, ["read-tree", old], { env });

      for (const [path, content] of Object.entries(input.files)) {
        const blob = (
          await git(input.repoDir, ["hash-object", "-w", "--stdin"], { env, stdin: content })
        ).trim();
        await git(input.repoDir, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], { env });
      }

      const tree = (await git(input.repoDir, ["write-tree"], { env })).trim();
      const commit = (
        await git(input.repoDir, ["commit-tree", tree, "-p", old, "-m", message], { env })
      ).trim();

      const cas = await gitRaw(input.repoDir, ["update-ref", ref, commit, old]);
      if (cas.code === 0) return commit;

      lastError = new Error(`branch ${input.branch} moved during commit: ${cas.stderr.trim()}`);
    } finally {
      await rm(indexDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  throw new Error(
    `commitAccepted: ${ref} kept moving after ${CAS_ATTEMPTS} attempts` +
      (lastError ? `: ${lastError.message}` : ""),
  );
}

export const commitAccepted: CommitAccepted = (input: CommitInput): Promise<string> =>
  withRepoLock(input.repoDir, () => commitOnce(input));
