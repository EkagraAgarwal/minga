/**
 * `minga sync`: refresh the read-only checkout after an accepted submission.
 *
 * A submit leaves the submitted files in the worktree while the server commits
 * them on the branch, so a plain `git pull` can abort on "untracked working
 * tree files would be overwritten". This command compares local changes with
 * the freshly fetched branch head and only discards paths that are byte-identical
 * to it or belong to this agent's last accepted submission.
 *
 * node:child_process and node:fs only: plain Node 20+, no dependencies.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CommandResult } from "./commands.ts";
import { readAgent } from "./store.ts";

/** Runs git in the checkout and returns stdout; throws on a non-zero exit. */
export type GitRunner = (args: string[]) => string;

export interface SyncInput {
  dir: string;
  /** Discard every local change, including files that look unrelated. */
  discard?: boolean;
  /** Injectable for tests; defaults to `git` via execFileSync. */
  runner?: GitRunner;
}

export interface SyncData {
  branch: string;
  changed: string[];
  /** Paths reset or cleaned. */
  discarded: string[];
  /** Paths that would not be discarded without --discard. */
  conflicting: string[];
  synced: boolean;
  /** True when --discard was needed and not given. */
  refused: boolean;
}

interface Change {
  code: string;
  path: string;
}

function firstLine(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.split("\n")[0] ?? text;
}

function parseStatus(text: string): Change[] {
  const changes: Change[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    if (code === "!!") continue;
    let path = line.slice(3);
    if ((code.includes("R") || code.includes("C")) && path.includes(" -> ")) {
      path = path.slice(path.indexOf(" -> ") + 4);
    }
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    if (path.length > 0) changes.push({ code, path });
  }
  return changes;
}

function branchOf(run: GitRunner): string {
  try {
    const ref = run(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]).trim();
    const match = /^refs\/remotes\/origin\/(.+)$/.exec(ref);
    if (match?.[1]) return match[1];
  } catch {
    // Clones without origin/HEAD fall back to main.
  }
  return "main";
}

function headContent(run: GitRunner, branch: string, path: string): string | null {
  try {
    return run(["show", `origin/${branch}:${path}`]);
  } catch {
    return null;
  }
}

function localContent(repoDir: string, path: string): string | null {
  const absolute = resolve(repoDir, path);
  if (!existsSync(absolute)) return null;
  try {
    return readFileSync(absolute, "utf8");
  } catch {
    return null;
  }
}

/** Compare a worktree with origin/<branch> and drop only safe leftovers. */
export function syncCommand(input: SyncInput): CommandResult<SyncData> {
  const repoDir = resolve(input.dir);
  const run: GitRunner = input.runner ?? ((args) => execFileSync("git", args, {
    cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }));

  try {
    run(["fetch", "origin"]);
  } catch (err) {
    throw new Error(`git fetch origin failed: ${firstLine(err)}`);
  }

  const branch = branchOf(run);
  const remote = `origin/${branch}`;
  const changes = parseStatus(run(["status", "--porcelain"]));
  const accepted = readAgent(repoDir)?.lastAccepted?.files ?? [];
  const data: SyncData = {
    branch, changed: changes.map((c) => c.path), discarded: [], conflicting: [],
    synced: false, refused: false,
  };

  if (changes.length === 0) {
    return { text: `already on ${remote}; no local changes to sync`, data };
  }

  for (const change of changes) {
    const inHead = headContent(run, branch, change.path);
    const local = localContent(repoDir, change.path);
    const identical = inHead !== null && local !== null && inHead === local;
    const safe = identical || accepted.includes(change.path);
    if (!safe) data.conflicting.push(change.path);
    if (safe || input.discard === true) data.discarded.push(change.path);
  }

  if (data.conflicting.length > 0 && input.discard !== true) {
    data.refused = true;
    const lines = [
      `refusing to sync: local changes are not this agent's leftovers:`,
      ...data.conflicting.map((path) => `  ${path}`),
      're-run "minga sync --discard" to discard them, or move them aside first',
    ];
    return { text: lines.join("\n"), data };
  }

  if (data.discarded.length > 0) {
    run(["reset", "--hard", remote]);
    run(["clean", "-fd", "--", ...data.discarded]);
  }
  data.synced = true;
  const discarded = data.discarded.join(", ");
  const text = `synced to ${remote}; discarded ${data.discarded.length} path(s): ${discarded}`;
  return { text: input.discard === true && data.conflicting.length > 0 ? `${text} (--discard)` : text, data };
}
