/**
 * The gate around the check: protected paths, diff gates, holdout tests and review.
 * Uses a fake pool and a fake branch, like server.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import type { CheckInput, CommitInput } from "../src/core/contracts.ts";
import type { ProjectConfig } from "../src/core/types.ts";
import { formatHeadKey, generateKeyPair, signRequest, type KeyPair } from "../src/identity/keys.ts";
import { openEventStore } from "../src/log/store.ts";
import { createApp } from "../src/server/app.ts";

type Over = Partial<Pick<ProjectConfig, "protect" | "gates" | "review" | "holdout">> & { oneTask?: boolean };

function setup(over: Over = {}) {
  const head = generateKeyPair();
  const repoDir = mkdtempSync(pathJoin(tmpdir(), "minga-safety-"));
  const cfg: ProjectConfig = {
    name: "demo", goal: "g", scope: "s", check: "check {files}", checkTimeoutSeconds: 30,
    paths: ["src/**", "test/**", "package.json"], head: formatHeadKey(head.publicKey), branch: "main",
    checkConcurrency: 1, checkKeep: [], recheck: "on-overlap",
    rules: {
      width: 3, leaseMinutes: 45, maxAttemptsPerAgent: 1,
      roles: { explore: 0, build: 1, attack: 0, distill: 0, plan: 0 },
      accept: { mode: "head-or-votes", votes: 1 }, defaultPoints: 10,
    },
    seedTasks: over.oneTask ? [{ title: "Fix add", body: "" }] : [{ title: "Fix add", body: "" }, { title: "Fix sub", body: "" }],
    protect: over.protect ?? ["project.toml"],
    gates: over.gates ?? { maxFiles: 0, maxChangedLines: 0, forbid: [], warn: [] },
    review: over.review ?? { mode: "none" },
    ...(over.holdout ? { holdout: over.holdout } : {}),
    sandbox: { mode: "none" },
  };
  let clock = Date.parse("2026-11-27T12:00:00Z");
  const checks: CheckInput[] = [];
  const commits: CommitInput[] = [];
  const history: { sha: string; files: Record<string, string> }[] = [{ sha: "c0", files: { "src/add.ts": "export const add = (a, b) => a - b;\n", "test/add.test.ts": "expect(add(1, 2)).toBe(3);\n" } }];
  const tip = () => history[history.length - 1]!.sha;
  const fileAt = (sha: string, path: string): string | null => {
    const i = history.findIndex((c) => c.sha === sha);
    for (let k = i; k >= 0; k--) if (Object.hasOwn(history[k]!.files, path)) return history[k]!.files[path]!;
    return null;
  };
  const store = openEventStore(":memory:");
  let holdoutPasses = true;
  const pool = {
    size: 1, busy: 0,
    async run(input: CheckInput) {
      checks.push(input);
      await Bun.sleep(1);
      if (input.overlayDir) {
        return holdoutPasses
          ? { ok: true, exitCode: 0, timedOut: false, outputTail: "SECRET-HOLDOUT-NAME passed", durationMs: 3 }
          : { ok: false, exitCode: 1, timedOut: false, outputTail: "FAIL SECRET-HOLDOUT-NAME expected 7", durationMs: 3 };
      }
      const ok = Object.values(input.files).some((c) => c.includes("a + b") || c.includes("PASS"));
      return { ok, exitCode: ok ? 0 : 1, timedOut: false, outputTail: ok ? "1 pass" : "1 fail", durationMs: 5 };
    },
  };
  const app = createApp({
    cfg, store, repoDir, pool, submissionsDir: pathJoin(repoDir, "subs"), joinLimitPerHour: 0,
    now: () => new Date(clock), rng: () => 0.5,
    branchHead: async () => tip(),
    changedPaths: async (_r, from, to) => {
      const i = history.findIndex((c) => c.sha === from);
      const j = history.findIndex((c) => c.sha === to);
      return history.slice(i + 1, j + 1).flatMap((c) => Object.keys(c.files));
    },
    commitAccepted: async (input) => {
      commits.push(input);
      if (input.parent !== tip()) return { ok: false, stale: true, head: tip() };
      const sha = `c${history.length}`;
      history.push({ sha, files: { ...input.files } });
      return { ok: true, commit: sha };
    },
    readFileAt: async (_r, sha, path) => fileAt(sha, path),
  });
  async function call(keys: KeyPair, path: string, body: unknown) {
    const raw = JSON.stringify(body);
    const headers = { ...signRequest(keys, "POST", path, raw, clock), "content-type": "application/json" };
    const res = await app.fetch(new Request(`http://minga.test${path}`, { method: "POST", headers, body: raw }));
    return { status: res.status, body: await res.json() as any };
  }
  async function get(path: string) {
    const res = await app.fetch(new Request(`http://minga.test${path}`));
    return { status: res.status, body: await res.json() as any };
  }
  async function agent(model: string) {
    const keys = generateKeyPair();
    await call(keys, "/api/join", { publicKey: keys.publicKey, model, harness: "t" });
    return keys;
  }
  async function take(keys: KeyPair) {
    const n = await call(keys, "/api/next", {});
    const a = n.body.assignment;
    return a ? { attempt: a.attempt as string, task: (a.task?.id ?? a.task) as string } : undefined!;
  }
  async function submit(keys: KeyPair, attempt: string, files: Record<string, string>) {
    const q = await call(keys, "/api/submit", { attempt, claim: "solves", message: "fix", files });
    if (q.status !== 202) return q;
    return get(`/api/submission/${q.body.submission}?wait=5`);
  }
  return {
    app, cfg, head, repoDir, checks, commits, history, call, get, agent, take, submit,
    tick: (ms: number) => { clock += ms; },
    failHoldout: () => { holdoutPasses = false; },
  };
}

const FIX = { "src/add.ts": "export const add = (a, b) => a + b;\n" };

describe("protected paths", () => {
  test("a submission that touches a protected test file is refused before anything runs", async () => {
    const s = setup({ protect: ["project.toml", "test/**", "package.json"] });
    const a = await s.agent("m-1");
    const at = await s.take(a);
    const r = await s.call(a, "/api/submit", { attempt: at.attempt, claim: "solves", message: "x", files: { "test/add.test.ts": "expect(true).toBe(true);\n" } });
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("path is protected: test/add.test.ts");
    const pkg = await s.call(a, "/api/submit", { attempt: at.attempt, claim: "solves", message: "x", files: { ...FIX, "package.json": "{}" } });
    expect(pkg.status).toBe(403);
    expect(s.checks).toHaveLength(0);
    // The attempt is still live: the agent can submit the honest fix.
    const ok = await s.submit(a, at.attempt, FIX);
    expect(ok.body.status).toBe("accepted");
  });

  test("project.toml is always protected", async () => {
    const s = setup();
    s.cfg.paths.push("*.toml");
    const a = await s.agent("m-1");
    const at = await s.take(a);
    const r = await s.call(a, "/api/submit", { attempt: at.attempt, claim: "solves", message: "x", files: { "project.toml": "check = \"true\"" } });
    expect(r.status).toBe(403);
  });

  test("the project's safety settings are public", async () => {
    const s = setup({ protect: ["project.toml", "test/**"], review: { mode: "head" } });
    const p = await s.get("/api/project");
    expect(p.body.safety).toMatchObject({ protect: ["project.toml", "test/**"], review: { mode: "head" }, holdout: false, sandbox: "none" });
  });
});

describe("gates", () => {
  test("a forbidden pattern on an added line rejects before the check runs", async () => {
    const s = setup({ gates: { maxFiles: 0, maxChangedLines: 0, forbid: [{ pattern: "@ts-ignore", reason: "no suppressions" }], warn: [] } });
    const a = await s.agent("m-1");
    const at = await s.take(a);
    const r = await s.submit(a, at.attempt, { "src/add.ts": "// @ts-ignore\nexport const add = (a, b) => a + b;\n" });
    expect(r.body.status).toBe("rejected");
    expect(r.body.gate[0]).toContain("src/add.ts:1");
    expect(r.body.outputTail).toContain("gates");
    expect(s.checks).toHaveLength(0);
  });

  test("a file limit rejects; warnings only flag", async () => {
    const s = setup({ gates: { maxFiles: 1, maxChangedLines: 0, forbid: [], warn: [{ pattern: "TODO" }] } });
    const a = await s.agent("m-1");
    let at = await s.take(a);
    const two = await s.submit(a, at.attempt, { ...FIX, "src/b.ts": "x\n" });
    expect(two.body.status).toBe("rejected");
    expect(two.body.gate[0]).toContain("writes 2 files");
    at = await s.take(a) ?? at;
    const one = await s.submit(a, at.attempt, { "src/add.ts": "export const add = (a, b) => a + b; // TODO\n" });
    expect(one.body.status).toBe("accepted");
    expect(one.body.warnings?.[0]).toContain("TODO");
  });
});

describe("holdout", () => {
  test("holdout output never reaches agents; the maintainer gets it in .minga/holdout-logs", async () => {
    const s = setup();
    const dir = pathJoin(s.repoDir, "hold");
    mkdirSync(dir, { recursive: true });
    writeFileSync(pathJoin(dir, "secret.test.ts"), "secret");
    const s2 = setup({ holdout: { command: "bun test hidden/", dir } });
    s2.failHoldout();
    const a = await s2.agent("m-1");
    const at = await s2.take(a);
    const r = await s2.submit(a, at.attempt, FIX);
    expect(r.body.status).toBe("rejected");
    expect(r.body.holdout).toBe("failed");
    expect(r.body.outputTail).toContain("holdout tests failed");
    expect(r.body.outputTail).not.toContain("SECRET-HOLDOUT-NAME");
    // Second run got the overlay; the first did not.
    expect(s2.checks.map((c) => !!c.overlayDir)).toEqual([false, true]);
    // Nothing secret anywhere in the public log or view.
    const events = await s2.get("/api/events");
    expect(JSON.stringify(events.body)).not.toContain("SECRET-HOLDOUT-NAME");
    const view = await s2.get("/api/view");
    expect(JSON.stringify(view.body)).not.toContain("SECRET-HOLDOUT-NAME");
    const log = readFileSync(pathJoin(s2.repoDir, ".minga", "holdout-logs", `${r.body.id}.txt`), "utf8");
    expect(log).toContain("SECRET-HOLDOUT-NAME");
  });

  test("a passing holdout lets the work land and records it", async () => {
    const s = setup({ holdout: { command: "bun test hidden/", dir: tmpdir() } });
    const a = await s.agent("m-1");
    const at = await s.take(a);
    const r = await s.submit(a, at.attempt, FIX);
    expect(r.body.status).toBe("accepted");
    expect(r.body.holdout).toBe("passed");
    expect(r.body.outputTail).not.toContain("SECRET-HOLDOUT-NAME");
  });
});

describe("review", () => {
  test("head review: passing work waits, the attempt ends, nothing lands until the head approves", async () => {
    const s = setup({ review: { mode: "head" } });
    const a = await s.agent("m-1");
    const at = await s.take(a);
    const r = await s.submit(a, at.attempt, FIX);
    expect(r.body.status).toBe("review");
    expect(s.commits).toHaveLength(0);
    expect(s.app.state.attempts[at.attempt]!.endedAt).toBeDefined();
    expect(s.app.state.tasks[at.task]!.status).toBe("open");

    const list = await s.get("/api/reviews");
    expect(list.body.reviews.map((x: any) => x.submission)).toEqual([r.body.id]);
    const detail = await s.get(`/api/review/${r.body.id}`);
    expect(detail.body.diffs[0].diff).toContain("-export const add = (a, b) => a - b;");
    expect(detail.body.diffs[0].diff).toContain("+export const add = (a, b) => a + b;");

    // The author cannot review their own work; a stranger with no accepted work cannot vote.
    const self = await s.call(a, "/api/review", { submission: r.body.id, approve: true });
    expect(self.status).toBe(403);

    const ok = await s.call(s.head, "/api/head/review", { submission: r.body.id, approve: true, reason: "looks right" });
    expect(ok.status).toBe(200);
    const done = await s.get(`/api/submission/${r.body.id}?wait=5`);
    expect(done.body.status).toBe("accepted");
    expect(done.body.review).toMatchObject({ approved: true, by: "head" });
    expect(s.commits).toHaveLength(1);
    expect(s.commits[0]!.trailers["Minga-Review"]).toBe("head");
    expect(s.app.state.tasks[at.task]!.status).toBe("solved");
    expect(s.app.state.agents[s.app.state.submissions[r.body.id]!.agent]!.points).toBeGreaterThan(0);
  });

  test("head rejection is final and says why", async () => {
    const s = setup({ review: { mode: "head" } });
    const a = await s.agent("m-1");
    const at = await s.take(a);
    const r = await s.submit(a, at.attempt, { "src/add.ts": "// PASS\nexport const add = () => 3;\n" });
    expect(r.body.status).toBe("review");
    const no = await s.call(s.head, "/api/head/review", { submission: r.body.id, approve: false, reason: "hardcodes the test answer" });
    expect(no.body.decided).toEqual({ approved: false, by: "head" });
    const v = await s.get(`/api/submission/${r.body.id}`);
    expect(v.body.status).toBe("rejected");
    expect(v.body.outputTail).toContain("hardcodes the test answer");
    expect(s.commits).toHaveLength(0);
    expect(s.app.state.tasks[at.task]!.status).toBe("open");
  });

  test("approval after the branch moved on other files lands without a recheck; on the same file it rechecks", async () => {
    const s = setup({ review: { mode: "head" } });
    const a = await s.agent("m-1");
    const at = await s.take(a);
    const r = await s.submit(a, at.attempt, FIX);
    s.history.push({ sha: "x1", files: { "src/other.ts": "y" } });
    const before = s.checks.length;
    await s.call(s.head, "/api/head/review", { submission: r.body.id, approve: true });
    const done = await s.get(`/api/submission/${r.body.id}?wait=5`);
    expect(done.body.status).toBe("accepted");
    expect(s.checks.length).toBe(before); // no recheck
    expect(s.commits.at(-1)!.parent).toBe("x1");

    const s2 = setup({ review: { mode: "head" } });
    const b = await s2.agent("m-2");
    const bt = await s2.take(b);
    const r2 = await s2.submit(b, bt.attempt, FIX);
    s2.history.push({ sha: "x1", files: { "src/add.ts": "export const add = (a, b) => b + a;\n" } });
    const before2 = s2.checks.length;
    await s2.call(s2.head, "/api/head/review", { submission: r2.body.id, approve: true });
    const done2 = await s2.get(`/api/submission/${r2.body.id}?wait=5`);
    expect(done2.body.status).toBe("accepted");
    expect(s2.checks.length).toBe(before2 + 1); // rechecked on the new head
  });

  test("vote review: eligible agents decide; rivals on the task and the author cannot", async () => {
    const s = setup({ review: { mode: "votes", votes: 1 } });
    // A reviewer needs accepted work: give one agent an accepted solve on the second task first,
    // through a temporary head approval.
    const author = await s.agent("m-a");
    const rival = await s.agent("m-r");
    const reviewer = await s.agent("m-v");
    const atR = await s.take(reviewer);
    const pre = await s.submit(reviewer, atR.attempt, FIX);
    await s.call(s.head, "/api/head/review", { submission: pre.body.id, approve: true });
    await s.get(`/api/submission/${pre.body.id}?wait=5`);
    expect(s.app.state.agents[s.app.state.submissions[pre.body.id]!.agent]!.accepted).toBe(1);

    const atA = await s.take(author);
    const atRival = await s.take(rival);
    expect(atRival.task).toBe(atA.task);
    const r = await s.submit(author, atA.attempt, { "src/sub.ts": "PASS\n" });
    expect(r.body.status).toBe("review");
    const byRival = await s.call(rival, "/api/review", { submission: r.body.id, approve: false, reason: "mine is better" });
    expect(byRival.status).toBe(403);
    const vote = await s.call(reviewer, "/api/review", { submission: r.body.id, approve: true, reason: "minimal and correct" });
    expect(vote.body.decided).toEqual({ approved: true, by: "vote" });
    const done = await s.get(`/api/submission/${r.body.id}?wait=5`);
    expect(done.body.status).toBe("accepted");
    expect(done.body.review.by).toBe("vote");
  });

  test("work in review on a task that another submission solved finishes as stale", async () => {
    const s = setup({ review: { mode: "head" }, oneTask: true });
    const a = await s.agent("m-a");
    const b = await s.agent("m-b");
    const atA = await s.take(a);
    const atB = await s.take(b);
    expect(atB.task).toBe(atA.task);
    const ra = await s.submit(a, atA.attempt, FIX);
    const rb = await s.submit(b, atB.attempt, { "src/add.ts": "export const add = (a, b) => b + a; // PASS\n" });
    expect(ra.body.status).toBe("review");
    expect(rb.body.status).toBe("review");
    await s.call(s.head, "/api/head/review", { submission: ra.body.id, approve: true });
    await s.get(`/api/submission/${ra.body.id}?wait=5`);
    const vb = await s.get(`/api/submission/${rb.body.id}`);
    expect(vb.body.status).toBe("rejected");
    expect(vb.body.stale).toBe(true);
    expect((await s.get("/api/reviews")).body.reviews).toEqual([]);
  });

  test("review = none keeps the 0.2 behaviour, and review routes say so", async () => {
    const s = setup();
    const a = await s.agent("m-1");
    const at = await s.take(a);
    const r = await s.submit(a, at.attempt, FIX);
    expect(r.body.status).toBe("accepted");
    const h = await s.call(s.head, "/api/head/review", { submission: r.body.id, approve: true });
    expect(h.status).toBe(409);
  });
});
