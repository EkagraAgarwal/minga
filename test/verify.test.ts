import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitAccepted } from "../src/verify/gitops.ts";
import { runCheck } from "../src/verify/runner.ts";

// --------------------------------------------------------------- test helpers

const scratch: string[] = [];

interface RunOut {
  code: number;
  stdout: string;
  stderr: string;
}

const raw = async (cwd: string, args: string[], stdin?: string): Promise<RunOut> => {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdin: stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = new Response(proc.stdout).text();
  const err = new Response(proc.stderr).text();
  if (stdin !== undefined) {
    const sink = proc.stdin;
    if (!sink) throw new Error(`git ${args.join(" ")}: stdin pipe unavailable`);
    await sink.write(stdin);
    await sink.end();
  }
  const [stdout, stderr, code] = await Promise.all([out, err, proc.exited]);
  return { code, stdout, stderr };
};

const git = async (cwd: string, args: string[]): Promise<string> => {
  const result = await raw(cwd, args);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
};

const makeRepo = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "minga-verify-"));
  scratch.push(dir);
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.name", "Test Maintainer"]);
  await git(dir, ["config", "user.email", "maintainer@example.com"]);
  await git(dir, ["config", "core.autocrlf", "false"]);
  await writeFile(join(dir, "README.md"), "hello\n");
  await git(dir, ["add", "README.md"]);
  await git(dir, ["commit", "-m", "init"]);
  return dir;
};

const worktreeCount = async (repo: string): Promise<number> => {
  const list = await git(repo, ["worktree", "list"]);
  return list.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
};

afterAll(async () => {
  for (const dir of scratch) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

// ------------------------------------------------------------------ runCheck

describe("runCheck environment", () => {
  test("server secrets do not reach the check; PATH does", async () => {
    const repo = await makeRepo();
    process.env.MINGA_TEST_SECRET = "hunter2";
    try {
      const res = await runCheck({
        repoDir: repo, branch: "main", files: { "a.txt": "x" }, timeoutSeconds: 30,
        // Finding `bun` at all proves PATH got through; the secret must not.
        command: `bun -e "if (process.env.MINGA_TEST_SECRET) process.exit(7)"`,
      });
      expect(res.exitCode).toBe(0);
    } finally {
      delete process.env.MINGA_TEST_SECRET;
    }
  });
});

describe("runCheck", () => {
  test("passing check is ok and leaves repo and worktree list clean", async () => {
    const repo = await makeRepo();
    const statusBefore = await git(repo, ["status", "--porcelain"]);
    const indexBefore = await git(repo, ["ls-files", "-s"]);

    const result = await runCheck({
      repoDir: repo,
      branch: "main",
      files: { "notes/pass.txt": "ok\n" },
      command: 'bun -e "process.exit(0)"',
      timeoutSeconds: 30,
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(await worktreeCount(repo)).toBe(1);
    expect(await git(repo, ["status", "--porcelain"])).toBe(statusBefore);
    expect(await git(repo, ["ls-files", "-s"])).toBe(indexBefore);
    expect(await readFile(join(repo, "README.md"), "utf8")).toBe("hello\n");
    expect(existsSync(join(repo, "notes", "pass.txt"))).toBe(false);
  });

  test("failing check reports the exit code", async () => {
    const repo = await makeRepo();
    const result = await runCheck({
      repoDir: repo,
      branch: "main",
      files: { "notes/fail.txt": "x\n" },
      command: 'bun -e "process.exit(3)"',
      timeoutSeconds: 30,
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
    expect(result.outputTail).toBe("");
    expect(await worktreeCount(repo)).toBe(1);
  });

  test("submitted files are present and {files} expands to quoted paths", async () => {
    const repo = await makeRepo();
    const files = {
      "notes/plain.txt": "hello from submit",
      "notes/with space.txt": "quoted content",
    };
    // No cmd.exe metacharacters (&&, ||, %): on Windows `bun` on PATH is often a
    // .cmd shim and Bun Shell rejects such arguments when routing through cmd.exe.
    const script = [
      "const fs=require('fs');",
      "const p=process.argv.slice(1);",
      "const e=process.env.MINGA_FILES;",
      "const ok=fs.readFileSync(p[0],'utf8')==='hello from submit'",
      "?fs.readFileSync(p[1],'utf8')==='quoted content'",
      "?e==='notes/plain.txt notes/with space.txt'?0:1:1:1;",
      "process.exit(ok)",
    ].join("");
    const result = await runCheck({
      repoDir: repo,
      branch: "main",
      files,
      command: `bun -e "${script}" {files}`,
      timeoutSeconds: 30,
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  test("a path containing a single quote survives shell quoting", async () => {
    const repo = await makeRepo();
    const result = await runCheck({
      repoDir: repo,
      branch: "main",
      files: { "notes/it's ok.txt": "apostrophe content" },
      command: `bun -e "const fs=require('fs'); process.exit(fs.readFileSync(process.argv[1],'utf8')==='apostrophe content'?0:1)" {files}`,
      timeoutSeconds: 30,
    });

    expect(result.ok).toBe(true);
  });

  test("timeout kills the check and still removes the worktree", async () => {
    const repo = await makeRepo();
    const started = Date.now();
    const result = await runCheck({
      repoDir: repo,
      branch: "main",
      files: {},
      command: "sleep 10",
      timeoutSeconds: 1,
    });
    const elapsed = Date.now() - started;

    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(elapsed).toBeLessThan(5000);
    expect(await worktreeCount(repo)).toBe(1);
  });

  test("output tail keeps the last maxOutput bytes, stdout before stderr", async () => {
    const repo = await makeRepo();
    const result = await runCheck({
      repoDir: repo,
      branch: "main",
      files: {},
      command: `bun -e "process.stdout.write('a'.repeat(10000)); process.stderr.write('b'.repeat(10000));"`,
      timeoutSeconds: 30,
      maxOutput: 128,
    });

    expect(result.ok).toBe(true);
    expect(result.outputTail).toBe("b".repeat(128));

    const defaults = await runCheck({
      repoDir: repo,
      branch: "main",
      files: {},
      command: `bun -e "process.stdout.write('z'.repeat(20000))"`,
      timeoutSeconds: 30,
    });
    expect(defaults.outputTail.length).toBe(8000);
    expect(defaults.outputTail).toBe("z".repeat(8000));
  });
});

// ------------------------------------------------------------ commitAccepted

describe("commitAccepted", () => {
  test("commits files on main with trailers, without touching the checkout", async () => {
    const repo = await makeRepo();
    const oldHead = await git(repo, ["rev-parse", "HEAD"]);
    const indexBefore = await git(repo, ["ls-files", "-s"]);
    const diffBefore = await git(repo, ["diff"]);
    const readmeBefore = await readFile(join(repo, "README.md"), "utf8");

    const appPath = "src/app.ts";
    const appContent = "export const answer = 42;\n";
    const readmeContent = "hello\nupdated\n";

    const sha = await commitAccepted({
      repoDir: repo,
      branch: "main",
      files: { [appPath]: appContent, "README.md": readmeContent },
      message: "Accept submission S-1",
      trailers: { "Agent-Id": "0123456789abcdef", "Agent-Model": "test-model", "Minga-Task": "T-3" },
      author: "Ada Lovelace",
    });

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(sha);
    expect(await git(repo, ["rev-parse", "HEAD^"])).toBe(oldHead);
    expect(await git(repo, ["ls-tree", "-r", "--name-only", sha])).toBe("README.md\nsrc/app.ts");

    const appBlob = await raw(repo, ["cat-file", "blob", `${sha}:${appPath}`]);
    const readmeBlob = await raw(repo, ["cat-file", "blob", `${sha}:README.md`]);
    expect(appBlob.stdout).toBe(appContent);
    expect(readmeBlob.stdout).toBe(readmeContent);

    const body = await git(repo, ["log", "-1", "--format=%B", sha]);
    expect(body).toContain("Accept submission S-1");
    expect(body).toContain("Agent-Id: 0123456789abcdef");
    expect(body).toContain("Agent-Model: test-model");
    expect(body).toContain("Minga-Task: T-3");
    expect(body.split(/\r?\n/)).toContain("Agent-Id: 0123456789abcdef");
    expect(await git(repo, ["log", "-1", "--format=%an", sha])).toBe("Ada Lovelace");
    expect(await git(repo, ["log", "-1", "--format=%ae", sha])).toBe("ada-lovelace@minga.invalid");
    expect(await git(repo, ["log", "-1", "--format=%cn", sha])).toBe("Ada Lovelace");
    expect(await git(repo, ["log", "-1", "--format=%ce", sha])).toBe("ada-lovelace@minga.invalid");

    // Working tree and real index untouched.
    expect(await git(repo, ["ls-files", "-s"])).toBe(indexBefore);
    expect(await git(repo, ["diff"])).toBe(diffBefore);
    expect(await readFile(join(repo, "README.md"), "utf8")).toBe(readmeBefore);
    expect(existsSync(join(repo, "src", "app.ts"))).toBe(false);
  });

  test("two concurrent commits both land, serialized", async () => {
    const repo = await makeRepo();
    const oldHead = await git(repo, ["rev-parse", "HEAD"]);

    const base = { repoDir: repo, branch: "main", trailers: { "Agent-Id": "ffffffffffffffff" }, author: "Grace Hopper" };
    const [a, b] = await Promise.all([
      commitAccepted({ ...base, files: { "a.txt": "A\n" }, message: "Commit A" }),
      commitAccepted({ ...base, files: { "b.txt": "B\n" }, message: "Commit B" }),
    ]);

    expect(a).not.toBe(b);
    const head = await git(repo, ["rev-parse", "HEAD"]);
    const parent = await git(repo, ["rev-parse", "HEAD^"]);
    expect([a, b]).toContain(head);
    expect([a, b]).toContain(parent);
    expect(parent).not.toBe(head);

    expect((await raw(repo, ["cat-file", "-e", `${head}:a.txt`])).code).toBe(0);
    expect((await raw(repo, ["cat-file", "-e", `${head}:b.txt`])).code).toBe(0);

    const history = (await git(repo, ["rev-list", "main"])).split(/\r?\n/);
    expect(history).toHaveLength(3);
    expect(history[0]).toBe(head);
    expect(history[1]).toBe(parent);
    expect(history[2]).toBe(oldHead);
  });

  test("retries the CAS when the branch moves mid-commit", async () => {
    const repo = await makeRepo();
    const originalSpawn = Bun.spawn;
    const originalSpawnSync = Bun.spawnSync;
    type SpawnFn = typeof Bun.spawn;

    let movedSha = "";
    let moved = false;
    let updateRefCalls = 0;

    const patched = ((...args: Parameters<SpawnFn>) => {
      const argv = args[0];
      const parts = Array.isArray(argv) ? argv.map((part) => String(part)) : [];
      if (parts.includes("update-ref")) {
        updateRefCalls++;
        if (!moved) {
          moved = true;
          // Simulate another writer: advance main before our CAS gets to run.
          const commit = originalSpawnSync(
            ["git", "commit", "--allow-empty", "-m", "external move"],
            { cwd: repo, stdout: "pipe", stderr: "pipe" },
          );
          if (commit.exitCode !== 0) {
            throw new Error(`external move failed: ${commit.stderr.toString()}`);
          }
          const rev = originalSpawnSync(["git", "rev-parse", "HEAD"], { cwd: repo, stdout: "pipe" });
          movedSha = rev.stdout.toString().trim();
        }
      }
      return originalSpawn(...args);
    }) as unknown as SpawnFn;

    (Bun as unknown as { spawn: SpawnFn }).spawn = patched;
    try {
      const sha = await commitAccepted({
        repoDir: repo,
        branch: "main",
        files: { "late.txt": "late\n" },
        message: "Accept after move",
        trailers: { "Agent-Id": "0123456789abcdef" },
        author: "Alan Turing",
      });

      expect(movedSha).toMatch(/^[0-9a-f]{40}$/);
      expect(updateRefCalls).toBe(2);
      expect(await git(repo, ["rev-parse", "HEAD"])).toBe(sha);
      expect(await git(repo, ["rev-parse", "HEAD^"])).toBe(movedSha);
      expect(await git(repo, ["log", "-1", "--format=%s", "HEAD^"])).toBe("external move");
      expect(await git(repo, ["log", "-1", "--format=%s", sha])).toBe("Accept after move");
      expect((await raw(repo, ["cat-file", "-e", `${sha}:late.txt`])).code).toBe(0);
    } finally {
      (Bun as unknown as { spawn: SpawnFn }).spawn = originalSpawn;
    }
  });
});
