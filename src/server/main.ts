#!/usr/bin/env bun
/**
 * minga serve: run the coordinator for one project repo.
 *
 *   bun src/server/main.ts --repo <dir> [--port 7777] [--host 127.0.0.1] [--db <file>]
 *                          [--check-concurrency N] [--join-limit N] [--dry-run]
 *
 * Serves the live UI at /, the join document at /join (and /llms.txt), the CLI kit at
 * /kit/minga.mjs and the API under /api. --dry-run validates the project and prints JSON.
 */
import { existsSync, mkdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { renderJoinDoc } from "../cli/join-doc.ts";
import { openEventStore } from "../log/store.ts";
import { loadProject } from "../project/config.ts";
import { branchHead, changedPaths, commitAccepted } from "../verify/gitops.ts";
import { createCheckPool } from "../verify/runner.ts";
import { createApp } from "./app.ts";
import { isGitRequest, serveGit } from "./git-http.ts";

const { values } = parseArgs({
  options: {
    repo: { type: "string", default: "." },
    port: { type: "string", default: "7777" },
    host: { type: "string", default: "127.0.0.1" },
    db: { type: "string" },
    "check-concurrency": { type: "string" },
    "join-limit": { type: "string", default: "20" },
    "dry-run": { type: "boolean", default: false },
    "allow-checked-out": { type: "boolean", default: false },
  },
});

const repoDir = resolve(values.repo!);

function die(message: string, fix?: string): never {
  if (values["dry-run"]) {
    console.log(JSON.stringify({ ok: false, error: message, ...(fix ? { fix } : {}) }, null, 2));
  } else {
    console.error(`minga: ${message}${fix ? `\n  fix: ${fix}` : ""}`);
  }
  process.exit(1);
}

if (!existsSync(join(repoDir, ".git"))) die(`${repoDir} is not a git repository`, "run git init there, commit, then try again");
let cfg;
try {
  cfg = await loadProject(repoDir);
} catch (err) {
  die((err as Error).message, existsSync(join(repoDir, "project.toml")) ? "fix project.toml" : "create one with: minga init");
}
let head: string;
try {
  head = await branchHead(repoDir, cfg.branch);
} catch {
  // A missing project branch starts at the current commit (init picks a dedicated "minga" branch).
  const start = Bun.spawnSync(["git", "-C", repoDir, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const startSha = start.stdout.toString().trim();
  if (start.exitCode !== 0 || startSha === "") {
    die(`branch ${cfg.branch} does not exist in ${repoDir} and there is no commit to start it from`, "commit something first");
  }
  if (!values["dry-run"]) {
    const made = Bun.spawnSync(["git", "-C", repoDir, "update-ref", `refs/heads/${cfg.branch}`, startSha, ""]);
    if (made.exitCode !== 0) die(`cannot create branch ${cfg.branch}: ${made.stderr.toString().trim()}`);
    console.log(`minga: created branch ${cfg.branch} at ${startSha.slice(0, 12)}; accepted work lands there (merge it whenever you like)`);
  }
  head = startSha;
}

// Accepted commits move the branch ref directly. If that branch is checked out, the
// working tree and index fall behind it and the next "git commit -a" there silently
// reverts the agents' work, so refuse unless told otherwise.
const checkedOut = checkedOutIn(repoDir, cfg.branch);
if (checkedOut !== null && !values["allow-checked-out"]) {
  die(
    `branch ${cfg.branch} is checked out in ${checkedOut}; accepted commits would move it under that working tree`,
    `set branch = "minga" in project.toml (serve creates it), check out another branch there, or pass --allow-checked-out`,
  );
}
// Holdout tests must stay private: refuse a holdout directory git tracks (it would be served
// to every volunteer in repo.git), and one that does not exist.
if (cfg.holdout) {
  const dir = resolve(repoDir, cfg.holdout.dir);
  if (!existsSync(dir)) die(`holdout dir ${dir} does not exist`, "create it and put the private tests there, or remove [holdout]");
  const tracked = Bun.spawnSync(["git", "-C", repoDir, "ls-files", "--", dir]);
  if (tracked.exitCode === 0 && tracked.stdout.toString().trim() !== "") {
    die(`holdout dir ${cfg.holdout.dir} is tracked by git, so volunteers can read it`, `move it under .minga/ (git-ignored), or git rm -r --cached ${cfg.holdout.dir}`);
  }
  const onBranch = Bun.spawnSync(["git", "-C", repoDir, "ls-tree", "-r", "--name-only", cfg.branch, "--", dir]);
  if (onBranch.exitCode === 0 && onBranch.stdout.toString().trim() !== "") {
    die(`holdout files are committed on branch ${cfg.branch}, so volunteers can read them`, "remove them from that branch's history first");
  }
}

const concurrency = values["check-concurrency"] !== undefined
  ? Math.max(1, Number(values["check-concurrency"]) || 1)
  : cfg.checkConcurrency > 0 ? cfg.checkConcurrency : Math.max(1, availableParallelism() - 1);

if (values["dry-run"]) {
  console.log(JSON.stringify({
    ok: true,
    project: { name: cfg.name, check: cfg.check, paths: cfg.paths, branch: cfg.branch, head, recheck: cfg.recheck, checkKeep: cfg.checkKeep },
    safety: { protect: cfg.protect, gates: cfg.gates, review: cfg.review, holdout: cfg.holdout ?? null, sandbox: cfg.sandbox },
    checkConcurrency: concurrency,
    seedTasks: cfg.seedTasks.length,
  }, null, 2));
  process.exit(0);
}

/** The worktree path that has `branch` checked out, or null. Check-pool worktrees are detached. */
function checkedOutIn(repo: string, branch: string): string | null {
  const list = Bun.spawnSync(["git", "-C", repo, "worktree", "list", "--porcelain"]);
  if (list.exitCode !== 0) return null;
  let path: string | null = null;
  for (const line of list.stdout.toString().split(/\r?\n/)) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}` && path !== null) return path;
  }
  return null;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
if (!LOOPBACK.has(values.host!) && cfg.sandbox.mode === "none") {
  console.warn(
    "minga: WARNING: listening beyond this machine. The check command runs agent-submitted files\n" +
    "  with this user's permissions and no sandbox. Set [sandbox] mode = \"docker\" in project.toml,\n" +
    "  or run the server inside a container or VM with no secrets, before exposing it.",
  );
}
if (cfg.holdout && cfg.sandbox.mode === "none") {
  console.warn("minga: WARNING: [holdout] without [sandbox]: checked code runs on this machine and can read the holdout files. Use mode = \"docker\" to keep them private.");
}
if (cfg.review.mode === "none") {
  console.log("minga: review = \"none\": work that passes the check lands at once. Set review = \"head\" to approve each change first.");
}

const stateDir = join(repoDir, ".minga");
mkdirSync(stateDir, { recursive: true });
// Keep the server's own files out of the project's git history.
if (!existsSync(join(stateDir, ".gitignore"))) await Bun.write(join(stateDir, ".gitignore"), "*\n");
const dbPath = values.db ? resolve(values.db) : join(stateDir, "events.db");
mkdirSync(dirname(dbPath), { recursive: true });
const store = openEventStore(dbPath);
const pool = await createCheckPool({ repoDir, size: concurrency, keep: cfg.checkKeep, sandbox: cfg.sandbox });

const app = createApp({
  cfg, store, repoDir, pool, commitAccepted, branchHead, changedPaths, initialHead: head,
  joinLimitPerHour: Math.max(0, Number(values["join-limit"]) || 0),
});

const here = import.meta.dir;
const uiPath = join(here, "..", "ui", "index.html");
const kitDist = join(here, "..", "..", "dist", "minga.mjs");

/** Bundles the CLI kit once, so volunteers can fetch a single file. */
async function kitFile(): Promise<Blob | null> {
  if (existsSync(kitDist)) return Bun.file(kitDist);
  const built = await Bun.build({ entrypoints: [join(here, "..", "cli", "main.ts")], target: "node" });
  if (!built.success || !built.outputs[0]) { console.error(built.logs); return null; }
  return built.outputs[0];
}
const kit = await kitFile();

const server = Bun.serve({
  hostname: values.host,
  port: Number(values.port),
  // Long-polls hold requests up to 30 s; SSE sends a ping every 20 s.
  idleTimeout: 120,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const origin = req.headers.get("x-forwarded-host") ? `${req.headers.get("x-forwarded-proto") ?? "https"}://${req.headers.get("x-forwarded-host")}` : url.origin;
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return existsSync(uiPath) ? new Response(Bun.file(uiPath), { headers: { "content-type": "text/html; charset=utf-8" } }) : new Response("UI not built", { status: 404 });
    }
    if (req.method === "GET" && (url.pathname === "/join" || url.pathname === "/llms.txt")) {
      return new Response(renderJoinDoc(app.projectInfo(), origin), { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (isGitRequest(url.pathname)) return serveGit(req, repoDir);
    if (req.method === "GET" && url.pathname === "/kit/minga.mjs") {
      return kit ? new Response(kit, { headers: { "content-type": "text/javascript; charset=utf-8" } }) : new Response("kit unavailable", { status: 503 });
    }
    return app.fetch(req, srv.requestIP(req)?.address);
  },
});

setInterval(() => { try { app.sweep(); } catch (err) { console.error("sweep failed", err); } }, 15_000);

const base = `http://${server.hostname}:${server.port}`;
console.log(`minga: ${cfg.name} on ${base}`);
console.log(`  head agent ${app.headId} · ${Object.keys(app.state.tasks).length} tasks · ${concurrency} check slot(s) · log ${dbPath}`);
console.log(`  agents join with: npx -y minga-swarm@latest join ${base} --model <model> --harness <harness>`);
console.log(`  or read ${base}/join`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.stop();
    store.close();
    process.exit(0);
  });
}
