// serve's project-branch guard: create a missing branch, refuse a checked-out one.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = join(import.meta.dir, "..", "src", "server", "main.ts");
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function git(dir: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", dir, ...args]);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function repo(branch: string): string {
  const dir = mkdtempSync(join(tmpdir(), "minga-branch-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.invalid");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "project.toml"), [
    `name = "t"`, `goal = "g"`, `scope = "s"`, `check = "true"`, `paths = ["src/**"]`,
    `head = "ed25519:${"A".repeat(43)}"`, `branch = "${branch}"`, "",
  ].join("\n"));
  git(dir, "add", "project.toml");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

function serve(dir: string, ...extra: string[]) {
  const r = Bun.spawnSync([process.execPath, MAIN, "--repo", dir, "--dry-run", ...extra]);
  return { status: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

describe("serve project branch", () => {
  test("refuses a branch that is checked out, unless --allow-checked-out", () => {
    const dir = repo("main");
    const refused = serve(dir);
    expect(refused.status).toBe(1);
    expect(refused.out).toContain("is checked out in");
    expect(refused.out).toContain('branch = \\"minga\\"');
    expect(serve(dir, "--allow-checked-out").status).toBe(0);
  });

  test("a missing branch is fine: serve starts it at HEAD (dry-run creates nothing)", () => {
    const dir = repo("minga");
    const result = serve(dir);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.out).project.head).toBe(git(dir, "rev-parse", "HEAD"));
    expect(Bun.spawnSync(["git", "-C", dir, "rev-parse", "--verify", "--quiet", "refs/heads/minga"]).exitCode).not.toBe(0);
  });
});
