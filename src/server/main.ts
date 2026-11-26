#!/usr/bin/env bun
/**
 * minga serve: run the coordinator for one project repo.
 *
 *   bun src/server/main.ts --repo <dir> [--port 7777] [--host 127.0.0.1] [--db <file>]
 *
 * Serves the live UI at /, the join document at /join, the CLI kit at
 * /kit/minga.mjs and the API under /api.
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { renderJoinDoc } from "../cli/join-doc.ts";
import { openEventStore } from "../log/store.ts";
import { loadProject } from "../project/config.ts";
import { commitAccepted } from "../verify/gitops.ts";
import { runCheck } from "../verify/runner.ts";
import { createApp } from "./app.ts";

const { values } = parseArgs({
  options: {
    repo: { type: "string", default: "." },
    port: { type: "string", default: "7777" },
    host: { type: "string", default: "127.0.0.1" },
    db: { type: "string" },
  },
});

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
if (!LOOPBACK.has(values.host!)) {
  console.warn(
    "minga: WARNING: listening beyond this machine. The check command runs agent-submitted files\n" +
    "  with this user's permissions and no sandbox. Run the server inside a container or VM with\n" +
    "  no secrets before exposing it.",
  );
}

const repoDir = resolve(values.repo!);
const cfg = await loadProject(repoDir);
const dbPath = values.db ? resolve(values.db) : join(repoDir, ".minga", "events.db");
mkdirSync(dirname(dbPath), { recursive: true });
// Keep the server's own files out of the project's git history.
const ignore = join(dirname(dbPath), ".gitignore");
if (dirname(dbPath).startsWith(repoDir) && !existsSync(ignore)) await Bun.write(ignore, "*\n");
const store = openEventStore(dbPath);

const app = createApp({ cfg, store, repoDir, runCheck, commitAccepted });

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
  idleTimeout: 0, // SSE connections and long checks
  async fetch(req) {
    const url = new URL(req.url);
    const origin = req.headers.get("x-forwarded-host") ? `${req.headers.get("x-forwarded-proto") ?? "https"}://${req.headers.get("x-forwarded-host")}` : url.origin;
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return existsSync(uiPath) ? new Response(Bun.file(uiPath), { headers: { "content-type": "text/html; charset=utf-8" } }) : new Response("UI not built", { status: 404 });
    }
    if (req.method === "GET" && url.pathname === "/join") {
      return new Response(renderJoinDoc(app.projectInfo(), origin), { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (req.method === "GET" && url.pathname === "/kit/minga.mjs") {
      return kit ? new Response(kit, { headers: { "content-type": "text/javascript; charset=utf-8" } }) : new Response("kit unavailable", { status: 503 });
    }
    return app.fetch(req);
  },
});

setInterval(() => { try { app.sweep(); } catch (err) { console.error("sweep failed", err); } }, 15_000);

console.log(`minga: ${cfg.name} on http://${server.hostname}:${server.port}`);
console.log(`  head agent ${app.headId} · ${Object.keys(app.state.tasks).length} tasks · log ${dbPath}`);
console.log(`  agents join with: curl -fsSL http://${server.hostname}:${server.port}/kit/minga.mjs -o minga.mjs && node minga.mjs join http://${server.hostname}:${server.port} --model <model> --harness <harness>`);
