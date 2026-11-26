import { describe, expect, test } from "bun:test";
import type { CheckInput, CommitInput } from "../src/core/contracts.ts";
import type { ProjectConfig } from "../src/core/types.ts";
import { formatHeadKey, generateKeyPair, signRequest, type KeyPair } from "../src/identity/keys.ts";
import { openEventStore } from "../src/log/store.ts";
import { createApp } from "../src/server/app.ts";

function setup(over: Partial<ProjectConfig["rules"]> = {}) {
  const head = generateKeyPair();
  const cfg: ProjectConfig = {
    name: "demo", goal: "Prove things", scope: "Edit only proofs/.", check: "check {files}", checkTimeoutSeconds: 30,
    paths: ["proofs/**"], head: formatHeadKey(head.publicKey), branch: "main",
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
  const store = openEventStore(":memory:");
  let seed = 1;
  let gate: Promise<void> | null = null;
  const make = () => createApp({
    cfg, store, repoDir: "/repo",
    now: () => new Date(clock),
    rng: () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; },
    runCheck: async (input) => {
      checks.push(input);
      if (gate) await gate;
      const ok = Object.values(input.files).some((c) => c.includes("QED"));
      return { ok, exitCode: ok ? 0 : 1, timedOut: false, outputTail: ok ? "" : "error: unsolved goals", durationMs: 5 };
    },
    commitAccepted: async (input) => { commits.push(input); return `c${commits.length}`; },
  });
  const app = make();
  async function call(keys: KeyPair, path: string, body: unknown, opts: { tamper?: boolean; headers?: Record<string, string> } = {}) {
    const raw = JSON.stringify(body);
    const headers = { ...signRequest(keys, "POST", path, raw, clock), "content-type": "application/json", ...opts.headers };
    const res = await app.fetch(new Request(`http://minga.test${path}`, { method: "POST", headers, body: opts.tamper ? raw + " " : raw }));
    return { status: res.status, body: await res.json() as any };
  }
  async function get(path: string) {
    const res = await app.fetch(new Request(`http://minga.test${path}`));
    return { status: res.status, body: await res.json() as any };
  }
  return {
    cfg, app, make, store, head, call, get, checks, commits, tick: (ms: number) => { clock += ms; },
    /** Holds every check until the returned function is called. */
    holdChecks: () => { let release!: () => void; gate = new Promise((r) => { release = r; }); return () => { gate = null; release(); }; },
  };
}

const join = (s: ReturnType<typeof setup>, keys: KeyPair, model: string) =>
  s.call(keys, "/api/join", { publicKey: keys.publicKey, model, harness: "test-harness" });

describe("server", () => {
  test("seeds tasks from config once", async () => {
    const s = setup();
    expect(Object.keys(s.app.state.tasks)).toEqual(["T-1", "T-2", "T-3"]);
    expect(s.app.state.tasks["T-2"]!.parent).toBe("T-1");
    const again = s.make();
    expect(Object.keys(again.state.tasks)).toHaveLength(3);
  });

  test("join, next, note, failing then passing submit", async () => {
    const s = setup();
    const a = generateKeyPair();
    const j = await join(s, a, "claude-opus-5.5");
    expect(j.status).toBe(200);
    expect(j.body.rejoin).toBe(false);
    const n = await s.call(a, "/api/next", {});
    expect(n.status).toBe(200);
    const asg = n.body.assignment;
    expect(["T-2", "T-3"]).toContain(asg.task.id);
    expect(asg.path[0].title).toBe("Area A");

    expect((await s.call(a, "/api/note", { task: asg.task.id, kind: "idea", text: "try induction" })).status).toBe(200);

    const bad = await s.call(a, "/api/submit", { attempt: asg.attempt, claim: "solves", message: "first try", files: { "proofs/x.lean": "sorry" } });
    expect(bad.body.ok).toBe(false);
    expect(bad.body.outputTail).toContain("unsolved");
    expect(bad.body.taskStatus).toBe("open");
    expect(s.commits).toHaveLength(0);

    const good = await s.call(a, "/api/submit", { attempt: asg.attempt, claim: "solves", message: "done", files: { "proofs/x.lean": "QED" } });
    expect(good.body.ok).toBe(true);
    expect(good.body.commit).toBe("c1");
    expect(good.body.taskStatus).toBe("solved");
    expect(s.commits[0]!.trailers["Agent-Model"]).toBe("claude-opus-5.5");
    const lb = await s.get("/api/leaderboard");
    expect(lb.body.agents[0].agent).toBe(j.body.agent);
    expect(lb.body.agents[0].points).toBe(asg.task.points);
    expect(s.app.state.attempts[asg.attempt]!.endReason).toBe("submitted");
  });

  test("two passing submissions on one task: exactly one wins", async () => {
    const s = setup({ roles: { explore: 0, build: 1, attack: 0, distill: 0, plan: 0 } });
    // Close T-3 so both agents land on T-2 (width 2).
    await s.call(s.head, "/api/head/close", { task: "T-3", status: "withdrawn" });
    const a = generateKeyPair(), b = generateKeyPair();
    await join(s, a, "claude-opus-5.5");
    await join(s, b, "gpt-5.6");
    const ta = (await s.call(a, "/api/next", {})).body.assignment;
    const tb = (await s.call(b, "/api/next", {})).body.assignment;
    expect(ta.task.id).toBe("T-2");
    expect(tb.task.id).toBe("T-2");
    const release = s.holdChecks();
    const pa = s.call(a, "/api/submit", { attempt: ta.attempt, claim: "solves", message: "a", files: { "proofs/a.lean": "QED" } });
    const pb = s.call(b, "/api/submit", { attempt: tb.attempt, claim: "solves", message: "b", files: { "proofs/b.lean": "QED" } });
    // Let both requests reach the queue. The second waits there, so its lease may run out without losing its slot.
    await Bun.sleep(20);
    s.tick(50 * 60_000);
    expect(s.app.sweep()).toBe(0);
    release();
    const [ra, rb] = await Promise.all([pa, pb]);
    const wins = [ra, rb].filter((r) => r.status === 200 && r.body.ok);
    expect(wins).toHaveLength(1);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    expect(s.commits).toHaveLength(1);
    expect(s.checks).toHaveLength(1);
    expect(Object.values(s.app.state.submissions).filter((x) => x.points > 0)).toHaveLength(1);
  });

  test("rejects bad signatures, replays, unknown agents and disallowed paths", async () => {
    const s = setup();
    const a = generateKeyPair();
    await join(s, a, "gpt-5.6");
    expect((await s.call(a, "/api/next", {}, { tamper: true })).status).toBe(401);
    expect((await s.call(generateKeyPair(), "/api/next", {})).status).toBe(401);
    const raw = JSON.stringify({});
    const headers = signRequest(a, "POST", "/api/next", raw, Date.parse("2026-11-26T12:00:00Z"));
    const r1 = await s.app.fetch(new Request("http://minga.test/api/next", { method: "POST", headers, body: raw }));
    const r2 = await s.app.fetch(new Request("http://minga.test/api/next", { method: "POST", headers, body: raw }));
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(401);
    const att = (r1.ok ? await r1.json() as any : null).assignment.attempt;
    const sub = await s.call(a, "/api/submit", { attempt: att, claim: "solves", message: "x", files: { "../etc/passwd": "QED" } });
    expect(sub.status).toBe(400);
    const key = await s.call(a, "/api/submit", { attempt: att, claim: "solves", message: "x", files: { ".minga/agent.json": "QED" } });
    expect(key.status).toBe(400);
    expect(s.checks).toHaveLength(0);
  });

  test("width and model diversity spread agents out", async () => {
    const s = setup();
    const keys = [generateKeyPair(), generateKeyPair(), generateKeyPair(), generateKeyPair(), generateKeyPair()];
    const models = ["claude-opus-5.5", "claude-sonnet-5.5", "gpt-5.6", "gemini-3-pro", "qwen-3.5"];
    const got: string[] = [];
    for (let i = 0; i < keys.length; i++) {
      await join(s, keys[i]!, models[i]!);
      const n = await s.call(keys[i]!, "/api/next", {});
      got.push(n.body.assignment ? n.body.assignment.task.id : "none");
    }
    // 2 leaf tasks x width 2 = 4 slots; the fifth agent gets nothing.
    expect(got.filter((g) => g === "none")).toHaveLength(1);
    expect(got.filter((g) => g === "T-2")).toHaveLength(2);
    expect(got.filter((g) => g === "T-3")).toHaveLength(2);
    // The two claude agents should not be stacked on the same task.
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
    await join(s, b, "gpt-5.6");
    const p1 = await s.call(a, "/api/propose", { kind: "new_task", task: "T-1", title: "Lemma three", body: "split from T-2" });
    expect(p1.body.proposal).toBe("P-1");
    expect((await s.call(a, "/api/head/decide", { proposal: "P-1", accept: true })).status).toBe(403);
    const d = await s.call(s.head, "/api/head/decide", { proposal: "P-1", accept: true });
    expect(d.body.task).toBe("T-4");
    expect(s.app.state.tasks["T-4"]!.parent).toBe("T-1");

    // b earns an accepted submission so its vote counts.
    const asg = (await s.call(b, "/api/next", {})).body.assignment;
    await s.call(b, "/api/submit", { attempt: asg.attempt, claim: "solves", message: "ok", files: { "proofs/b.lean": "QED" } });
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

  test("state replays identically from the log", async () => {
    const s = setup();
    const a = generateKeyPair();
    await join(s, a, "claude-opus-5.5");
    const asg = (await s.call(a, "/api/next", {})).body.assignment;
    await s.call(a, "/api/submit", { attempt: asg.attempt, claim: "solves", message: "ok", files: { "proofs/x.lean": "QED" } });
    const replayed = s.make();
    expect(replayed.state).toEqual(s.app.state);
    const st = await s.get("/api/state");
    expect(st.body.project.name).toBe("demo");
    expect(st.body.leaderboard.agents).toHaveLength(1);
  });
});
