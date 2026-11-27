/**
 * Docker sandbox tests. The whole suite is skipped unless `docker info`
 * succeeds; the fail-closed unit test at the bottom always runs.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckPoolOptions } from "../src/core/contracts.ts";
import { createCheckPool } from "../src/verify/runner.ts";

const IMAGE = "alpine:3.20";
const SECRET = "TOP-SECRET-DO-NOT-LEAK-9f7c2a";

const sandbox = {
  mode: "docker" as const,
  image: IMAGE,
  network: "none" as const,
  memory: "512m",
  cpus: 1,
  pids: 100,
};

const dockerAvailable = (() => {
  try {
    return Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  } catch {
    return false;
  }
})();

const scratch: string[] = [];
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface RunOut {
  code: number;
  stdout: string;
  stderr: string;
}

const raw = async (cwd: string, args: string[]): Promise<RunOut> => {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
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
};

const git = async (cwd: string, args: string[]): Promise<string> => {
  const result = await raw(cwd, args);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
};

const makeRepo = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "minga-sandbox-"));
  scratch.push(dir);
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.name", "Sandbox Test"]);
  await git(dir, ["config", "user.email", "sandbox@example.com"]);
  await git(dir, ["config", "core.autocrlf", "false"]);
  await writeFile(join(dir, "README.md"), "hello\n");
  await git(dir, ["add", "README.md"]);
  await git(dir, ["commit", "-m", "init"]);
  return dir;
};

const containerNames = async (): Promise<string[]> => {
  try {
    const proc = Bun.spawn(
      ["docker", "ps", "-a", "--filter", "name=minga-check", "--format", "{{.Names}}"],
      { stdout: "pipe", stderr: "ignore" },
    );
    const out = await new Response(proc.stdout).text();
    return out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
};

afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe.skipIf(!dockerAvailable)("docker sandbox", () => {
  test("the check cannot read the maintainer's .minga/head.json", async () => {
    const repo = await makeRepo();
    await mkdir(join(repo, ".minga"), { recursive: true });
    await writeFile(join(repo, ".minga", "head.json"), `{"key":"${SECRET}"}\n`);
    const base = await git(repo, ["rev-parse", "HEAD"]);
    const pool = await createCheckPool({ repoDir: repo, size: 1, keep: [], sandbox });

    try {
      const result = await pool.run({
        base,
        files: {},
        timeoutSeconds: 30,
        command: "cat /work/../.minga/head.json; ls / ; test ! -e /work/.minga/head.json",
      });
      expect(result.ok).toBe(true);
      expect(result.outputTail).not.toContain(SECRET);
    } finally {
      await pool.close();
    }
  });

  test("the container has no network", async () => {
    const repo = await makeRepo();
    const base = await git(repo, ["rev-parse", "HEAD"]);
    const pool = await createCheckPool({ repoDir: repo, size: 1, keep: [], sandbox });

    try {
      const result = await pool.run({
        base,
        files: {},
        timeoutSeconds: 30,
        command: "if timeout 3 wget -q -O /tmp/net.out http://example.com; then echo NETWORK-OK; exit 1; fi; echo NETWORK-BLOCKED; exit 0",
      });
      expect(result.ok).toBe(true);
      expect(result.outputTail).toContain("NETWORK-BLOCKED");
      expect(result.outputTail).not.toContain("NETWORK-OK");
    } finally {
      await pool.close();
    }
  }, 30_000);

  test("writing /work/.git fails or is detected, and the pointer is unchanged", async () => {
    const repo = await makeRepo();
    const base = await git(repo, ["rev-parse", "HEAD"]);
    const pool = await createCheckPool({ repoDir: repo, size: 1, keep: [], sandbox });
    const gitPath = join(repo, ".minga", "worktrees", "0", ".git");

    try {
      expect(existsSync(gitPath)).toBe(true);
      const before = await readFile(gitPath, "utf8");
      const result = await pool.run({
        base,
        files: {},
        timeoutSeconds: 30,
        command: "echo pwned > /work/.git",
      });
      expect(result.ok).toBe(false);
      expect(await readFile(gitPath, "utf8")).toBe(before);
    } finally {
      await pool.close();
    }
  });

  test("timeout removes the container", async () => {
    const repo = await makeRepo();
    const base = await git(repo, ["rev-parse", "HEAD"]);
    const pool = await createCheckPool({ repoDir: repo, size: 1, keep: [], sandbox });
    const before = await containerNames();

    try {
      const result = await pool.run({
        base,
        files: {},
        timeoutSeconds: 2,
        command: "sleep 60",
      });
      expect(result.timedOut).toBe(true);
      expect(result.ok).toBe(false);

      let names = before;
      for (let attempt = 0; attempt < 30; attempt++) {
        names = await containerNames();
        if (names.every((name) => before.includes(name))) break;
        await sleep(100);
      }
      expect(names.every((name) => before.includes(name))).toBe(true);
    } finally {
      await pool.close();
    }
  }, 20_000);

  test("a passing command passes", async () => {
    const repo = await makeRepo();
    const base = await git(repo, ["rev-parse", "HEAD"]);
    const pool = await createCheckPool({ repoDir: repo, size: 1, keep: [], sandbox });

    try {
      const result = await pool.run({
        base,
        files: {},
        timeoutSeconds: 30,
        command: "echo sandbox-passed; test 1 -eq 1",
      });
      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.outputTail).toContain("sandbox-passed");
    } finally {
      await pool.close();
    }
  });
});

test("docker unavailable fails closed and never runs the command unsandboxed", async () => {
  const repo = await makeRepo();
  const base = await git(repo, ["rev-parse", "HEAD"]);
  const opts = {
    repoDir: repo,
    size: 1,
    keep: [],
    sandbox,
    // Internal test hook; not part of the CheckPoolOptions contract.
    dockerBin: "minga-docker-binary-does-not-exist-xyz",
  } as CheckPoolOptions & { dockerBin: string };
  const pool = await createCheckPool(opts);

  try {
    const result = await pool.run({
      base,
      files: {},
      timeoutSeconds: 10,
      command: "echo SHOULD-NOT-RUN",
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(-1);
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBe(0);
    expect(result.outputTail).toContain("sandbox: docker is not available on the server (");
    expect(result.outputTail).toContain("; the check did not run");
    expect(result.outputTail).not.toContain("SHOULD-NOT-RUN");
  } finally {
    await pool.close();
  }
});
