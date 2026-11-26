import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { formatHeadKey } from "../src/identity/keys.ts";
import { createTempRepo, projectToml, removeDir } from "./lib/setup.ts";

/** Run check.ts the same way the v2 verifier does: cwd = repo, MINGA_FILES = paths. */
async function check(repo: string, files: string[]): Promise<number> {
  const proc = Bun.spawn([process.execPath, join(repo, "check.ts")], {
    cwd: repo,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, MINGA_FILES: files.join(" ") },
  });
  return await proc.exited;
}

describe("load-test setup", () => {
  test("project.toml is valid TOML and matches the v2 shape", async () => {
    const repo = await createTempRepo(3);
    try {
      expect(existsSync(join(repo.dir, "check.ts"))).toBe(true);
      const text = await Bun.file(join(repo.dir, "project.toml")).text();
      const parsed = Bun.TOML.parse(text) as Record<string, unknown>;
      expect(parsed.name).toBe("Minga swarm load test");
      expect(parsed.check).toBe("bun check.ts");
      expect(parsed.paths).toEqual(["work/**/*.txt"]);
      expect(parsed.head).toBe(formatHeadKey(repo.head.publicKey));
      expect(parsed.rules).toEqual({ width: 3, lease_minutes: 2 });
      expect(parsed.task).toHaveLength(3);
      // check_concurrency is deliberately absent: auto.
      expect("check_concurrency" in parsed).toBe(false);
      expect(text).toContain("[[task]]");

      const git = Bun.spawnSync(["git", "-C", repo.dir, "branch", "--show-current"]);
      expect(git.stdout?.toString().trim()).toBe("main");
      const log = Bun.spawnSync(["git", "-C", repo.dir, "log", "--oneline"]);
      expect(log.stdout?.toString().trim()).toContain("load test seed");
    } finally {
      await removeDir(repo.dir);
    }
  });

  test("check.ts exits 0 only when every submitted file has an ok line", async () => {
    const repo = await createTempRepo(1);
    try {
      await mkdir(join(repo.dir, "work"), { recursive: true });
      await writeFile(join(repo.dir, "work", "pass.txt"), "draft\nok\nmore\n");
      await writeFile(join(repo.dir, "work", "fail.txt"), "draft\nstill working\n");
      expect(await check(repo.dir, ["work/pass.txt"])).toBe(0);
      expect(await check(repo.dir, ["work/pass.txt", "work/fail.txt"])).toBe(1);
      expect(await check(repo.dir, ["work/missing.txt"])).toBe(1);
    } finally {
      await removeDir(repo.dir);
    }
  });

  test("projectToml produces one [[task]] per requested task", () => {
    const toml = projectToml("abc", 5);
    expect(toml.match(/\[\[task\]\]/g)).toHaveLength(5);
  });
});
