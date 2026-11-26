import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchHead, changedPaths, commitAccepted } from "../src/verify/gitops.ts";
import { createCheckPool } from "../src/verify/runner.ts";

// --------------------------------------------------------------- test helpers

const scratch: string[] = [];

interface RunOut {
  code: number;
  stdout: string;
  stderr: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** POSIX single-quote for values embedded in a Bun Shell command. */
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

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

const makeDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "minga-stamps-"));
  scratch.push(dir);
  return dir;
};

const worktreeCount = async (repo: string): Promise<number> => {
  const list = await git(repo, ["worktree", "list"]);
  return list.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
};

const processAlive = (pid: number): boolean => {
  if (process.platform === "win32") {
    const result = Bun.spawnSync(["tasklist", "/FI", `PID eq ${pid}`, "/NH"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return result.stdout.toString().includes(String(pid));
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

afterAll(async () => {
  for (const dir of scratch) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

// ----------------------------------------------------------------- check pool

describe("createCheckPool", () => {
  test("size 2 runs 5 checks: at most 2 concurrent, all complete, FIFO starts", async () => {
    const repo = await makeRepo();
    const stamps = await makeDir();
    const base = await git(repo, ["rev-parse", "HEAD"]);
    const pool = await createCheckPool({ repoDir: repo, size: 2, keep: [] });

    try {
      expect(pool.size).toBe(2);
      expect(pool.busy).toBe(0);
      expect(await worktreeCount(repo)).toBe(3);

      const script = [
        "const fs=require('fs');",
        "const id=fs.readFileSync('run.id','utf8').trim();",
        "const start=Date.now();",
        "Bun.sleepSync(800);",
        "fs.writeFileSync(process.argv[1]+'/'+id+'.json',JSON.stringify({id,start,end:Date.now()}));",
      ].join("");
      const command = `bun -e "${script}" ${quote(stamps)}`;

      const promises: Promise<{ id: number; result: Awaited<ReturnType<typeof pool.run>> }>[] = [];
      for (const id of [0, 1, 2, 3, 4]) {
        promises.push(pool.run({ base, files: { "run.id": `${id}\n` }, command, timeoutSeconds: 30 })
          .then((result) => ({ id, result })));
        // Space the submissions out so FIFO start order is unambiguous.
        await sleep(60);
      }
      const runs = await Promise.all(promises);
      expect(runs.every(({ result }) => result.ok)).toBe(true);
      expect(pool.busy).toBe(0);

      const entries = await Promise.all([0, 1, 2, 3, 4].map(async (id) => {
        const text = await readFile(join(stamps, `${id}.json`), "utf8");
        return JSON.parse(text) as { id: number; start: number; end: number };
      }));

      // Sweep start/end events to find the peak number of overlapping runs.
      const events = entries.flatMap((entry) => [
        { at: entry.start, delta: 1 },
        { at: entry.end, delta: -1 },
      ]).sort((a, b) => a.at - b.at || a.delta - b.delta);
      let current = 0;
      let peak = 0;
      for (const event of events) {
        current += event.delta;
        peak = Math.max(peak, current);
      }
      expect(peak).toBeLessThanOrEqual(2);
      expect(peak).toBeGreaterThanOrEqual(2);

      // FIFO means a queued run cannot start until an earlier run has freed a
      // slot. Exact command-start order within a wave jitters with process
      // startup, so compare against the earlier wave's end instead.
      const startOf = (id: number): number => entries.find((entry) => Number(entry.id) === id)!.start;
      const endOf = (id: number): number => entries.find((entry) => Number(entry.id) === id)!.end;
      expect(Math.min(startOf(2), startOf(3))).toBeGreaterThanOrEqual(Math.min(endOf(0), endOf(1)) - 200);
      expect(startOf(4)).toBeGreaterThanOrEqual(Math.min(endOf(2), endOf(3)) - 200);
      expect(Math.min(startOf(2), startOf(3))).toBeLessThanOrEqual(startOf(4) + 200);
    } finally {
      await pool.close();
    }
    expect(await worktreeCount(repo)).toBe(1);
  }, 30000);

  test("keep paths survive a run; untracked files and tracked edits are reset", async () => {
    const repo = await makeRepo();
    const base = await git(repo, ["rev-parse", "HEAD"]);
    const pool = await createCheckPool({ repoDir: repo, size: 1, keep: [".cache"] });

    try {
      const seed = await pool.run({
        base,
        files: {},
        timeoutSeconds: 30,
        command: `bun -e "${[
          "const fs=require('fs');",
          "fs.mkdirSync('.cache',{recursive:true});",
          "fs.writeFileSync('.cache/x','v1');",
          "fs.writeFileSync('untracked.txt','junk');",
          "fs.writeFileSync('README.md','tampered');",
        ].join("")}"`,
      });
      expect(seed.ok).toBe(true);

      const second = await pool.run({
        base,
        files: {},
        timeoutSeconds: 30,
        command: `bun -e "${[
          "const fs=require('fs');",
          "if(fs.readFileSync('.cache/x','utf8')!=='v1')process.exit(1);",
          "if(fs.readFileSync('README.md','utf8')!=='hello'+String.fromCharCode(10))process.exit(2);",
          "if(fs.existsSync('untracked.txt'))process.exit(3);",
        ].join("")}"`,
      });
      expect(second.ok).toBe(true);
    } finally {
      await pool.close();
    }

    expect(await git(repo, ["status", "--porcelain"])).toBe("");
    expect(await readFile(join(repo, "README.md"), "utf8")).toBe("hello\n");
  });

  test("checks the requested base, not the branch head", async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, "data.txt"), "base\n");
    await git(repo, ["add", "data.txt"]);
    await git(repo, ["commit", "-m", "base commit"]);
    const base = await git(repo, ["rev-parse", "HEAD"]);
    await writeFile(join(repo, "data.txt"), "head\n");
    await git(repo, ["commit", "-am", "head commit"]);

    const pool = await createCheckPool({ repoDir: repo, size: 1, keep: [] });
    try {
      const result = await pool.run({
        base,
        files: {},
        timeoutSeconds: 30,
        command: `bun -e "process.exit(require('fs').readFileSync('data.txt','utf8').trim()==='base'?0:1)"`,
      });
      expect(result.ok).toBe(true);
    } finally {
      await pool.close();
    }
  });

  test("timeout kills the entire process tree, including a grandchild", async () => {
    const repo = await makeRepo();
    const stamps = await makeDir();
    const pidFile = join(stamps, "child.pid");
    const base = await git(repo, ["rev-parse", "HEAD"]);
    const pool = await createCheckPool({ repoDir: repo, size: 1, keep: [] });

    let childPid = 0;
    try {
      const script = [
        "const fs=require('fs');",
        "const c=Bun.spawn([process.execPath,'-e','setInterval(function(){},1000)'],",
        "{stdin:'ignore',stdout:'ignore',stderr:'ignore'});",
        "fs.writeFileSync(process.argv[1],String(c.pid));",
        "setInterval(function(){},1000);",
      ].join("");
      const result = await pool.run({
        base,
        files: {},
        timeoutSeconds: 3,
        command: `bun -e "${script}" ${quote(pidFile)}`,
      });
      expect(result.timedOut).toBe(true);
      expect(result.ok).toBe(false);

      // Slow bun startup on Windows can eat part of the timeout; give the
      // check a moment to record its child's pid before reading it.
      for (let attempt = 0; attempt < 20 && !existsSync(pidFile); attempt++) await sleep(50);
      expect(existsSync(pidFile)).toBe(true);
      childPid = Number((await readFile(pidFile, "utf8")).trim());
      expect(childPid).toBeGreaterThan(0);

      let alive = true;
      for (let attempt = 0; attempt < 30 && alive; attempt++) {
        alive = processAlive(childPid);
        if (alive) await sleep(100);
      }
      expect(alive).toBe(false);
    } finally {
      if (childPid > 0 && processAlive(childPid)) {
        if (process.platform === "win32") {
          Bun.spawnSync(["taskkill", "/pid", String(childPid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
        } else {
          try { process.kill(childPid, "SIGKILL"); } catch { /* already gone */ }
        }
      }
      await pool.close();
    }
  }, 20_000);

  test("server secrets stay out; MINGA_CHECK_ENV names get through", async () => {
    const repo = await makeRepo();
    const base = await git(repo, ["rev-parse", "HEAD"]);
    const pool = await createCheckPool({ repoDir: repo, size: 1, keep: [] });
    const oldSecret = process.env.MINGA_TEST_SECRET;
    const oldExtra = process.env.MINGA_CHECK_ENV;
    const oldExtraValue = process.env.MINGA_TEST_EXTRA;
    process.env.MINGA_TEST_SECRET = "hunter2";
    process.env.MINGA_CHECK_ENV = "MINGA_TEST_EXTRA";
    process.env.MINGA_TEST_EXTRA = "visible";

    try {
      const result = await pool.run({
        base,
        files: {},
        timeoutSeconds: 30,
        command: `bun -e "if(process.env.MINGA_TEST_SECRET)process.exit(7);if(process.env.MINGA_TEST_EXTRA!=='visible')process.exit(8)"`,
      });
      expect(result.exitCode).toBe(0);
    } finally {
      for (const [key, value] of [
        ["MINGA_TEST_SECRET", oldSecret],
        ["MINGA_CHECK_ENV", oldExtra],
        ["MINGA_TEST_EXTRA", oldExtraValue],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await pool.close();
    }
  });

  test("submitted files, {files} and MINGA_FILES are available to the check", async () => {
    const repo = await makeRepo();
    const base = await git(repo, ["rev-parse", "HEAD"]);
    const pool = await createCheckPool({ repoDir: repo, size: 1, keep: [] });
    try {
      const script = [
        "const fs=require('fs');",
        "const p=process.argv.slice(1);",
        "const e=process.env.MINGA_FILES;",
        "const ok=fs.readFileSync(p[0],'utf8')==='hello from submit'",
        "?fs.readFileSync(p[1],'utf8')==='quoted content'",
        "?e==='notes/plain.txt notes/with space.txt'?0:1:1:1;",
        "process.exit(ok)",
      ].join("");
      const result = await pool.run({
        base,
        files: { "notes/plain.txt": "hello from submit", "notes/with space.txt": "quoted content" },
        timeoutSeconds: 30,
        command: `bun -e "${script}" {files}`,
      });
      expect(result.ok).toBe(true);
    } finally {
      await pool.close();
    }
  });

  test("output tail keeps the last maxOutput bytes", async () => {
    const repo = await makeRepo();
    const base = await git(repo, ["rev-parse", "HEAD"]);
    const pool = await createCheckPool({ repoDir: repo, size: 1, keep: [] });
    try {
      const result = await pool.run({
        base,
        files: {},
        timeoutSeconds: 30,
        maxOutput: 128,
        command: `bun -e "process.stdout.write('a'.repeat(10000)); process.stderr.write('b'.repeat(10000));"`,
      });
      expect(result.outputTail).toBe("b".repeat(128));

      const defaults = await pool.run({
        base,
        files: {},
        timeoutSeconds: 30,
        command: `bun -e "process.stdout.write('z'.repeat(20000))"`,
      });
      expect(defaults.outputTail).toBe("z".repeat(8000));
    } finally {
      await pool.close();
    }
  });

  test("the maintainer's working tree, index and HEAD never change", async () => {
    const repo = await makeRepo();
    const base = await git(repo, ["rev-parse", "HEAD"]);
    const statusBefore = await git(repo, ["status", "--porcelain"]);
    const indexBefore = await git(repo, ["ls-files", "-s"]);
    const pool = await createCheckPool({ repoDir: repo, size: 2, keep: [".cache"] });

    try {
      for (let id = 0; id < 3; id++) {
        const result = await pool.run({
          base,
          files: { "submitted.txt": `${id}\n` },
          timeoutSeconds: 30,
          command: `bun -e "process.exit(0)"`,
        });
        expect(result.ok).toBe(true);
      }
    } finally {
      await pool.close();
    }

    expect(await git(repo, ["status", "--porcelain"])).toBe(statusBefore);
    expect(await git(repo, ["ls-files", "-s"])).toBe(indexBefore);
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(base);
    expect(existsSync(join(repo, "submitted.txt"))).toBe(false);
    expect(await worktreeCount(repo)).toBe(1);
  });
});

// -------------------------------------------------------------- git plumbing

describe("commitAccepted", () => {
  test("commits files on top of parent with trailers and no checkout changes", async () => {
    const repo = await makeRepo();
    const parent = await git(repo, ["rev-parse", "HEAD"]);
    const indexBefore = await git(repo, ["ls-files", "-s"]);
    const diffBefore = await git(repo, ["diff"]);

    const outcome = await commitAccepted({
      repoDir: repo,
      branch: "main",
      parent,
      files: { "src/app.ts": "export const answer = 42;\n", "README.md": "hello\nupdated\n" },
      message: "Accept submission S-1",
      trailers: { "Agent-Id": "0123456789abcdef", "Agent-Model": "test-model", "Minga-Task": "T-3" },
      author: "Ada Lovelace",
    });
    expect(outcome.ok).toBe(true);
    const commit = outcome.ok ? outcome.commit : "";
    expect(commit).toMatch(/^[0-9a-f]{40}$/);

    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(commit);
    expect(await git(repo, ["rev-parse", "HEAD^"])).toBe(parent);
    expect(await git(repo, ["ls-tree", "-r", "--name-only", commit])).toBe("README.md\nsrc/app.ts");

    expect((await raw(repo, ["cat-file", "blob", `${commit}:src/app.ts`])).stdout)
      .toBe("export const answer = 42;\n");
    expect((await raw(repo, ["cat-file", "blob", `${commit}:README.md`])).stdout)
      .toBe("hello\nupdated\n");

    const body = await git(repo, ["log", "-1", "--format=%B", commit]);
    expect(body.split(/\r?\n/)).toContain("Accept submission S-1");
    expect(body.split(/\r?\n/)).toContain("Agent-Id: 0123456789abcdef");
    expect(body.split(/\r?\n/)).toContain("Agent-Model: test-model");
    expect(body.split(/\r?\n/)).toContain("Minga-Task: T-3");
    expect(await git(repo, ["log", "-1", "--format=%an", commit])).toBe("Ada Lovelace");
    expect(await git(repo, ["log", "-1", "--format=%ae", commit])).toBe("ada-lovelace@minga.invalid");
    expect(await git(repo, ["log", "-1", "--format=%cn", commit])).toBe("Ada Lovelace");
    expect(await git(repo, ["log", "-1", "--format=%ce", commit])).toBe("ada-lovelace@minga.invalid");

    expect(await git(repo, ["ls-files", "-s"])).toBe(indexBefore);
    expect(await git(repo, ["diff"])).toBe(diffBefore);
    expect(await readFile(join(repo, "README.md"), "utf8")).toBe("hello\n");
    expect(existsSync(join(repo, "src", "app.ts"))).toBe(false);
  });

  test("returns stale with the current head when the branch moved", async () => {
    const repo = await makeRepo();
    const parent = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["commit", "--allow-empty", "-m", "external move"]);
    const head = await git(repo, ["rev-parse", "HEAD"]);

    const outcome = await commitAccepted({
      repoDir: repo,
      branch: "main",
      parent,
      files: { "late.txt": "late\n" },
      message: "Too late",
      trailers: { "Agent-Id": "0123456789abcdef" },
      author: "Alan Turing",
    });
    expect(outcome).toEqual({ ok: false, stale: true, head });
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(head);
    expect((await raw(repo, ["cat-file", "-e", `${head}:late.txt`])).code).not.toBe(0);
  });

  test("concurrent calls serialize: one CAS winner, one stale loser", async () => {
    const repo = await makeRepo();
    const parent = await git(repo, ["rev-parse", "HEAD"]);
    const base = {
      repoDir: repo,
      branch: "main",
      parent,
      author: "Grace Hopper",
      trailers: { "Agent-Id": "ffffffffffffffff" },
    };
    const [a, b] = await Promise.all([
      commitAccepted({ ...base, files: { "a.txt": "A\n" }, message: "Commit A" }),
      commitAccepted({ ...base, files: { "b.txt": "B\n" }, message: "Commit B" }),
    ]);

    const outcomes = [a, b];
    const winner = outcomes.find((outcome) => outcome.ok);
    const loser = outcomes.find((outcome) => !outcome.ok);
    expect(winner).toBeDefined();
    expect(loser).toEqual({
      ok: false,
      stale: true,
      head: winner && winner.ok ? winner.commit : "",
    });

    const history = (await git(repo, ["rev-list", "main"])).split(/\r?\n/).filter(Boolean);
    expect(history).toHaveLength(2);
    expect(history[1]).toBe(parent);
    // The winning commit contains only its own file: no interleaved index writes.
    const files = (await git(repo, ["ls-tree", "-r", "--name-only", "HEAD"])).split(/\r?\n/);
    expect(files).toEqual(winner && winner.ok
      ? ["README.md", (await git(repo, ["log", "-1", "--format=%s", "HEAD"])) === "Commit A" ? "a.txt" : "b.txt"]
      : []);
  });

  test("preserves spaces, unicode, CRLF and binary-ish bytes across multiple files", async () => {
    const repo = await makeRepo();
    const parent = await git(repo, ["rev-parse", "HEAD"]);
    const indexBefore = await git(repo, ["ls-files", "-s"]);
    const diffBefore = await git(repo, ["diff"]);
    const files: Record<string, string> = {
      "src/hello world.ts": "export const x = 1;\r\n",
      "docs/ünïcode 文件/notes with spaces.txt": "café 你好\r\nsecond line\n",
      "raw.bin": "A\u0000B\r\nC\u00ff\n",
    };

    const outcome = await commitAccepted({
      repoDir: repo,
      branch: "main",
      parent,
      files,
      message: "Accept binary submission S-42",
      trailers: { "Agent-Id": "abcdef0123456789", "Minga-Task": "T-42" },
      author: "Ada Lovelace",
    });
    expect(outcome.ok).toBe(true);
    const commit = outcome.ok ? outcome.commit : "";

    // -z keeps git from C-quoting the unicode path in the listing.
    const listed = (await raw(repo, ["ls-tree", "-r", "-z", "--name-only", commit])).stdout
      .split("\0").filter(Boolean).sort();
    expect(listed).toEqual(["README.md", ...Object.keys(files)].sort());

    for (const [path, content] of Object.entries(files)) {
      const blob = await raw(repo, ["cat-file", "-p", `${commit}:${path}`]);
      expect(blob.code).toBe(0);
      expect(blob.stdout).toBe(content);
    }
    const body = await git(repo, ["log", "-1", "--format=%B", commit]);
    expect(body.split(/\r?\n/)).toContain("Accept binary submission S-42");
    expect(body.split(/\r?\n/)).toContain("Agent-Id: abcdef0123456789");
    expect(body.split(/\r?\n/)).toContain("Minga-Task: T-42");

    expect(await git(repo, ["ls-files", "-s"])).toBe(indexBefore);
    expect(await git(repo, ["diff"])).toBe(diffBefore);
    expect(await readFile(join(repo, "README.md"), "utf8")).toBe("hello\n");
    expect(existsSync(join(repo, "src"))).toBe(false);
  });

  test("leaves no refs/minga/tmp/* behind on success or stale", async () => {
    const repo = await makeRepo();
    const parent = await git(repo, ["rev-parse", "HEAD"]);
    const tmpRefs = async (): Promise<string> =>
      git(repo, ["for-each-ref", "--format=%(refname)", "refs/minga/tmp/"]);
    expect(await tmpRefs()).toBe("");

    const accepted = await commitAccepted({
      repoDir: repo,
      branch: "main",
      parent,
      files: { "ok.txt": "ok\n" },
      message: "Clean up on success",
      trailers: {},
      author: "Ada Lovelace",
    });
    expect(accepted.ok).toBe(true);
    expect(await tmpRefs()).toBe("");

    await git(repo, ["commit", "--allow-empty", "-m", "external move"]);
    const stale = await commitAccepted({
      repoDir: repo,
      branch: "main",
      parent,
      files: { "late.txt": "late\n" },
      message: "Clean up on stale",
      trailers: {},
      author: "Ada Lovelace",
    });
    expect(stale.ok).toBe(false);
    expect(await tmpRefs()).toBe("");
  });

  test("10 sequential commits average under 300 ms", async () => {
    const repo = await makeRepo();
    let parent = await git(repo, ["rev-parse", "HEAD"]);
    const started = Date.now();
    for (let i = 0; i < 10; i += 1) {
      const outcome = await commitAccepted({
        repoDir: repo,
        branch: "main",
        parent,
        files: { [`step-${i}.txt`]: `step ${i}\n` },
        message: `Step ${i}`,
        trailers: {},
        author: "Speed Tester",
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) break;
      parent = outcome.commit;
    }
    const avgMs = (Date.now() - started) / 10;
    console.log(`commitAccepted: avg ${avgMs.toFixed(1)} ms over 10 sequential commits`);
    expect(avgMs).toBeLessThan(300);
  });
});

describe("read-only git helpers", () => {
  test("branchHead reads a ref and throws for a missing branch", async () => {
    const repo = await makeRepo();
    expect(await branchHead(repo, "main")).toBe(await git(repo, ["rev-parse", "HEAD"]));
    await expect(branchHead(repo, "does-not-exist")).rejects.toThrow(/does-not-exist/);
  });

  test("changedPaths lists paths between two commits", async () => {
    const repo = await makeRepo();
    const from = await branchHead(repo, "main");
    await writeFile(join(repo, "new.txt"), "new\n");
    await git(repo, ["add", "new.txt"]);
    await git(repo, ["commit", "-m", "add new file"]);
    const to = await branchHead(repo, "main");
    expect(await changedPaths(repo, from, to)).toEqual(["new.txt"]);
    expect(await changedPaths(repo, to, to)).toEqual([]);
  });
});
