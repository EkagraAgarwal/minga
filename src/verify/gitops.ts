/**
 * src/verify/gitops.ts — branch/commit plumbing for accepted submissions.
 *
 * A commit is built in one `git fast-import --quiet --done` process: the
 * submitted files are fed as inline blobs on top of the requested parent, the
 * commit is written to a private temp ref, and `get-mark :1` prints its sha to
 * stdout. A second `git update-ref --stdin` transaction moves the branch with
 * a compare-and-swap and deletes the temp ref in the same process. Neither
 * step touches the maintainer's working tree or the real index.
 *
 * There are no retries: if the branch no longer points at `parent`, the caller
 * gets `{ ok: false, stale: true, head }` and decides whether to recheck.
 * Concurrent calls for the same repository are serialized in-process.
 */
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import type {
  BranchHead,
  ChangedPaths,
  CommitAccepted,
  CommitInput,
  CommitOutcome,
} from "../core/contracts.ts";

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs git without a shell, in `repoDir`. Optional `stdin` is written and closed. */
async function gitRaw(
  repoDir: string,
  args: string[],
  opts: { stdin?: string | Uint8Array } = {},
): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: repoDir,
    stdin: opts.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
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
async function git(repoDir: string, args: string[]): Promise<string> {
  const result = await gitRaw(repoDir, args);
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

/**
 * fast-import paths are literal to end-of-line unless they start with a double
 * quote, in which case they use C-style escapes. Quote anything that could
 * break that: whitespace, non-ASCII bytes, quotes, backslashes, controls.
 */
function fastImportPath(path: string): string {
  let needsQuote = false;
  for (const ch of path) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x20 || code >= 0x7f || ch === '"' || ch === "\\") {
      needsQuote = true;
      break;
    }
  }
  if (!needsQuote) return path;

  let out = '"';
  for (const ch of path) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x5c || code === 0x22) out += `\\${ch}`;
    else if (code === 0x0a) out += "\\n";
    else if (code === 0x0d) out += "\\r";
    else if (code === 0x09) out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += `\\${code.toString(8).padStart(3, "0")}`;
    else out += ch; // raw UTF-8 bytes are fine inside a quoted path
  }
  return `${out}"`;
}

/** git strips these from ident names; do the same so the ident line stays parseable. */
function identName(value: string): string {
  return value.replace(/[<>\r\n]/g, "");
}

/**
 * The whole commit stream, as bytes. `data <n>` counts UTF-8 bytes, and every
 * data block is followed by one LF separator; byte counts never include it.
 * `commit-tree -m` also completes the message with a trailing LF, so the
 * message body here is byte-identical to the old plumbing's output.
 */
function fastImportStream(
  parent: string,
  tmpRef: string,
  author: string,
  email: string,
  message: string,
  files: Record<string, string>,
  nowMs: number,
): Uint8Array {
  const body = message.endsWith("\n") ? message : `${message}\n`;
  const ident = `${identName(author)} <${email}> ${Math.floor(nowMs / 1000)} +0000`;
  const chunks: Uint8Array[] = [];
  const push = (text: string): void => {
    chunks.push(Buffer.from(text, "utf8"));
  };

  push("feature done\nfeature get-mark\n");
  push(`commit ${tmpRef}\nmark :1\n`);
  push(`author ${ident}\ncommitter ${ident}\n`);
  push(`data ${Buffer.byteLength(body, "utf8")}\n`);
  push(body);
  push("\n");
  push(`from ${parent}\n`);

  for (const [path, content] of Object.entries(files)) {
    push(`M 100644 inline ${fastImportPath(path)}\n`);
    push(`data ${Buffer.byteLength(content, "utf8")}\n`);
    push(content);
    push("\n");
  }

  push("get-mark :1\ndone\n");

  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const stream = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    stream.set(chunk, at);
    at += chunk.length;
  }
  return stream;
}

// ----------------------------------------------------------- read-only ops

/** Sha of refs/heads/<branch>. Throws when the branch does not exist. */
export const branchHead: BranchHead = async (repoDir, branch) => {
  const ref = `refs/heads/${branch}`;
  const result = await gitRaw(repoDir, ["rev-parse", "--verify", ref]);
  if (result.code !== 0) throw new Error(`branch ${branch} does not exist in ${repoDir}`);
  return result.stdout.trim();
};

/** Repo-relative paths changed between two commits. */
export const changedPaths: ChangedPaths = async (repoDir, from, to) => {
  const output = await git(repoDir, ["diff", "--name-only", `${from}..${to}`]);
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
};

// ------------------------------------------------------------------- commit

async function commitOnce(input: CommitInput): Promise<CommitOutcome> {
  const ref = `refs/heads/${input.branch}`;
  const tmpRef = `refs/minga/tmp/${randomBytes(8).toString("hex")}`;
  const email = `${slug(input.author)}@minga.invalid`;
  const message = commitMessage(input.message, input.trailers);
  const stream = fastImportStream(
    input.parent, tmpRef, input.author, email, message, input.files, Date.now(),
  );

  const imported = await gitRaw(input.repoDir, ["fast-import", "--quiet", "--done"], { stdin: stream });
  if (imported.code !== 0) {
    await gitRaw(input.repoDir, ["update-ref", "-d", tmpRef]).catch(() => undefined);
    throw new Error(`commitAccepted: git fast-import failed (exit ${imported.code}): ${imported.stderr.trim()}`);
  }
  const sha = imported.stdout.split(/\r?\n/).map((line) => line.trim())
    .find((line) => /^[0-9a-f]{40}$/.test(line));
  if (sha === undefined) {
    await gitRaw(input.repoDir, ["update-ref", "-d", tmpRef]).catch(() => undefined);
    throw new Error(`commitAccepted: fast-import reported no commit: ${imported.stdout.trim()}`);
  }

  // One transaction: move the branch only if it still equals `parent`, and
  // drop the temp ref in the same process. A failed prepare rolls both back.
  const casInput = [
    "start",
    `update ${ref} ${sha} ${input.parent}`,
    `delete ${tmpRef}`,
    "prepare",
    "commit",
    "",
  ].join("\n");
  const cas = await gitRaw(input.repoDir, ["update-ref", "--stdin"], { stdin: casInput });
  if (cas.code === 0) return { ok: true, commit: sha };

  // The transaction rolled back, so the temp ref still exists; remove it.
  await gitRaw(input.repoDir, ["update-ref", "-d", tmpRef]).catch(() => undefined);

  // Compare-and-swap failed: report the branch's current value. An update-ref
  // failure while the ref still equals `parent` is a real error, not staleness.
  const current = await gitRaw(input.repoDir, ["rev-parse", "--verify", ref]);
  const head = current.code === 0 ? current.stdout.trim() : "";
  if (head !== input.parent) return { ok: false, stale: true, head };
  throw new Error(`commitAccepted: could not update ${ref}: ${cas.stderr.trim()}`);
}

export const commitAccepted: CommitAccepted = (input: CommitInput): Promise<CommitOutcome> =>
  withRepoLock(input.repoDir, () => commitOnce(input));
