import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isGitRequest, serveGit } from "../src/server/git-http.ts";

// Async: the server under test runs in this process, so a blocking spawn would deadlock.
const gitAsync = async (cwd: string, ...args: string[]) => {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
};
const git = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};

let repo = "";
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "minga-git-http-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@minga.invalid");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "check.ts"), "process.exit(0)\n");
  writeFileSync(join(repo, ".gitignore"), ".minga/\n");
  mkdirSync(join(repo, ".minga"));
  writeFileSync(join(repo, ".minga", "head.json"), "{\"secret\":true}");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  server = Bun.serve({ port: 0, fetch: (req) => (isGitRequest(new URL(req.url).pathname) ? serveGit(req, repo) : new Response("no", { status: 404 })) });
});
afterAll(() => server.stop(true));

test("clones the project read-only over smart HTTP, without .minga", async () => {
  const dest = join(mkdtempSync(join(tmpdir(), "minga-clone-")), "c");
  const r = await gitAsync(tmpdir(), "clone", "-q", `http://localhost:${server.port}/repo.git`, dest);
  expect(r.code).toBe(0);
  expect(readFileSync(join(dest, "check.ts"), "utf8")).toContain("process.exit");
  expect(existsSync(join(dest, ".minga"))).toBe(false);

  writeFileSync(join(dest, "check.ts"), "tampered\n");
  git(dest, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qam", "x");
  const push = await gitAsync(dest, "push", "origin", "main");
  expect(push.code).not.toBe(0);
  expect(push.err).toContain("read-only");
  expect(git(repo, "log", "--oneline").out.trim().split("\n")).toHaveLength(1);
}, 30_000);

test("refuses anything but upload-pack", async () => {
  const base = `http://localhost:${server.port}/repo.git`;
  expect((await fetch(`${base}/info/refs?service=git-receive-pack`)).status).toBe(403);
  expect((await fetch(`${base}/HEAD`)).status).toBe(403);
  expect((await fetch(`${base}/info/refs?service=git-upload-pack`)).status).toBe(200);
});
