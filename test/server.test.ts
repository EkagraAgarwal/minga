import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import type { CheckInput, CommitInput } from "../src/core/contracts.ts";
import type { ProjectConfig } from "../src/core/types.ts";
import { formatHeadKey, generateKeyPair, signRequest, type KeyPair } from "../src/identity/keys.ts";
import { openEventStore } from "../src/log/store.ts";
import { createApp } from "../src/server/app.ts";

function setup(over: Partial<ProjectConfig["rules"]> = {}, opts: { poolSize?: number; recheck?: ProjectConfig["recheck"]; joinLimitPerHour?: number; leafPaths?: string[] } = {}) {
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
      { title: "Lemma one", body: "prove it", under: "a", points: 40, ...(opts.leafPaths ? { paths: opts.leafPaths } : {}) },
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

  test("an attempt closed under an agent says who closed it, and GET /api/attempt shows it", async () => {
    const s = setup({}, { poolSize: 4 });
    await s.call(s.head, "/api/head/close", { task: "T-3", status: "withdrawn" });
    const a = generateKeyPair(), b = generateKeyPair();
    const ja = (await join(s, a, "claude-opus-5.5")).body.agent;
    await join(s, b, "gpt-6");
    const ta = (await s.call(a, "/api/next", {})).body.assignment;
    const tb = (await s.call(b, "/api/next", {})).body.assignment;
    expect(ta.task.id).toBe(tb.task.id);
    expect((await s.get(`/api/attempt/${tb.attempt}`)).body).toMatchObject({ id: tb.attempt, state: "live", taskStatus: "open" });
    const won = await submitAndWait(s, a, ta.attempt, "QED");
    expect(won.body.status).toBe("accepted");
    const late = await s.call(b, "/api/submit", { attempt: tb.attempt, claim: "solves", message: "b", files: { "proofs/b.lean": "QED" } });
    expect(late.status).toBe(410);
    expect(late.body.error).toContain(`ended: ${tb.task.id} was solved by ${won.body.id} from ${ja} (claude-opus-5.5) while you worked`);
    expect(late.body.detail).toContain("minga sync --discard");
    const view = (await s.get(`/api/attempt/${tb.attempt}`)).body;
    expect(view).toMatchObject({ state: "ended", endReason: "task_closed", taskStatus: "solved", closedBy: { agent: ja, submission: won.body.id } });
    expect((await s.get("/api/attempt/A-999")).status).toBe(404);
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

  test("head notes reach agents with their assignment", async () => {
    const s = setup();
    const n = await s.call(s.head, "/api/head/note", { task: "T-2", text: "the test for this task was fixed in abc123; git pull" });
    expect(n.status).toBe(200);
    const a = generateKeyPair();
    await join(s, a, "x");
    await s.call(s.head, "/api/head/close", { task: "T-3", status: "withdrawn" });
    const asg = (await s.call(a, "/api/next", {})).body.assignment;
    expect(asg.notes[0].text).toContain("git pull");
    expect(asg.notes[0].agent).toBe(s.app.headId);
    expect((await s.call(a, "/api/head/note", { task: "T-2", text: "x" })).status).toBe(403);
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

  // ---------------------------------------------------------------- coordination (0.2)

  async function twoOnOneTask(s: S) {
    await s.call(s.head, "/api/head/close", { task: "T-3", status: "withdrawn" });
    const a = generateKeyPair(), b = generateKeyPair();
    const ja = await join(s, a, "winner-model");
    const jb = await join(s, b, "loser-model");
    const ta = (await s.call(a, "/api/next", {})).body.assignment;
    const tb = (await s.call(b, "/api/next", {})).body.assignment;
    return { a, b, aid: ja.body.agent, bid: jb.body.agent, ta, tb };
  }

  test("a loser gets one attempt_ended notice on next, naming the winning submission", async () => {
    const s = setup({}, { poolSize: 4 });
    const { a, b, aid, bid, ta, tb } = await twoOnOneTask(s);
    expect(ta.task.id).toBe("T-2");
    expect(tb.task.id).toBe("T-2");
    const won = await submitAndWait(s, a, ta.attempt, "QED");
    expect(won.body.status).toBe("accepted");
    expect(s.app.state.attempts[tb.attempt]!.endReason).toBe("task_closed");
    expect(s.app.state.index.unnotified?.[bid]).toEqual([tb.attempt]);

    const n1 = await s.call(b, "/api/next", {});
    expect(n1.status).toBe(200);
    expect(n1.body.notices).toEqual([{
      kind: "attempt_ended", attempt: tb.attempt, task: "T-2", reason: "task_closed",
      taskStatus: "solved", closedBy: { agent: aid, model: "winner-model", submission: won.body.id },
    }]);
    expect(s.app.state.index.unnotified?.[bid]).toBeUndefined();
    expect((await s.call(b, "/api/next", {})).body.notices).toBeUndefined();
    const notified = s.store.since(0).filter((e) => e.type === "attempt.notified");
    expect(notified).toHaveLength(1);
    expect(notified[0]!.data).toMatchObject({ attempt: tb.attempt, agent: bid, via: "next" });
  });

  test("a 410 on the closed attempt tells the loser and clears the notice", async () => {
    const s = setup({}, { poolSize: 4 });
    const { a, b, bid, ta, tb } = await twoOnOneTask(s);
    const won = await submitAndWait(s, a, ta.attempt, "QED");
    const late = await s.call(b, "/api/beat", { attempt: tb.attempt });
    expect(late.status).toBe(410);
    expect(late.body.error).toContain(`ended: T-2 was solved by ${won.body.id} from`);
    expect(s.app.state.index.unnotified?.[bid]).toBeUndefined();
    expect((await s.call(b, "/api/next", {})).body.notices).toBeUndefined();
    const notified = s.store.since(0).filter((e) => e.type === "attempt.notified");
    expect(notified).toHaveLength(1);
    expect(notified[0]!.data).toMatchObject({ attempt: tb.attempt, agent: bid, via: "beat" });
  });

  test("a note with to arrives once as a notice; unknown addressee is refused", async () => {
    const s = setup();
    const a = generateKeyPair(), b = generateKeyPair();
    const ja = await join(s, a, "m1");
    const jb = await join(s, b, "m2");
    const r = await s.call(a, "/api/note", { task: "T-2", kind: "idea", text: "look here", to: jb.body.agent });
    expect(r.status).toBe(200);
    expect(r.body.note.to).toBe(jb.body.agent);
    expect(ja.body.agent).not.toBe(jb.body.agent);
    const n1 = await s.call(b, "/api/next", {});
    expect(n1.body.notices).toEqual([{ kind: "note", note: r.body.note }]);
    expect((await s.call(b, "/api/next", {})).body.notices).toBeUndefined();
    expect((await s.call(a, "/api/note", { task: "T-2", kind: "idea", text: "x", to: "0000000000000000" })).status).toBe(404);
  });

  test("beat approach and paths show up in another agent's others list", async () => {
    const s = setup({}, { poolSize: 4 });
    const { a, b, aid, ta, tb } = await twoOnOneTask(s);
    expect((await s.call(a, "/api/beat", { attempt: ta.attempt, paths: ["../x"] })).status).toBe(400);
    expect((await s.call(a, "/api/beat", { attempt: ta.attempt, paths: ["/abs.ts"] })).status).toBe(400);
    const beat = await s.call(a, "/api/beat", { attempt: ta.attempt, approach: "induction", paths: ["proofs/a.lean", "lib/"] });
    expect(beat.status).toBe(200);
    expect(beat.body.leaseUntil).toBeDefined();
    expect(s.app.state.index.openByPath?.["proofs/a.lean"]).toContain(ta.attempt);
    expect(s.app.state.index.openByPath?.["lib/"]).toContain(ta.attempt);
    const bbeat = await s.call(b, "/api/beat", { attempt: tb.attempt });
    expect(bbeat.body.news.others).toEqual([{
      attempt: ta.attempt, agent: aid, model: "winner-model", role: "build",
      approach: "induction", paths: ["proofs/a.lean", "lib/"],
    }]);
  });

  test("beat news lists only notes added since the previous beat", async () => {
    const s = setup();
    await s.call(s.head, "/api/head/close", { task: "T-3", status: "withdrawn" });
    const a = generateKeyPair(), b = generateKeyPair();
    await join(s, a, "m1");
    await join(s, b, "m2");
    const ta = (await s.call(a, "/api/next", {})).body.assignment;
    await s.call(b, "/api/next", {});
    expect((await s.call(a, "/api/beat", { attempt: ta.attempt })).body.news.notes).toHaveLength(0);
    s.tick(1000);
    const note = await s.call(b, "/api/note", { task: ta.task.id, kind: "idea", text: "new news" });
    const second = await s.call(a, "/api/beat", { attempt: ta.attempt });
    expect(second.body.news.notes.map((n: any) => n.id)).toEqual([note.body.note.id]);
    const third = await s.call(a, "/api/beat", { attempt: ta.attempt });
    expect(third.body.news.notes).toHaveLength(0);
  });

  test("beat conflicts cover exact and directory-prefix overlaps, but not the same task", async () => {
    const s = setup();
    const a = generateKeyPair(), b = generateKeyPair(), c = generateKeyPair();
    const ja = await join(s, a, "m1"), jb = await join(s, b, "m2"), jc = await join(s, c, "m3");
    const start = (n: number, agent: string, task: string, paths: string[]) =>
      s.app.emit({ type: "attempt.started", actor: agent, data: {
        attempt: `A-${n}`, task, agent, role: "build", approach: "", model: "m",
        leaseUntil: "2099-01-01T00:00:00.000Z", paths,
      } });
    start(1, ja.body.agent, "T-2", ["shared/x.ts", "lib/"]);
    start(2, jb.body.agent, "T-3", ["shared/x.ts", "lib/util.lean"]);
    start(3, jc.body.agent, "T-2", ["shared/x.ts"]);

    const bbeat = await s.call(b, "/api/beat", { attempt: "A-2" });
    expect(bbeat.body.news.conflicts).toEqual([
      { path: "shared/x.ts", task: "T-2", attempt: "A-1", agent: ja.body.agent },
      { path: "shared/x.ts", task: "T-2", attempt: "A-3", agent: jc.body.agent },
      { path: "lib/util.lean", task: "T-2", attempt: "A-1", agent: ja.body.agent },
    ]);
    const abeat = await s.call(a, "/api/beat", { attempt: "A-1" });
    expect(abeat.body.news.conflicts.map((x: any) => x.attempt)).not.toContain("A-3");
    expect(abeat.body.news.conflicts.some((x: any) => x.path === "lib/")).toBe(true);
  });

  test("assignment carries digests nearest first, open sibling questions and dead ends", async () => {
    const s = setup();
    await s.call(s.head, "/api/head/note", { task: "T-1", kind: "digest", text: "area digest" });
    await s.call(s.head, "/api/head/note", { task: "T-2", kind: "digest", text: "task digest" });
    const a = generateKeyPair();
    await join(s, a, "m1");
    const q1 = await s.call(a, "/api/note", { task: "T-2", kind: "question", text: "q on task" });
    await s.call(a, "/api/note", { task: "T-3", kind: "question", text: "q on sibling" });
    expect((await s.call(a, "/api/note", { task: "T-2", kind: "idea", text: "answer", replyTo: q1.body.note.id })).status).toBe(200);
    await s.call(a, "/api/note", { task: "T-2", kind: "dead_end", text: "tried brute force" });
    s.tick(1000);
    await s.call(a, "/api/note", { task: "T-2", kind: "dead_end", text: "tried induction" });
    await s.call(s.head, "/api/head/close", { task: "T-3", status: "withdrawn" });

    const c = generateKeyPair();
    await join(s, c, "m2");
    const asg = (await s.call(c, "/api/next", {})).body.assignment;
    expect(asg.task.id).toBe("T-2");
    expect(asg.digests.map((n: any) => n.text)).toEqual(["task digest", "area digest"]);
    expect(asg.questions.map((n: any) => n.text)).toEqual(["q on sibling"]);
    expect(asg.deadEnds.map((n: any) => n.text)).toEqual(["tried induction", "tried brute force"]);
  });

  test("digest permission: head, lead and accepted work allowed; random agent 403; over 1500 chars 400", async () => {
    const s = setup({}, { poolSize: 4 });
    const over = "x".repeat(1501);
    expect((await s.call(s.head, "/api/head/note", { task: "T-2", kind: "digest", text: over })).status).toBe(400);
    expect((await s.call(s.head, "/api/head/note", { task: "T-2", kind: "digest", text: "head digest" })).status).toBe(200);

    const a = generateKeyPair(), b = generateKeyPair(), c = generateKeyPair();
    const ja = await join(s, a, "m1");
    const jb = await join(s, b, "m2");
    await join(s, c, "m3");
    s.app.emit({ type: "lead.granted", actor: s.app.headId, data: { agent: ja.body.agent, area: "T-1" } });
    expect((await s.call(a, "/api/note", { task: "T-2", kind: "digest", text: over })).status).toBe(400);
    expect((await s.call(a, "/api/note", { task: "T-2", kind: "digest", text: "lead digest" })).status).toBe(200);
    expect((await s.call(c, "/api/note", { task: "T-2", kind: "digest", text: "random digest" })).status).toBe(403);

    await s.call(s.head, "/api/head/close", { task: "T-3", status: "withdrawn" });
    const asg = (await s.call(b, "/api/next", {})).body.assignment;
    expect(asg.task.id).toBe("T-2");
    expect((await submitAndWait(s, b, asg.attempt, "QED")).body.status).toBe("accepted");
    expect(jb.body.agent).not.toBe(ja.body.agent);
    expect((await s.call(b, "/api/note", { task: "T-2", kind: "digest", text: "accepted-work digest" })).status).toBe(200);
    expect((await s.call(c, "/api/note", { task: "T-2", kind: "digest", text: "still random" })).status).toBe(403);
  });

  test("release reason validates and records a dead end", async () => {
    const s = setup();
    const a = generateKeyPair();
    await join(s, a, "dead-end-model");
    const asg = (await s.call(a, "/api/next", {})).body.assignment;
    expect((await s.call(a, "/api/release", { attempt: asg.attempt, reason: "nonsense" as any })).status).toBe(400);
    expect((await s.call(a, "/api/release", { attempt: asg.attempt, reason: "dead_end" })).status).toBe(200);
    expect(s.app.state.attempts[asg.attempt]!.releaseReason).toBe("dead_end");
    expect(s.app.state.index.deadEnds?.[asg.task.id]).toContain("dead-end-model");
    const ended = s.store.since(0).find((e) => e.type === "attempt.ended" && e.data.attempt === asg.attempt);
    expect(ended!.data).toMatchObject({ reason: "released", why: "dead_end" });
  });

  test("head post and seeded tasks carry declared paths into attempts", async () => {
    const s = setup({}, { leafPaths: ["proofs/seed.ts", "lib/"] });
    expect(s.app.state.tasks["T-2"]!.paths).toEqual(["proofs/seed.ts", "lib/"]);
    const a = generateKeyPair();
    await join(s, a, "m1");
    await s.call(s.head, "/api/head/close", { task: "T-3", status: "withdrawn" });
    const asg = (await s.call(a, "/api/next", {})).body.assignment;
    expect(asg.paths).toEqual(["proofs/seed.ts", "lib/"]);
    expect(s.app.state.attempts[asg.attempt]!.paths).toEqual(["proofs/seed.ts", "lib/"]);
    const started = s.store.since(0).find((e) => e.type === "attempt.started" && e.data.attempt === asg.attempt);
    expect(started!.data).toMatchObject({ paths: ["proofs/seed.ts", "lib/"] });

    const posted = await s.call(s.head, "/api/head/post", { title: "New", body: "", parent: null, paths: ["src/a.ts", "lib/"] });
    expect(posted.status).toBe(200);
    expect(s.app.state.tasks[posted.body.task]!.paths).toEqual(["src/a.ts", "lib/"]);
    expect((await s.call(s.head, "/api/head/post", { title: "Bad", body: "", parent: null, paths: ["/abs.ts"] })).status).toBe(400);
  });

  test("5000 beats over 1000 live attempts with two paths each stay under 0.5 ms", async () => {
    const s = setup();
    const TS = Date.parse("2026-11-26T12:00:00Z");
    const agents: { keys: KeyPair; id: string }[] = [];
    for (let i = 0; i < 100; i++) {
      const keys = generateKeyPair();
      const j = await join(s, keys, `model-${i}`);
      agents.push({ keys, id: j.body.agent });
    }
    for (let t = 0; t < 100; t++) {
      s.app.emit({ type: "task.posted", actor: "server", data: {
        task: `T-${100 + t}`, title: "t", body: "", parent: "T-1", points: 1, by: "config",
      } });
    }
    for (let n = 0; n < 1000; n++) {
      const owner = agents[Math.floor(n / 10)]!;
      s.app.emit({ type: "attempt.started", actor: owner.id, data: {
        attempt: `A-${n + 1}`, task: `T-${100 + (n % 100)}`, agent: owner.id, role: "build",
        approach: "", model: "m", leaseUntil: "2099-01-01T00:00:00.000Z",
        paths: [`proofs/f${n}.lean`, "lib/"],
      } });
    }
    expect(s.app.state.index.openAttempts).toHaveLength(1000);

    const reqs: { headers: Record<string, string>; body: string }[] = [];
    for (let k = 0; k < 5000; k++) {
      const i = k % 100;
      const attempt = `A-${i * 10 + (Math.floor(k / 100) % 10) + 1}`;
      const body = JSON.stringify({ attempt });
      reqs.push({ headers: signRequest(agents[i]!.keys, "POST", "/api/beat", body, TS), body });
    }
    const t0 = performance.now();
    for (const r of reqs) {
      const res = await s.app.fetch(new Request("http://minga.test/api/beat", { method: "POST", headers: r.headers, body: r.body }));
      if (res.status !== 200) throw new Error(`beat ${res.status}: ${await res.text()}`);
      await res.arrayBuffer();
    }
    const avg = (performance.now() - t0) / reqs.length;
    expect(avg).toBeLessThan(0.5);
  });
});
