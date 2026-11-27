/**
 * Adversarial end-to-end suite: a cheating agent against the real gate.
 *
 * Every scenario below wires the actual pieces together — a real temp git repo,
 * the real check pool (createCheckPool), real branch/commit plumbing from
 * gitops.ts, the real event store and createApp, and signed HTTP requests. The
 * only thing faked is the passage of time (a fixed clock), so leases never
 * expire mid-test.
 *
 * The tiny project under test starts broken: src/add.ts subtracts, while
 * test/add.test.ts expects addition. The check runs the WHOLE visible suite
 * (`bun test test/`), so the only honest submission is one that fixes add.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import type { CheckPool } from "../src/core/contracts.ts";
import type { Gates, Holdout, ProjectConfig, ReviewPolicy, Sandbox } from "../src/core/types.ts";
import { formatHeadKey, generateKeyPair, signRequest, type KeyPair } from "../src/identity/keys.ts";
import { openEventStore } from "../src/log/store.ts";
import { branchHead, changedPaths, commitAccepted, readFileAt } from "../src/verify/gitops.ts";
import { createCheckPool } from "../src/verify/runner.ts";
import { createApp } from "../src/server/app.ts";

// ---------------------------------------------------------------- helpers

const ADD_BUGGY = "export const add = (a: number, b: number) => a - b;\n";
const ADD_HONEST = "export const add = (a: number, b: number) => a + b;\n";
const ADD_HARDCODED =
  "export const add = (a: number, b: number) => (a === 2 && b === 3 ? 5 : a - b);\n";
const TEST_FILE =
  'import { test, expect } from "bun:test";\n' +
  'import { add } from "../src/add";\n' +
  'test("adds", () => expect(add(2, 3)).toBe(5));\n';
const PACKAGE = '{"name":"tiny","type":"module","private":true}\n';
const FIX = { "src/add.ts": ADD_HONEST };

const scratch: string[] = [];
const pools: CheckPool[] = [];

function git(repo: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(r.stderr)}`);
  }
  return new TextDecoder().decode(r.stdout).trim();
}

interface SetupOptions {
  protect?: string[];
  gates?: Gates;
  review?: ReviewPolicy;
  holdout?: Holdout;
  sandbox?: Sandbox;
  paths?: string[];
}

interface Harness {
  repo: string;
  base: string;
  head: KeyPair;
  cfg: ProjectConfig;
  app: ReturnType<typeof createApp>;
  pool: CheckPool;
  call(keys: KeyPair, path: string, body: unknown): Promise<{ status: number; body: any }>;
  get(path: string): Promise<{ status: number; body: any }>;
  agent(model: string): Promise<KeyPair>;
  take(keys: KeyPair): Promise<{ attempt: string; task: string }>;
  submit(keys: KeyPair, attempt: string, files: Record<string, string>): Promise<any>;
  branch(): Promise<string>;
  startedChecks(): Promise<boolean>;
}

async function setup(over: SetupOptions = {}): Promise<Harness> {
  const repo = mkdtempSync(pathJoin(tmpdir(), "minga-adv-"));
  scratch.push(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Adversarial Test");
  git(repo, "config", "user.email", "adv@example.com");
  git(repo, "config", "core.autocrlf", "false");
  mkdirSync(pathJoin(repo, "src"), { recursive: true });
  mkdirSync(pathJoin(repo, "test"), { recursive: true });
  writeFileSync(pathJoin(repo, "src", "add.ts"), ADD_BUGGY);
  writeFileSync(pathJoin(repo, "test", "add.test.ts"), TEST_FILE);
  writeFileSync(pathJoin(repo, "package.json"), PACKAGE);
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "initial buggy add");
  const base = git(repo, "rev-parse", "HEAD");
  // Accepted work lands on "minga", which is created from HEAD before the app starts.
  git(repo, "update-ref", "refs/heads/minga", base);

  const head = generateKeyPair();
  const clock = Date.parse("2026-11-27T12:00:00Z");
  const cfg: ProjectConfig = {
    name: "adversarial",
    goal: "fix add",
    scope: "src/**",
    check: "bun test test/",
    checkTimeoutSeconds: 30,
    paths: over.paths ?? ["src/**", "test/**", "package.json"],
    head: formatHeadKey(head.publicKey),
    branch: "minga",
    checkConcurrency: 1,
    checkKeep: [],
    recheck: "on-overlap",
    rules: {
      width: 3,
      leaseMinutes: 45,
      maxAttemptsPerAgent: 1,
      roles: { explore: 0, build: 1, attack: 0, distill: 0, plan: 0 },
      accept: { mode: "head-or-votes", votes: 1 },
      defaultPoints: 10,
    },
    seedTasks: [{ title: "Fix add", body: "add must add" }],
    protect: over.protect ?? ["project.toml"],
    gates: over.gates ?? { maxFiles: 0, maxChangedLines: 0, forbid: [], warn: [] },
    review: over.review ?? { mode: "none" },
    ...(over.holdout ? { holdout: over.holdout } : {}),
    sandbox: over.sandbox ?? { mode: "none" },
  };

  const pool = await createCheckPool({
    repoDir: repo,
    size: 1,
    keep: [],
    ...(over.sandbox ? { sandbox: over.sandbox } : {}),
  });
  pools.push(pool);
  const store = openEventStore(":memory:");
  const app = createApp({
    cfg,
    store,
    repoDir: repo,
    pool,
    submissionsDir: pathJoin(repo, ".minga", "submissions"),
    joinLimitPerHour: 0,
    now: () => new Date(clock),
    rng: () => 0.5,
    commitAccepted,
    branchHead,
    changedPaths,
    readFileAt,
  });

  async function call(keys: KeyPair, path: string, body: unknown) {
    const raw = JSON.stringify(body);
    const headers = { ...signRequest(keys, "POST", path, raw, clock), "content-type": "application/json" };
    const res = await app.fetch(new Request(`http://minga.test${path}`, { method: "POST", headers, body: raw }));
    return { status: res.status, body: (await res.json()) as any };
  }
  async function get(path: string) {
    const res = await app.fetch(new Request(`http://minga.test${path}`));
    return { status: res.status, body: (await res.json()) as any };
  }
  async function agent(model: string) {
    const keys = generateKeyPair();
    const j = await call(keys, "/api/join", { publicKey: keys.publicKey, model, harness: "adversarial" });
    if (j.status !== 200) throw new Error(`join failed: ${JSON.stringify(j.body)}`);
    return keys;
  }
  async function take(keys: KeyPair) {
    const n = await call(keys, "/api/next", {});
    const a = n.body.assignment;
    if (!a) throw new Error(`no assignment: ${JSON.stringify(n.body)}`);
    return { attempt: a.attempt as string, task: (a.task?.id ?? a.task) as string };
  }
  async function submit(keys: KeyPair, attempt: string, files: Record<string, string>) {
    const q = await call(keys, "/api/submit", { attempt, claim: "solves", message: "fix add", files });
    if (q.status !== 202) return q.body;
    return (await get(`/api/submission/${q.body.submission}?wait=30`)).body;
  }
  const branch = () => branchHead(repo, cfg.branch);
  async function startedChecks() {
    const ev = await get("/api/events");
    return ev.body.events.some((e: any) => e.type === "submission.started");
  }

  return { repo, base, head, cfg, app, pool, call, get, agent, take, submit, branch, startedChecks };
}

afterAll(async () => {
  for (const p of pools) await p.close().catch(() => undefined);
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
  delete process.env.SECRET_TOKEN;
});

/** GET /api/submission returns immediately while status is "review", so poll after an approval. */
async function waitFor(h: Harness, id: string, want: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = (await h.get(`/api/submission/${id}`)).body;
    if (v.status === want) return v;
    if (Date.now() >= deadline) throw new Error(`submission ${id} never reached ${want}: ${JSON.stringify(v)}`);
    await Bun.sleep(25);
  }
}

const dockerAvailable = (() => {
  try {
    // A Linux engine: Windows-containers mode (e.g. GitHub windows runners) cannot run the images.
    const info = Bun.spawnSync(["docker", "info", "--format", "{{.OSType}}"], { stdout: "pipe", stderr: "ignore" });
    return info.exitCode === 0 && info.stdout.toString().trim() === "linux";
  } catch {
    return false;
  }
})();

// ---------------------------------------------------------------- scenarios

test(
  "1. editing the test to expect the buggy value is refused (403 protected path), honest fix lands",
  async () => {
    const h = await setup({ protect: ["project.toml", "test/**", "package.json"] });
    const before = await h.branch();
    const a = await h.agent("cheat-1");
    const at = await h.take(a);

    const cheat = await h.call(a, "/api/submit", {
      attempt: at.attempt,
      claim: "solves",
      message: "align test",
      files: {
        "test/add.test.ts":
          'import { test, expect } from "bun:test";\nimport { add } from "../src/add";\ntest("adds", () => expect(add(2, 3)).toBe(-1));\n',
      },
    });
    expect(cheat.status).toBe(403);
    expect(cheat.body.error).toContain("path is protected: test/add.test.ts");
    expect(await h.branch()).toBe(before);
    expect(await h.startedChecks()).toBe(false);

    const honest = await h.submit(a, at.attempt, FIX);
    expect(honest.status).toBe("accepted");
    expect(await h.branch()).not.toBe(before);
  },
  60_000,
);

test(
  "2. emptying the test file is refused (403 protected path), honest fix lands",
  async () => {
    const h = await setup({ protect: ["project.toml", "test/**", "package.json"] });
    const before = await h.branch();
    const a = await h.agent("cheat-2");
    const at = await h.take(a);

    const cheat = await h.call(a, "/api/submit", {
      attempt: at.attempt,
      claim: "solves",
      message: "remove test",
      files: { "test/add.test.ts": "" },
    });
    expect(cheat.status).toBe(403);
    expect(cheat.body.error).toContain("path is protected: test/add.test.ts");
    expect(await h.branch()).toBe(before);
    expect(await h.startedChecks()).toBe(false);

    const honest = await h.submit(a, at.attempt, FIX);
    expect(honest.status).toBe("accepted");
    expect(await h.branch()).not.toBe(before);
  },
  60_000,
);

test(
  "3. forcing the test script to exit 0 in package.json is refused (403 protected path), honest fix lands",
  async () => {
    const h = await setup({ protect: ["project.toml", "test/**", "package.json"] });
    const before = await h.branch();
    const a = await h.agent("cheat-3");
    const at = await h.take(a);

    const cheat = await h.call(a, "/api/submit", {
      attempt: at.attempt,
      claim: "solves",
      message: "neutralize check",
      files: { "package.json": '{"name":"tiny","type":"module","scripts":{"test":"exit 0"}}\n' },
    });
    expect(cheat.status).toBe(403);
    expect(cheat.body.error).toContain("path is protected: package.json");
    expect(await h.branch()).toBe(before);
    expect(await h.startedChecks()).toBe(false);

    const honest = await h.submit(a, at.attempt, FIX);
    expect(honest.status).toBe("accepted");
    expect(await h.branch()).not.toBe(before);
  },
  60_000,
);

test(
  "4. a skipped new test is rejected by the gate before the check runs",
  async () => {
    const h = await setup({
      paths: ["src/**", "test/new/**"],
      protect: ["project.toml", "test/*.test.ts"],
      gates: {
        maxFiles: 0,
        maxChangedLines: 0,
        forbid: [{ pattern: "\\.(skip|only)\\(", paths: ["**/*.test.*"], reason: "focused or skipped test" }],
        warn: [],
      },
    });
    const before = await h.branch();
    const a = await h.agent("cheat-4");
    const at = await h.take(a);

    const cheat = await h.submit(a, at.attempt, {
      "test/new/skip.test.ts":
        'import { test, expect } from "bun:test";\ntest.skip("pretend", () => expect(true).toBe(true));\n',
    });
    expect(cheat.status).toBe("rejected");
    expect(cheat.gate.some((g: string) => g.includes("test/new/skip.test.ts"))).toBe(true);
    expect(cheat.gate.some((g: string) => g.includes("skipped test"))).toBe(true);
    expect(await h.startedChecks()).toBe(false);
    expect(await h.branch()).toBe(before);

    const honest = await h.submit(a, at.attempt, FIX);
    expect(honest.status).toBe("accepted");
    expect(await h.branch()).not.toBe(before);
  },
  60_000,
);

test(
  "5. hardcoding the visible answer passes the visible check but fails the holdout privately",
  async () => {
    const holdoutDir = mkdtempSync(pathJoin(tmpdir(), "minga-adv-holdout-"));
    scratch.push(holdoutDir);
    mkdirSync(pathJoin(holdoutDir, ".holdout"), { recursive: true });
    writeFileSync(
      pathJoin(holdoutDir, ".holdout", "add.hidden.test.ts"),
      'import { test, expect } from "bun:test";\nimport { add } from "../src/add";\ntest("hidden add", () => expect(add(10, 7)).toBe(17));\n',
    );
    // Bun 1.4 treats a leading-dot filter as a pattern, not a path, so the
    // holdout command needs the "./" prefix to actually find .holdout/.
    const h = await setup({ holdout: { command: "bun test ./.holdout/", dir: holdoutDir } });
    const before = await h.branch();
    const a = await h.agent("cheat-5");
    const at = await h.take(a);

    const cheat = await h.submit(a, at.attempt, { "src/add.ts": ADD_HARDCODED });
    expect(cheat.status).toBe("rejected");
    expect(cheat.holdout).toBe("failed");
    expect(cheat.outputTail).not.toContain("add.hidden");
    expect(cheat.outputTail).not.toContain("17");
    expect(await h.branch()).toBe(before);

    const events = (await h.get("/api/events")).body;
    const view = (await h.get("/api/view")).body;
    expect(JSON.stringify(events)).not.toContain("add.hidden");
    expect(JSON.stringify(view)).not.toContain("add.hidden");

    const honest = await h.submit(a, at.attempt, FIX);
    expect(honest.status).toBe("accepted");
    expect(honest.holdout).toBe("passed");
    expect(await h.branch()).not.toBe(before);
  },
  60_000,
);

test(
  "6. hardcoding lands only in review; the head rejects it and approves the honest fix with a trailer",
  async () => {
    const h = await setup({ review: { mode: "head" } });
    const before = await h.branch();
    const a = await h.agent("cheat-6");
    const at = await h.take(a);

    const cheat = await h.submit(a, at.attempt, { "src/add.ts": ADD_HARDCODED });
    expect(cheat.status).toBe("review");
    expect(await h.branch()).toBe(before);

    const rejected = await h.call(h.head, "/api/head/review", {
      submission: cheat.id,
      approve: false,
      reason: "hardcodes the visible answer",
    });
    expect(rejected.status).toBe(200);
    const afterReject = await h.get(`/api/submission/${cheat.id}`);
    expect(afterReject.body.status).toBe("rejected");
    expect(afterReject.body.outputTail).toContain("hardcodes the visible answer");
    expect(await h.branch()).toBe(before);

    // The author's attempt ended when the work moved to review; take a fresh one.
    const at2 = await h.take(a);
    const honest = await h.submit(a, at2.attempt, FIX);
    expect(honest.status).toBe("review");
    expect(await h.branch()).toBe(before);

    const approved = await h.call(h.head, "/api/head/review", {
      submission: honest.id,
      approve: true,
      reason: "actually adds",
    });
    expect(approved.status).toBe(200);
    const done = await waitFor(h, honest.id, "accepted");
    expect(done.review).toMatchObject({ approved: true, by: "head" });
    expect(await h.branch()).not.toBe(before);

    const message = git(h.repo, "log", "-1", "--format=%B", "minga");
    expect(message).toContain("Minga-Review: head");
  },
  60_000,
);

test(
  "7. suppressing a type error with @ts-ignore is rejected by the gate before the check runs",
  async () => {
    const h = await setup({
      gates: {
        maxFiles: 0,
        maxChangedLines: 0,
        forbid: [{ pattern: "@ts-(ignore|nocheck)", reason: "suppressed type error" }],
        warn: [],
      },
    });
    const before = await h.branch();
    const a = await h.agent("cheat-7");
    const at = await h.take(a);

    const cheat = await h.submit(a, at.attempt, {
      "src/add.ts": "// @ts-ignore\nexport const add = (a: number, b: number) => a + b;\n",
    });
    expect(cheat.status).toBe("rejected");
    expect(cheat.gate.some((g: string) => g.includes("@ts-ignore"))).toBe(true);
    expect(await h.startedChecks()).toBe(false);
    expect(await h.branch()).toBe(before);

    const honest = await h.submit(a, at.attempt, FIX);
    expect(honest.status).toBe("accepted");
    expect(await h.branch()).not.toBe(before);
  },
  60_000,
);

test(
  "8. a 200-line rewrite is rejected by the changed-lines gate before the check runs",
  async () => {
    const h = await setup({
      gates: { maxFiles: 0, maxChangedLines: 20, forbid: [], warn: [] },
    });
    const before = await h.branch();
    const a = await h.agent("cheat-8");
    const at = await h.take(a);

    const big =
      Array.from({ length: 200 }, (_, i) => `// rewritten line ${i}`).join("\n") + "\n" + ADD_HONEST;
    const cheat = await h.submit(a, at.attempt, { "src/add.ts": big });
    expect(cheat.status).toBe("rejected");
    expect(cheat.gate.some((g: string) => g.includes("changes") && g.includes("lines"))).toBe(true);
    expect(await h.startedChecks()).toBe(false);
    expect(await h.branch()).toBe(before);

    const honest = await h.submit(a, at.attempt, FIX);
    expect(honest.status).toBe("accepted");
    expect(await h.branch()).not.toBe(before);
  },
  60_000,
);

test(
  "9. self-review is refused: the author and a fresh agent with no accepted work both get 403",
  async () => {
    const h = await setup({ review: { mode: "head" } });
    const before = await h.branch();
    const author = await h.agent("cheat-9");
    const at = await h.take(author);
    const sub = await h.submit(author, at.attempt, FIX);
    expect(sub.status).toBe("review");

    const self = await h.call(author, "/api/review", { submission: sub.id, approve: true });
    expect(self.status).toBe(403);
    expect(self.body.error).toContain("author cannot vote");

    const stranger = await h.agent("stranger-9");
    const noWork = await h.call(stranger, "/api/review", { submission: sub.id, approve: true });
    expect(noWork.status).toBe(403);
    expect(noWork.body.error).toContain("no accepted work");

    expect(await h.branch()).toBe(before);

    const approved = await h.call(h.head, "/api/head/review", { submission: sub.id, approve: true });
    expect(approved.status).toBe(200);
    await waitFor(h, sub.id, "accepted");
    expect(await h.branch()).not.toBe(before);
  },
  60_000,
);

const MALICIOUS_ADD =
  'import { readFileSync } from "node:fs";\n' +
  'let seen = "";\n' +
  'try { seen += "HEAD1=" + readFileSync("../../head.json", "utf8") + ";"; } catch { seen += "HEAD1-ERR;"; }\n' +
  'try { seen += "HEAD2=" + readFileSync("../../../.minga/head.json", "utf8") + ";"; } catch { seen += "HEAD2-ERR;"; }\n' +
  'try { seen += "ENV=" + JSON.stringify(process.env) + ";"; } catch { seen += "ENV-ERR;"; }\n' +
  'try { const r = await fetch("http://example.com"); seen += "FETCHOK=" + r.status + ";"; } catch { seen += "FETCH-ERR;"; }\n' +
  'console.log("PROBE:" + seen);\n' +
  ADD_HONEST;

describe.skipIf(!dockerAvailable)("10. docker sandbox", () => {
  test(
    "a check that reads the maintainer key, the host env and the network sees none of them",
    async () => {
      const h = await setup({
        sandbox: {
          mode: "docker",
          image: "oven/bun:1",
          network: "none",
          memory: "1g",
          cpus: 1,
          pids: 256,
        },
      });
      const secret = "TOP-SECRET-HEAD-KEY-4f8c21";
      mkdirSync(pathJoin(h.repo, ".minga"), { recursive: true });
      writeFileSync(pathJoin(h.repo, ".minga", "head.json"), `{"key":"${secret}"}\n`);
      process.env.SECRET_TOKEN = "xyz";
      const before = await h.branch();

      // If oven/bun:1 cannot be pulled the pool fails closed; report and stop.
      const canary = await h.pool.run({ base: h.base, files: {}, command: "echo CANARY", timeoutSeconds: 30 });
      if (canary.outputTail.includes("docker is not available")) {
        console.log(`adversarial docker scenario skipped: ${canary.outputTail.trim()}`);
        return;
      }
      expect(canary.ok).toBe(true);

      const a = await h.agent("cheat-10");
      const at = await h.take(a);
      const result = await h.submit(a, at.attempt, { "src/add.ts": MALICIOUS_ADD });
      expect(result.status).toBe("accepted");
      expect(await h.branch()).not.toBe(before);
      expect(result.outputTail).toContain("1 pass");
      expect(result.outputTail).toContain("PROBE:"); // the probe really ran inside the check
      expect(result.outputTail).not.toContain(secret);
      expect(result.outputTail).not.toContain("xyz");
      expect(result.outputTail).not.toContain("FETCHOK");
    },
    180_000,
  );
});
