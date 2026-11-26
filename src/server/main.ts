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

const { values } = parseArgs({
  options: {
    repo: { type: "string", default: "." },
    port: { type: "string", default: "7777" },
    host: { type: "string", default: "127.0.0.1" },
    db: { type: "string" },
    "check-concurrency": { type: "string" },
    "join-limit": { type: "string", default: "20" },
    "dry-run": { type: "boolean", default: false },
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
  die(`branch ${cfg.branch} does not exist in ${repoDir}`, `commit something on ${cfg.branch}, or set branch = "..." in project.toml`);
}
const concurrency = values["check-concurrency"] !== undefined
  ? Math.max(1, Number(values["check-concurrency"]) || 1)
  : cfg.checkConcurrency > 0 ? cfg.checkConcurrency : Math.max(1, availableParallelism() - 1);

if (values["dry-run"]) {
  console.log(JSON.stringify({
    ok: true,
    project: { name: cfg.name, check: cfg.check, paths: cfg.paths, branch: cfg.branch, head, recheck: cfg.recheck, checkKeep: cfg.checkKeep },
    checkConcurrency: concurrency,
    seedTasks: cfg.seedTasks.length,
  }, null, 2));
  process.exit(0);
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
if (!LOOPBACK.has(values.host!)) {
  console.warn(
    "minga: WARNING: listening beyond this machine. The check command runs agent-submitted files\n" +
    "  with this user's permissions and no sandbox. Run the server inside a container or VM with\n" +
    "  no secrets before exposing it.",
  );
}

const stateDir = join(repoDir, ".minga");
mkdirSync(stateDir, { recursive: true });
// Keep the server's own files out of the project's git history.
if (!existsSync(join(stateDir, ".gitignore"))) await Bun.write(join(stateDir, ".gitignore"), "*\n");
const dbPath = values.db ? resolve(values.db) : join(stateDir, "events.db");
mkdirSync(dirname(dbPath), { recursive: true });
const store = openEventStore(dbPath);
const pool = await createCheckPool({ repoDir, size: concurrency, keep: cfg.checkKeep });

const app = createApp({
  cfg, store, repoDir, pool, commitAccepted, branchHead, changedPaths,
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
