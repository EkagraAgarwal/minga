import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import type { CheckInput, CommitInput } from "../src/core/contracts.ts";
import type { ProjectConfig } from "../src/core/types.ts";
import { formatHeadKey, generateKeyPair, signRequest, type KeyPair } from "../src/identity/keys.ts";
import { openEventStore } from "../src/log/store.ts";
import { createApp } from "../src/server/app.ts";

function setup(over: Partial<ProjectConfig["rules"]> = {}, opts: { poolSize?: number; recheck?: ProjectConfig["recheck"]; joinLimitPerHour?: number } = {}) {
  const head = generateKeyPair();
  const cfg: ProjectConfig = {
    name: "demo", goal: "Prove things", scope: "Edit only proofs/.", check: "check {files}", checkTimeoutSeconds: 30,
    paths: ["proofs/**"], head: formatHeadKey(head.publicKey), branch: "main",
    checkConcurrency: opts.poolSize ?? 1, checkKeep: [], recheck: opts.recheck ?? "always",
    rules: {
      width: 2, leaseMinutes: 45, maxAttemptsPerAgent: 1,
      roles: { explore: 0, build: 1, attack: 0, distill: 0, plan: 0 },
      accept: { mode: "head-or-votes", votes: 1 }, defaultPoints: 10, ...over,
    },
    seedTasks: [
      { key: "a", title: "Area A", body: "" },
      { title: "Lemma one", body: "prove it", under: "a", points: 40 },
      { title: "Lemma two", body: "prove it too", under: "a" },
    ],
  };
  let clock = Date.parse("2026-11-26T12:00:00Z");
  const checks: CheckInput[] = [];
  const commits: CommitInput[] = [];
  // A fake branch: a list of commits, each with the paths it touched.
  const history: { sha: string; files: string[] }[] = [{ sha: "c0", files: [] }];
  const tip = () => history[history.length - 1]!.sha;
  const store = openEventStore(":memory:");
  const submissionsDir = mkdtempSync(pathJoin(tmpdir(), "minga-subs-"));
  let seed = 1;
  let gate: Promise<void> | null = null;
  let running = 0;
  let maxRunning = 0;
  const poolSize = opts.poolSize ?? 1;
  const pool = {
    size: poolSize,
    get busy() { return running; },
    async run(input: CheckInput) {
      checks.push(input);
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      try {
        if (gate) await gate;
        await Bun.sleep(1);
        const ok = Object.values(input.files).some((c) => c.includes("QED"));
        return { ok, exitCode: ok ? 0 : 1, timedOut: false, outputTail: ok ? "" : "error: unsolved goals", durationMs: 5 };
      } finally {
        running -= 1;
      }
    },
  };
  const make = () => createApp({
    cfg, store, repoDir: "/repo", pool, submissionsDir,
    joinLimitPerHour: opts.joinLimitPerHour ?? 0,
    now: () => new Date(clock),
    rng: () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; },
    branchHead: async () => tip(),
    changedPaths: async (_repo, from, to) => {
      const i = history.findIndex((c) => c.sha === from);
      const j = history.findIndex((c) => c.sha === to);
      return history.slice(i + 1, j + 1).flatMap((c) => c.files);
    },
    commitAccepted: async (input) => {
      commits.push(input);
      if (input.parent !== tip()) return { ok: false, stale: true, head: tip() };
      const sha = `c${history.length}`;
      history.push({ sha, files: Object.keys(input.files) });
      return { ok: true, commit: sha };
    },
  });
  const app = make();
  async function call(keys: KeyPair, path: string, body: unknown, o: { tamper?: boolean; ip?: string; app?: ReturnType<typeof make> } = {}) {
    const raw = JSON.stringify(body);
    const headers = { ...signRequest(keys, "POST", path, raw, clock), "content-type": "application/json" };
    const res = await (o.app ?? app).fetch(new Request(`http://minga.test${path}`, { method: "POST", headers, body: o.tamper ? raw + " " : raw }), o.ip);
    return { status: res.status, body: await res.json() as any };
  }
  async function get(path: string, a = app) {
    const res = await a.fetch(new Request(`http://minga.test${path}`));
    return { status: res.status, body: await res.json() as any };
  }
  return {
    cfg, app, make, store, head, call, get, checks, commits, history,
    tick: (ms: number) => { clock += ms; },
    maxRunning: () => maxRunning,
    /** Simulates a commit landing from elsewhere, touching `files`. */
    landCommit: (files: string[]) => { history.push({ sha: `c${history.length}`, files }); },
    /** Holds every check until the returned function is called. */
    holdChecks: () => { let release!: () => void; gate = new Promise((r) => { release = r; }); return () => { gate = null; release(); }; },
  };
}

type S = ReturnType<typeof setup>;
const join = (s: S, keys: KeyPair, model: string) =>
  s.call(keys, "/api/join", { publicKey: keys.publicKey, model, harness: "test-harness" });
/** Submits and waits for the verdict through the long-poll route. */
async function submitAndWait(s: S, keys: KeyPair, attempt: string, content: string, claim = "solves", file = "proofs/x.lean") {
  const q = await s.call(keys, "/api/submit", { attempt, claim, message: "try", files: { [file]: content } });
  if (q.status !== 202) return q;
  return s.get(`/api/submission/${q.body.submission}?wait=5`);
}

describe("server", () => {
  test("seeds tasks from config once", async () => {
    const s = setup();
    expect(Object.keys(s.app.state.tasks)).toEqual(["T-1", "T-2", "T-3"]);
    expect(s.app.state.tasks["T-2"]!.parent).toBe("T-1");
    const again = s.make();
    expect(Object.keys(again.state.tasks)).toHaveLength(3);
  });

  test("join, next, note, then a failing and a passing submission through the queue", async () => {
    const s = setup();
    const a = generateKeyPair();
    const j = await join(s, a, "claude-opus-5.5");
    expect(j.status).toBe(200);
    expect(j.body.rejoin).toBe(false);
    const asg = (await s.call(a, "/api/next", {})).body.assignment;
    expect(["T-2", "T-3"]).toContain(asg.task.id);
    expect(asg.path[0].title).toBe("Area A");
    expect((await s.call(a, "/api/note", { task: asg.task.id, kind: "idea", text: "try induction" })).status).toBe(200);

    const q = await s.call(a, "/api/submit", { attempt: asg.attempt, claim: "solves", message: "first try", files: { "proofs/x.lean": "sorry" } });
    expect(q.status).toBe(202);
    expect(q.body).toEqual({ submission: "S-1", status: "queued", position: 1 });
    const bad = await s.get("/api/submission/S-1?wait=5");
    expect(bad.body.status).toBe("rejected");
    expect(bad.body.outputTail).toContain("unsolved");
    expect(s.commits).toHaveLength(0);

    const good = await submitAndWait(s, a, asg.attempt, "QED");
    expect(good.body.status).toBe("accepted");
    expect(good.body.commit).toBe("c1");
    expect(good.body.base).toBe("c0");
    expect(s.app.state.tasks[asg.task.id]!.status).toBe("solved");
    expect(s.commits[0]!.trailers["Agent-Model"]).toBe("claude-opus-5.5");
    expect(s.commits[0]!.parent).toBe("c0");
    const lb = await s.get("/api/leaderboard");
    expect(lb.body.agents[0].agent).toBe(j.body.agent);
    expect(lb.body.agents[0].points).toBe(asg.task.points);
    expect(s.app.state.attempts[asg.attempt]!.endReason).toBe("submitted");
  });

  test("a second submission on the same attempt is refused while the first is queued", async () => {
    const s = setup();
    const a = generateKeyPair();
    await join(s, a, "gpt-6");
    const asg = (await s.call(a, "/api/next", {})).body.assignment;
    const release = s.holdChecks();
    expect((await s.call(a, "/api/submit", { attempt: asg.attempt, claim: "solves", message: "1", files: { "proofs/x.lean": "QED" } })).status).toBe(202);
    const dup = await s.call(a, "/api/submit", { attempt: asg.attempt, claim: "solves", message: "2", files: { "proofs/x.lean": "QED" } });
    expect(dup.status).toBe(409);
    expect((await s.call(a, "/api/release", { attempt: asg.attempt })).status).toBe(409);
    release();
    await s.app.idle();
  });

  test("two passing submissions on one task: one wins, the other is stale without a second check", async () => {
    const s = setup({}, { poolSize: 4 });
    await s.call(s.head, "/api/head/close", { task: "T-3", status: "withdrawn" });
    const a = generateKeyPair(), b = generateKeyPair();
    await join(s, a, "claude-opus-5.5");
    await join(s, b, "gpt-6");
    const ta = (await s.call(a, "/api/next", {})).body.assignment;
    const tb = (await s.call(b, "/api/next", {})).body.assignment;
    expect([ta.task.id, tb.task.id]).toEqual(["T-2", "T-2"]);
    const release = s.holdChecks();
    const qa = await s.call(a, "/api/submit", { attempt: ta.attempt, claim: "solves", message: "a", files: { "proofs/a.lean": "QED" } });
    const qb = await s.call(b, "/api/submit", { attempt: tb.attempt, claim: "solves", message: "b", files: { "proofs/b.lean": "QED" } });
    expect(qb.body.position).toBe(1); // a is already checking, so b is first in line
    // While queued, attempts keep their slot past the lease.
    s.tick(50 * 60_000);
    expect(s.app.sweep()).toBe(0);
    // One check per task at a time, even with free slots.
    await Bun.sleep(10);
    expect(s.checks).toHaveLength(1);
    release();
    await s.app.idle();
    const ra = (await s.get(`/api/submission/${qa.body.submission}`)).body;
    const rb = (await s.get(`/api/submission/${qb.body.submission}`)).body;
    expect(ra.status).toBe("accepted");
    expect(rb.status).toBe("rejected");
    expect(rb.stale).toBe(true);
    expect(s.checks).toHaveLength(1);
    expect(s.commits).toHaveLength(1);
    expect(Object.values(s.app.state.submissions).filter((x) => x.points > 0)).toHaveLength(1);
    expect(s.app.state.attempts[tb.attempt]!.endedAt).toBeDefined();
  });

  test("checks on different tasks run in parallel; a moved branch triggers a recheck", async () => {
    const s = setup({}, { poolSize: 2 });
    const a = generateKeyPair(), b = generateKeyPair();
    await join(s, a, "claude-opus-5.5");
    await join(s, b, "gpt-6");
    const ta = (await s.call(a, "/api/next", {})).body.assignment;
    const tb = (await s.call(b, "/api/next", {})).body.assignment;
    expect(ta.task.id).not.toBe(tb.task.id);
    const release = s.holdChecks();
    const qa = await s.call(a, "/api/submit", { attempt: ta.attempt, claim: "solves", message: "a", files: { "proofs/a.lean": "QED" } });
    const qb = await s.call(b, "/api/submit", { attempt: tb.attempt, claim: "solves", message: "b", files: { "proofs/b.lean": "QED" } });
    await Bun.sleep(10);
    expect(s.maxRunning()).toBe(2);
    release();
    await s.app.idle();
    const results = [(await s.get(`/api/submission/${qa.body.submission}`)).body, (await s.get(`/api/submission/${qb.body.submission}`)).body];
    expect(results.map((r) => r.status)).toEqual(["accepted", "accepted"]);
    // Both started on c0; whichever committed second had to recheck on the new head.
    expect(s.checks).toHaveLength(3);
    expect(results.map((r) => r.runs).sort()).toEqual([1, 2]);
    expect(s.history.map((c) => c.sha)).toEqual(["c0", "c1", "c2"]);
  });

  test('recheck = "on-overlap" lands disjoint work on the new head without rechecking', async () => {
    const s = setup({}, { recheck: "on-overlap" });
    const a = generateKeyPair();
    await join(s, a, "claude-opus-5.5");
    const ta = (await s.call(a, "/api/next", {})).body.assignment;
    const release = s.holdChecks();
    const q = await s.call(a, "/api/submit", { attempt: ta.attempt, claim: "solves", message: "a", files: { "proofs/a.lean": "QED" } });
    await Bun.sleep(5);
    s.landCommit(["proofs/other.lean"]);
    release();
    const r = (await s.get(`/api/submission/${q.body.submission}?wait=5`)).body;
    expect(r.status).toBe("accepted");
    expect(r.runs).toBe(1);
    expect(s.commits.map((c) => c.parent)).toEqual(["c0", "c1"]);

    // An overlapping change forces a recheck.
    const b = generateKeyPair();
    await join(s, b, "gpt-6");
    const tb = (await s.call(b, "/api/next", {})).body.assignment;
    const release2 = s.holdChecks();
    const q2 = await s.call(b, "/api/submit", { attempt: tb.attempt, claim: "solves", message: "b", files: { "proofs/b.lean": "QED" } });
    await Bun.sleep(5);
    s.landCommit(["proofs/b.lean"]);
    release2();
    const r2 = (await s.get(`/api/submission/${q2.body.submission}?wait=5`)).body;
    expect(r2.status).toBe("accepted");
    expect(r2.runs).toBe(2);
  });

  test("queued submissions survive a restart", async () => {
    const s = setup();
    const a = generateKeyPair();
    await join(s, a, "claude-opus-5.5");
    const ta = (await s.call(a, "/api/next", {})).body.assignment;
    const release = s.holdChecks();
    const q = await s.call(a, "/api/submit", { attempt: ta.attempt, claim: "solves", message: "a", files: { "proofs/a.lean": "QED" } });
    // A new app over the same log picks the queued submission up again.
    release();
    await s.app.idle();
    const fresh = s.make();
    expect(fresh.state.submissions[q.body.submission]!.status).toBe("accepted");
    expect(fresh.state.index.pendingSubmissions).toHaveLength(0);
  });

  test("next long-polls until capacity frees up", async () => {
    const s = setup({ width: 1 });
    const a = generateKeyPair(), b = generateKeyPair(), c = generateKeyPair();
    for (const [k, m] of [[a, "claude-opus-5.5"], [b, "gpt-6"], [c, "kimi-k3"]] as const) await join(s, k, m);
    const ta = (await s.call(a, "/api/next", {})).body.assignment;
    expect((await s.call(b, "/api/next", {})).body.assignment).not.toBeNull();
    // Both leaves are full: c waits.
    const t0 = Date.now();
    const pending = s.call(c, "/api/next", { wait: 5 });
    await Bun.sleep(30);
    expect(s.app.metrics().waiting).toBe(1);
    await s.call(a, "/api/release", { attempt: ta.attempt, handoff: "stuck at the base case" });
    const got = await pending;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(got.body.assignment.task.id).toBe(ta.task.id);
    expect(got.body.assignment.handoff.text).toBe("stuck at the base case");
  });

  test("next long-poll times out with retryAfterSeconds 0", async () => {
    const s = setup({ width: 1 });
    await s.call(s.head, "/api/head/close", { task: "T-3", status: "withdrawn" });
    const a = generateKeyPair(), b = generateKeyPair();
    await join(s, a, "x");
    await join(s, b, "y");
    await s.call(a, "/api/next", {});
    const r = await s.call(b, "/api/next", { wait: 0.05 });
    expect(r.body).toEqual({ assignment: null, retryAfterSeconds: 0 });
    expect(s.app.metrics().waiting).toBe(0);
  });

  test("rejects bad signatures, replays, unknown agents and disallowed paths", async () => {
    const s = setup();
    const a = generateKeyPair();
    await join(s, a, "gpt-6");
    expect((await s.call(a, "/api/next", {}, { tamper: true })).status).toBe(401);
    expect((await s.call(generateKeyPair(), "/api/next", {})).status).toBe(401);
    const raw = JSON.stringify({});
    const headers = signRequest(a, "POST", "/api/next", raw, Date.parse("2026-11-26T12:00:00Z"));
    const r1 = await s.app.fetch(new Request("http://minga.test/api/next", { method: "POST", headers, body: raw }));
    const r2 = await s.app.fetch(new Request("http://minga.test/api/next", { method: "POST", headers, body: raw }));
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(401);
    const att = ((await r1.json()) as any).assignment.attempt;
    expect((await s.call(a, "/api/submit", { attempt: att, claim: "solves", message: "x", files: { "../etc/passwd": "QED" } })).status).toBe(400);
    expect((await s.call(a, "/api/submit", { attempt: att, claim: "solves", message: "x", files: { ".minga/agent.json": "QED" } })).status).toBe(400);
    expect(s.checks).toHaveLength(0);
  });

  test("joins are limited per IP, rejoins are not", async () => {
    const s = setup({}, { joinLimitPerHour: 2 });
    const keys = [generateKeyPair(), generateKeyPair(), generateKeyPair()];
    const ip = "203.0.113.7";
    const j = async (k: KeyPair) => s.call(k, "/api/join", { publicKey: k.publicKey, model: "m", harness: "h" }, { ip });
    expect((await j(keys[0]!)).status).toBe(200);
    expect((await j(keys[1]!)).status).toBe(200);
    expect((await j(keys[2]!)).status).toBe(429);
    expect((await j(keys[0]!)).status).toBe(200);
    s.tick(61 * 60_000);
    expect((await j(keys[2]!)).status).toBe(200);
  });

  test("width and model diversity spread agents out", async () => {
    const s = setup();
    const keys = [generateKeyPair(), generateKeyPair(), generateKeyPair(), generateKeyPair(), generateKeyPair()];
    const models = ["claude-opus-5.5", "claude-sonnet-5.5", "gpt-6", "gemini-4", "kimi-k3"];
    const got: string[] = [];
    for (let i = 0; i < keys.length; i++) {
      await join(s, keys[i]!, models[i]!);
      const n = await s.call(keys[i]!, "/api/next", {});
      got.push(n.body.assignment ? n.body.assignment.task.id : "none");
    }
    expect(got.filter((g) => g === "none")).toHaveLength(1);
    expect(got.filter((g) => g === "T-2")).toHaveLength(2);
    expect(got.filter((g) => g === "T-3")).toHaveLength(2);
    expect(got[0]).not.toBe(got[1]);
  });

  test("leases expire, beat after expiry is refused, hand-off reaches the next agent", async () => {
    const s = setup();
    const a = generateKeyPair(), b = generateKeyPair();
    await join(s, a, "claude-opus-5.5");
    const asg = (await s.call(a, "/api/next", {})).body.assignment;
    await s.call(a, "/api/release", { attempt: asg.attempt, handoff: "base case done" });
    expect(s.app.state.attempts[asg.attempt]!.endReason).toBe("released");
    await join(s, b, "claude-opus-5.5");
    const second = (await s.call(b, "/api/next", {})).body.assignment;
    if (second.task.id === asg.task.id) expect(second.handoff.text).toBe("base case done");
    s.tick(46 * 60_000);
    expect((await s.call(b, "/api/beat", { attempt: second.attempt })).status).toBe(410);
    expect(s.app.sweep()).toBe(1);
    expect(s.app.state.attempts[second.attempt]!.endReason).toBe("expired");
  });

  test("proposals: head accepts, votes decide, impossible closes the task", async () => {
    const s = setup();
    const a = generateKeyPair(), b = generateKeyPair();
    await join(s, a, "claude-opus-5.5");
    await join(s, b, "gpt-6");
    const p1 = await s.call(a, "/api/propose", { kind: "new_task", task: "T-1", title: "Lemma three", body: "split from T-2" });
    expect(p1.body.proposal).toBe("P-1");
    expect((await s.call(a, "/api/head/decide", { proposal: "P-1", accept: true })).status).toBe(403);
    const d = await s.call(s.head, "/api/head/decide", { proposal: "P-1", accept: true });
    expect(d.body.task).toBe("T-4");
    expect(s.app.state.tasks["T-4"]!.parent).toBe("T-1");

    const asg = (await s.call(b, "/api/next", {})).body.assignment;
    expect((await submitAndWait(s, b, asg.attempt, "QED")).body.status).toBe("accepted");
    const open = ["T-2", "T-3", "T-4"].find((t) => s.app.state.tasks[t]!.status === "open")!;
    const p2 = await s.call(a, "/api/propose", { kind: "impossible", task: open, evidence: "counterexample at n=3" });
    expect((await s.call(a, "/api/vote", { proposal: p2.body.proposal, approve: true })).status).toBe(403);
    const v = await s.call(b, "/api/vote", { proposal: p2.body.proposal, approve: true });
    expect(v.body.decided).toEqual({ accepted: true, by: "vote" });
    expect(s.app.state.tasks[open]!.status).toBe("impossible");
  });

  test("head rules, ban and close", async () => {
    const s = setup();
    const a = generateKeyPair();
    const j = await join(s, a, "claude-opus-5.5");
    const r = await s.call(s.head, "/api/head/rule", { rules: { width: 5, accept: "votes:2" } });
    expect(r.body.rules.width).toBe(5);
    expect(r.body.rules.accept).toEqual({ mode: "votes", votes: 2 });
    expect((await s.call(s.head, "/api/head/rule", { rules: { width: 0 } })).status).toBe(400);
    expect((await s.call(s.head, "/api/head/close", { task: "T-3", status: "withdrawn" })).status).toBe(200);
    expect(s.app.state.tasks["T-3"]!.status).toBe("withdrawn");
    expect(s.app.state.tasks["T-1"]!.status).toBe("open");
    expect((await s.call(s.head, "/api/head/close", { task: "T-2", status: "solved" })).status).toBe(200);
    expect(s.app.state.tasks["T-1"]!.status).toBe("solved");
    await s.call(a, "/api/next", {});
    expect((await s.call(s.head, "/api/head/ban", { agent: j.body.agent, reason: "spam" })).status).toBe(200);
    expect((await s.call(a, "/api/next", {})).status).toBe(403);
    expect(Object.values(s.app.state.attempts).every((x) => x.endedAt)).toBe(true);
  });

  test("state replays identically; view and metrics are bounded snapshots", async () => {
    const s = setup();
    const a = generateKeyPair();
    await join(s, a, "claude-opus-5.5");
    const asg = (await s.call(a, "/api/next", {})).body.assignment;
    await submitAndWait(s, a, asg.attempt, "QED");
    const replayed = s.make();
    expect(replayed.state).toEqual(s.app.state);
    const view = (await s.get("/api/view")).body;
    expect(view.project.name).toBe("demo");
    expect(view.seq).toBe(s.app.state.seq);
    expect(view.leaderboard.agents).toHaveLength(1);
    expect(view.totals.accepted).toBe(1);
    expect(view.submissions[0].outputTail).toBeUndefined();
    const m = (await s.get("/api/metrics")).body;
    expect(m.queue.concurrency).toBe(1);
    expect(m.requests["POST /api/next"]).toBe(1);
    expect(m.statuses["2xx"]).toBeGreaterThan(0);
  });

  test("next reports done when no open leaf is left, and wakes waiters with done", async () => {
    const s = setup({ width: 1 });
    const a = generateKeyPair(), b = generateKeyPair();
    await join(s, a, "x");
    await join(s, b, "y");
    await s.call(s.head, "/api/head/close", { task: "T-3", status: "withdrawn" });
    const ta = (await s.call(a, "/api/next", {})).body.assignment;
    const waiting = s.call(b, "/api/next", { wait: 5 });
    await Bun.sleep(20);
    expect(s.app.metrics().waiting).toBe(1);
    expect((await submitAndWait(s, a, ta.attempt, "QED")).body.status).toBe("accepted");
    expect((await waiting).body).toEqual({ assignment: null, done: true });
    expect((await s.call(b, "/api/next", { wait: 5 })).body).toEqual({ assignment: null, done: true });
    const tasks = (await s.get("/api/tasks")).body;
    expect(tasks.done).toBe(true);
    expect(tasks.tasks.find((t: any) => t.id === "T-2").status).toBe("solved");
  });

  test("metrics report server-side latency and skip long-polled requests", async () => {
    const s = setup({ width: 1 });
    await s.call(s.head, "/api/head/close", { task: "T-3", status: "withdrawn" });
    const a = generateKeyPair(), b = generateKeyPair();
    await join(s, a, "x");
    await join(s, b, "y");
    await s.call(a, "/api/next", {});
    await s.call(b, "/api/next", { wait: 0.2 });
    const m = (await s.get("/api/metrics")).body;
    expect(m.latencyMs["POST /api/join"].count).toBe(2);
    expect(m.latencyMs["POST /api/next"].count).toBe(1);
    expect(m.latencyMs["POST /api/next"].p99).toBeLessThan(200);
  });
});
