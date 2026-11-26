import { describe, expect, test } from "bun:test";
import {
  computeLeaderboard, initialState, isLive, liveAttempts, nextId, reduce, replay,
} from "../src/log/reducer.ts";
import type { MingaEvent, NewEvent, Rules } from "../src/core/types.ts";

const RULES: Rules = {
  width: 2,
  leaseMinutes: 10,
  maxAttemptsPerAgent: 2,
  roles: { explore: 1, build: 1, attack: 0, distill: 0, plan: 0 },
  accept: { mode: "head" },
  defaultPoints: 3,
};

const T0 = "2026-01-01T00:00:00.000Z";

/** Monotonic event factory: the store's job, replayed here. */
function logger(start = 0) {
  let seq = start;
  return (event: NewEvent, at = T0): MingaEvent => {
    seq += 1;
    return { ...event, seq, at } as MingaEvent;
  };
}

const join = (
  agent: string,
  opts: { model?: string; harness?: string; owner?: string; rejoin?: boolean } = {},
): NewEvent => ({
  type: "agent.joined",
  actor: agent,
  data: {
    agent,
    publicKey: `pk-${agent}`,
    model: opts.model ?? "model-a",
    harness: opts.harness ?? "harness-a",
    ...(opts.owner !== undefined ? { owner: opts.owner } : {}),
    rejoin: opts.rejoin ?? false,
  },
});

const post = (task: string, parent: string | null = null, points = 3): NewEvent => ({
  type: "task.posted",
  actor: "server",
  data: { task, title: `title ${task}`, body: `body ${task}`, parent, points, by: "config" },
});

const start = (
  attempt: string,
  task: string,
  agent: string,
  leaseUntil = "2026-01-01T00:10:00.000Z",
  model = "model-a",
): NewEvent => ({
  type: "attempt.started",
  actor: agent,
  data: { attempt, task, agent, role: "build", approach: "try it", model, leaseUntil },
});

const submission = (
  id: string,
  agent: string,
  model: string,
  ok: boolean,
  points: number,
): NewEvent => ({
  type: "submission.checked",
  actor: agent,
  data: {
    submission: id,
    attempt: "A-1",
    task: "T-1",
    agent,
    model,
    claim: "solves",
    files: ["src/x.ts"],
    ok,
    exitCode: ok ? 0 : 1,
    timedOut: false,
    outputTail: "",
    durationMs: 5,
    points,
  },
});

describe("initialState", () => {
  test("starts empty at seq 0 and copies the rules", () => {
    const state = initialState(RULES);
    expect(state.seq).toBe(0);
    expect(state.counters).toEqual({ task: 0, attempt: 0, note: 0, submission: 0, proposal: 0 });
    expect(state.agents).toEqual({});

    state.rules.roles.explore = 99;
    state.rules.accept = { mode: "votes", votes: 7 };
    expect(RULES.roles.explore).toBe(1);
    expect(RULES.accept).toEqual({ mode: "head" });
  });
});

describe("reduce seq ordering", () => {
  test("throws on a gap and advances seq otherwise", () => {
    const ev = logger();
    const state = initialState(RULES);
    const first = ev(join("aaa"));

    expect(() => reduce(state, { ...ev(join("bbb")), seq: 5 } as MingaEvent)).toThrow();
    // The failed event did not advance the state.
    expect(state.seq).toBe(0);

    expect(reduce(state, first)).toBe(state);
    expect(state.seq).toBe(1);

    expect(() => reduce(state, { ...ev(join("ccc")), seq: 3 } as MingaEvent)).toThrow();
    expect(state.seq).toBe(1);
  });
});

describe("agents", () => {
  test("join creates the agent and any known-agent event refreshes lastSeenAt", () => {
    const ev = logger();
    const state = replay(RULES, [
      ev(join("aaa", { model: "m1", harness: "h1", owner: "own" })),
      ev(
        { type: "note.added", actor: "aaa", data: { note: "N-1", task: "T-1", agent: "aaa", kind: "idea", text: "hi" } },
        "2026-01-01T00:02:00.000Z",
      ),
    ]);

    const agent = state.agents["aaa"]!;
    expect(agent).toMatchObject({
      id: "aaa",
      publicKey: "pk-aaa",
      model: "m1",
      harness: "h1",
      owner: "own",
      joinedAt: T0,
      lastSeenAt: "2026-01-01T00:02:00.000Z",
      banned: false,
      points: 0,
      accepted: 0,
      submissions: 0,
    });
  });

  test("rejoin updates model/harness/owner but keeps counters", () => {
    const ev = logger();
    const state = replay(RULES, [
      ev(join("aaa", { model: "m1", harness: "h1", owner: "own" })),
      ev(post("T-1")),
      ev(submission("S-1", "aaa", "m1", true, 10)),
      ev(submission("S-2", "aaa", "m1", false, 0)),
      ev(join("aaa", { model: "m2", harness: "h2", owner: "own2", rejoin: true }), "2026-01-01T00:05:00.000Z"),
    ]);

    const agent = state.agents["aaa"]!;
    expect(agent.model).toBe("m2");
    expect(agent.harness).toBe("h2");
    expect(agent.owner).toBe("own2");
    expect(agent.lastSeenAt).toBe("2026-01-01T00:05:00.000Z");
    expect(agent.joinedAt).toBe(T0);
    expect(agent.points).toBe(10);
    expect(agent.accepted).toBe(1);
    expect(agent.submissions).toBe(2);
  });

  test("ban sets the flag and is idempotent", () => {
    const ev = logger();
    const state = replay(RULES, [
      ev(join("aaa")),
      ev({ type: "agent.banned", actor: "server", data: { agent: "aaa", reason: "spam" } }),
      ev({ type: "agent.banned", actor: "server", data: { agent: "aaa", reason: "again" } }),
      ev({ type: "agent.banned", actor: "server", data: { agent: "nobody", reason: "ghost" } }),
    ]);
    expect(state.agents["aaa"]!.banned).toBe(true);
    expect(state.agents["nobody"]).toBeUndefined();
  });
});

describe("tasks", () => {
  test("post creates a task, nests children and bumps the counter", () => {
    const ev = logger();
    const state = replay(RULES, [
      ev(post("T-1", null, 5)),
      ev(post("T-7", "T-1", 2)),
    ]);

    expect(state.tasks["T-1"]).toEqual({
      id: "T-1",
      title: "title T-1",
      body: "body T-1",
      parent: null,
      children: ["T-7"],
      status: "open",
      points: 5,
      postedAt: T0,
      attempts: [],
      notes: [],
    });
    expect(state.tasks["T-7"]!.parent).toBe("T-1");
    expect(state.counters.task).toBe(7);
  });

  test("close sets status, closedAt and closedBy", () => {
    const ev = logger();
    const state = replay(RULES, [
      ev(post("T-1")),
      ev(
        { type: "task.closed", actor: "aaa", data: { task: "T-1", status: "solved", agent: "aaa", submission: "S-1" } },
        "2026-01-01T00:03:00.000Z",
      ),
      ev({ type: "task.closed", actor: "server", data: { task: "T-404", status: "withdrawn" } }),
    ]);

    expect(state.tasks["T-1"]!.status).toBe("solved");
    expect(state.tasks["T-1"]!.closedAt).toBe("2026-01-01T00:03:00.000Z");
    expect(state.tasks["T-1"]!.closedBy).toBe("aaa");
  });
});

describe("attempts", () => {
  test("start records the attempt on the task, refreshes the agent model and bumps the counter", () => {
    const ev = logger();
    const state = replay(RULES, [
      ev(join("aaa", { model: "old" })),
      ev(post("T-1")),
      ev(start("A-4", "T-1", "aaa", "2026-01-01T00:20:00.000Z", "fresh")),
    ]);

    expect(state.attempts["A-4"]).toEqual({
      id: "A-4",
      task: "T-1",
      agent: "aaa",
      role: "build",
      approach: "try it",
      model: "fresh",
      startedAt: T0,
      leaseUntil: "2026-01-01T00:20:00.000Z",
      lastBeatAt: T0,
    });
    expect(state.tasks["T-1"]!.attempts).toEqual(["A-4"]);
    expect(state.agents["aaa"]!.model).toBe("fresh");
    expect(state.counters.attempt).toBe(4);
  });

  test("beat renews the lease and can update models; unknown attempts are ignored", () => {
    const ev = logger();
    const state = replay(RULES, [
      ev(join("aaa")),
      ev(post("T-1")),
      ev(start("A-1", "T-1", "aaa", "2026-01-01T00:10:00.000Z", "m1")),
      ev(
        { type: "attempt.beat", actor: "aaa", data: { attempt: "A-1", leaseUntil: "2026-01-01T00:30:00.000Z", model: "m2" } },
        "2026-01-01T00:05:00.000Z",
      ),
      ev(
        { type: "attempt.beat", actor: "aaa", data: { attempt: "A-404", leaseUntil: "2026-01-01T00:40:00.000Z" } },
        "2026-01-01T00:06:00.000Z",
      ),
    ]);

    const attempt = state.attempts["A-1"]!;
    expect(attempt.leaseUntil).toBe("2026-01-01T00:30:00.000Z");
    expect(attempt.lastBeatAt).toBe("2026-01-01T00:05:00.000Z");
    expect(attempt.model).toBe("m2");
    expect(state.agents["aaa"]!.model).toBe("m2");
    expect(state.attempts["A-404"]).toBeUndefined();
    expect(state.seq).toBe(5);
  });

  test("end records endedAt and reason; unknown attempts are ignored", () => {
    const ev = logger();
    const state = replay(RULES, [
      ev(join("aaa")),
      ev(post("T-1")),
      ev(start("A-1", "T-1", "aaa")),
      ev(
        { type: "attempt.ended", actor: "aaa", data: { attempt: "A-1", reason: "released" } },
        "2026-01-01T00:04:00.000Z",
      ),
      ev({ type: "attempt.ended", actor: "aaa", data: { attempt: "A-404", reason: "expired" } }),
    ]);

    expect(state.attempts["A-1"]!.endedAt).toBe("2026-01-01T00:04:00.000Z");
    expect(state.attempts["A-1"]!.endReason).toBe("released");
  });

  test("isLive respects ended-ness and the lease boundary", () => {
    const ev = logger();
    const state = replay(RULES, [
      ev(join("aaa")),
      ev(post("T-1")),
      ev(start("A-1", "T-1", "aaa", "2026-01-01T00:10:00.000Z")),
      ev(start("A-2", "T-1", "aaa", "2026-01-01T00:10:00.000Z")),
      ev({ type: "attempt.ended", actor: "aaa", data: { attempt: "A-2", reason: "submitted" } }, "2026-01-01T00:02:00.000Z"),
    ]);

    expect(isLive(state, "A-1", new Date("2026-01-01T00:09:59.999Z"))).toBe(true);
    expect(isLive(state, "A-1", new Date("2026-01-01T00:10:00.000Z"))).toBe(false);
    expect(isLive(state, "A-1", new Date("2026-01-01T00:10:00.001Z"))).toBe(false);
    expect(isLive(state, "A-2", new Date("2026-01-01T00:00:01.000Z"))).toBe(false);
    expect(isLive(state, "A-404", new Date(T0))).toBe(false);

    expect(liveAttempts(state, "T-1", new Date("2026-01-01T00:05:00.000Z"))).toEqual(["A-1"]);
    expect(liveAttempts(state, "T-1", new Date("2026-01-01T00:20:00.000Z"))).toEqual([]);
    expect(liveAttempts(state, "T-404", new Date(T0))).toEqual([]);
  });
});

describe("notes", () => {
  test("notes are newest-first and bump the counter", () => {
    const ev = logger();
    const state = replay(RULES, [
      ev(join("aaa")),
      ev(post("T-1")),
      ev(
        { type: "note.added", actor: "aaa", data: { note: "N-1", task: "T-1", agent: "aaa", kind: "idea", text: "one" } },
        "2026-01-01T00:01:00.000Z",
      ),
      ev(
        { type: "note.added", actor: "aaa", data: { note: "N-5", task: "T-1", agent: "aaa", kind: "handoff", text: "two" } },
        "2026-01-01T00:02:00.000Z",
      ),
      ev({ type: "note.added", actor: "aaa", data: { note: "N-9", task: "T-404", agent: "aaa", kind: "idea", text: "lost" } }),
    ]);

    expect(state.tasks["T-1"]!.notes).toEqual(["N-5", "N-1"]);
    expect(state.notes["N-1"]).toEqual({
      id: "N-1",
      task: "T-1",
      agent: "aaa",
      kind: "idea",
      text: "one",
      at: "2026-01-01T00:01:00.000Z",
    });
    expect(state.notes["N-9"]).toBeUndefined();
    expect(state.counters.note).toBe(5);
  });
});

describe("submissions", () => {
  test("a passing submission awards points; a failing one only counts", () => {
    const ev = logger();
    const state = replay(RULES, [
      ev(join("aaa")),
      ev(post("T-1")),
      ev(submission("S-1", "aaa", "model-a", true, 12)),
      ev(submission("S-7", "aaa", "model-a", false, 0)),
    ]);

    expect(state.submissions["S-1"]).toMatchObject({ ok: true, points: 12, at: T0 });
    expect(state.submissions["S-7"]).toMatchObject({ ok: false, points: 0, at: T0 });
    const agent = state.agents["aaa"]!;
    expect(agent.points).toBe(12);
    expect(agent.accepted).toBe(1);
    expect(agent.submissions).toBe(2);
    expect(state.counters.submission).toBe(7);
  });
});

describe("proposals", () => {
  test("made/voted/decided fold into one proposal; unknown ids are ignored", () => {
    const ev = logger();
    const state = replay(RULES, [
      ev(join("aaa")),
      ev(join("bbb")),
      ev(post("T-1")),
      ev(
        {
          type: "proposal.made",
          actor: "aaa",
          data: { proposal: "P-3", agent: "aaa", kind: "new_task", task: "T-1", title: "sub", body: "more" },
        },
        "2026-01-01T00:01:00.000Z",
      ),
      ev({ type: "proposal.voted", actor: "bbb", data: { proposal: "P-3", agent: "bbb", approve: true } }),
      ev({ type: "proposal.voted", actor: "bbb", data: { proposal: "P-3", agent: "aaa", approve: true } }),
      ev({ type: "proposal.voted", actor: "bbb", data: { proposal: "P-404", agent: "bbb", approve: false } }),
      ev(
        {
          type: "proposal.decided",
          actor: "server",
          data: { proposal: "P-3", accepted: true, by: "vote", reason: "enough" },
        },
        "2026-01-01T00:02:00.000Z",
      ),
      ev({ type: "proposal.decided", actor: "server", data: { proposal: "P-404", accepted: false, by: "head" } }),
    ]);

    const proposal = state.proposals["P-3"]!;
    expect(proposal).toMatchObject({
      id: "P-3",
      agent: "aaa",
      kind: "new_task",
      task: "T-1",
      title: "sub",
      body: "more",
      at: "2026-01-01T00:01:00.000Z",
      votes: { bbb: true, aaa: true },
      decided: { accepted: true, by: "vote", reason: "enough", at: "2026-01-01T00:02:00.000Z" },
    });
    expect(state.counters.proposal).toBe(3);
  });
});

describe("rules", () => {
  test("rule.changed merges scalars and replaces roles/accept wholesale", () => {
    const ev = logger();
    const state = replay(RULES, [
      ev({
        type: "rule.changed",
        actor: "server",
        data: { rules: { width: 5, roles: { explore: 0, build: 0, attack: 1, distill: 0, plan: 0 }, accept: { mode: "votes", votes: 3 } } },
      }),
      ev({ type: "rule.changed", actor: "server", data: { rules: { defaultPoints: 9 } } }),
    ]);

    expect(state.rules.width).toBe(5);
    expect(state.rules.leaseMinutes).toBe(10);
    expect(state.rules.maxAttemptsPerAgent).toBe(2);
    expect(state.rules.defaultPoints).toBe(9);
    expect(state.rules.roles).toEqual({ explore: 0, build: 0, attack: 1, distill: 0, plan: 0 });
    expect(state.rules.accept).toEqual({ mode: "votes", votes: 3 });
  });
});

describe("nextId", () => {
  test("returns the next free id per prefix after a replay", () => {
    const ev = logger();
    const state = replay(RULES, [
      ev(join("aaa")),
      ev(post("T-2")),
      ev(start("A-1", "T-2", "aaa")),
      ev({ type: "note.added", actor: "aaa", data: { note: "N-8", task: "T-2", agent: "aaa", kind: "idea", text: "x" } }),
      ev(submission("S-4", "aaa", "model-a", true, 1)),
      ev({ type: "proposal.made", actor: "aaa", data: { proposal: "P-6", agent: "aaa", kind: "impossible", task: "T-2" } }),
    ]);

    expect(nextId(state, "task")).toBe("T-3");
    expect(nextId(state, "attempt")).toBe("A-2");
    expect(nextId(state, "note")).toBe("N-9");
    expect(nextId(state, "submission")).toBe("S-5");
    expect(nextId(state, "proposal")).toBe("P-7");

    // Pure: does not mutate the counters.
    expect(state.counters.task).toBe(2);
  });

  test("starts at 1 on a fresh state", () => {
    const state = initialState(RULES);
    expect(nextId(state, "task")).toBe("T-1");
    expect(nextId(state, "attempt")).toBe("A-1");
    expect(nextId(state, "note")).toBe("N-1");
    expect(nextId(state, "submission")).toBe("S-1");
    expect(nextId(state, "proposal")).toBe("P-1");
  });
});

describe("computeLeaderboard", () => {
  test("orders agents by points, then accepted, then id and excludes banned agents", () => {
    const ev = logger();
    const state = replay(RULES, [
      ev(join("zzz")),
      ev(join("aaa")),
      ev(join("mmm")),
      ev(join("ban")),
      ev(post("T-1")),
      // zzz: 12 points over two accepted submissions.
      ev(submission("S-1", "zzz", "model-a", true, 6)),
      ev(submission("S-2", "zzz", "model-a", true, 6)),
      // aaa: 12 points from one accepted submission -> loses the accepted tiebreak.
      ev(submission("S-3", "aaa", "model-b", true, 12)),
      // mmm: no submissions.
      // ban: high score but banned.
      ev(submission("S-4", "ban", "model-c", true, 100)),
      ev({ type: "agent.banned", actor: "server", data: { agent: "ban", reason: "cheat" } }),
    ]);

    const board = computeLeaderboard(state);
    expect(board.agents.map((r) => r.agent)).toEqual(["zzz", "aaa", "mmm"]);

    const zzz = board.agents[0]!;
    expect(zzz).toMatchObject({ model: "model-a", points: 12, accepted: 2, submissions: 2 });

    expect(board.models.map((m) => m.model)).toEqual(["model-c", "model-a", "model-b"]);

    const a = board.models.find((m) => m.model === "model-a")!;
    expect(a).toEqual({
      model: "model-a",
      agents: 1,
      points: 12,
      accepted: 2,
      submissions: 2,
      passRate: 1,
    });

    const b = board.models.find((m) => m.model === "model-b")!;
    expect(b).toEqual({
      model: "model-b",
      agents: 1,
      points: 12,
      accepted: 1,
      submissions: 1,
      passRate: 1,
    });
  });

  test("groups models by submission.model and computes passRate (0 when no submissions)", () => {
    const ev = logger();
    const state = replay(RULES, [
      ev(join("aaa", { model: "model-a" })),
      ev(join("bbb", { model: "model-b" })),
      ev(post("T-1")),
      ev(submission("S-1", "aaa", "model-early", true, 10)),
      ev(submission("S-2", "aaa", "model-early", false, 0)),
      ev(submission("S-3", "bbb", "model-early", true, 5)),
    ]);

    const board = computeLeaderboard(state);
    expect(board.models).toEqual([
      { model: "model-early", agents: 2, points: 15, accepted: 2, submissions: 3, passRate: 2 / 3 },
    ]);

    const empty = computeLeaderboard(initialState(RULES));
    expect(empty).toEqual({ agents: [], models: [] });
  });

  test("a model with only failed submissions has passRate 0 and no points", () => {
    const ev = logger();
    const state = replay(RULES, [
      ev(join("aaa")),
      ev(post("T-1")),
      ev(submission("S-1", "aaa", "bad-model", false, 0)),
    ]);
    const board = computeLeaderboard(state);
    expect(board.models).toEqual([
      { model: "bad-model", agents: 1, points: 0, accepted: 0, submissions: 1, passRate: 0 },
    ]);
  });
});
