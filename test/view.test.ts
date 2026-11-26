import { describe, expect, test } from "bun:test";
import { buildView } from "../src/log/view.ts";
import { replay } from "../src/log/reducer.ts";
import type { ProjectInfo } from "../src/core/protocol.ts";
import type { MingaEvent, NewEvent, Rules, State, SubmissionState } from "../src/core/types.ts";

const RULES: Rules = {
  width: 2,
  leaseMinutes: 10,
  maxAttemptsPerAgent: 2,
  roles: { explore: 1, build: 1, attack: 0, distill: 0, plan: 0 },
  accept: { mode: "head" },
  defaultPoints: 3,
};

const T0 = "2026-01-01T00:00:00.000Z";
const NOW = new Date("2026-01-01T01:00:00.000Z");
const PROJECT: ProjectInfo = {
  name: "demo",
  goal: "ship",
  scope: "repo",
  check: "true",
  paths: ["src/**"],
  headAgent: "head",
  rules: RULES,
};
const view = (state: State, now = NOW, events = state.seq) =>
  buildView({ state, project: PROJECT, now, events });

function logger(start = 0) {
  let seq = start;
  return (event: NewEvent, at = T0): MingaEvent => {
    seq += 1;
    return { ...event, seq, at } as MingaEvent;
  };
}

const join = (agent: string, model = "model-a"): NewEvent => ({
  type: "agent.joined",
  actor: agent,
  data: { agent, publicKey: `pk-${agent}`, model, harness: "h", rejoin: false },
});
const post = (task: string): NewEvent => ({
  type: "task.posted",
  actor: "server",
  data: { task, title: task, body: "b", parent: null, points: 3, by: "config" },
});
const startAttempt = (attempt: string, task: string, agent: string, lease = "2026-01-01T02:00:00.000Z"): NewEvent => ({
  type: "attempt.started",
  actor: agent,
  data: { attempt, task, agent, role: "build", approach: "", model: "model-a", leaseUntil: lease },
});
const note = (id: number): NewEvent => ({
  type: "note.added",
  actor: "a1",
  data: { note: `N-${id}`, task: "T-1", agent: "a1", kind: "idea", text: `note ${id}` },
});
const queued = (id: number, attempt: string): NewEvent => ({
  type: "submission.queued",
  actor: "a1",
  data: {
    submission: `S-${id}`, attempt, task: "T-1", agent: "a1", model: "model-a",
    claim: "solves", message: "m", files: [], bytes: 0,
  },
});
const checked = (id: number, ok: boolean): NewEvent => ({
  type: "submission.checked",
  actor: "server",
  data: {
    submission: `S-${id}`, attempt: "A-1", task: "T-1", agent: "a1", model: "model-a",
    claim: "solves", files: [], ok, exitCode: ok ? 0 : 1, timedOut: false,
    outputTail: "tail", durationMs: 1, points: ok ? 2 : 0,
  },
});

describe("buildView", () => {
  test("builds totals, compact tasks and only live attempts", () => {
    const ev = logger();
    const state = replay(RULES, [
      ev(join("a1")),
      ev(join("a2"), "2026-01-01T00:55:00.000Z"),
      ev(post("T-1")),
      ev(post("T-2")),
      ev(startAttempt("A-1", "T-1", "a1")),
      ev(startAttempt("A-2", "T-2", "a2", "2026-01-01T00:05:00.000Z"), "2026-01-01T00:55:00.000Z"),
      ev({ type: "attempt.ended", actor: "server", data: { attempt: "A-2", reason: "expired" } }),
      ev(note(1)),
      ev(checked(1, true)),
    ]);
    const out = view(state, NOW, 99);

    expect(out.project).toBe(PROJECT);
    expect(out.seq).toBe(state.seq);
    expect(out.now).toBe(NOW.toISOString());
    expect(out.totals).toEqual({
      agents: 2,
      activeAgents: 1,
      tasks: 2,
      openTasks: 2,
      liveAttempts: 1,
      queuedSubmissions: 0,
      checkingSubmissions: 0,
      submissions: 1,
      accepted: 1,
      notes: 1,
      events: 99,
    });
    expect(out.attempts.map((a) => a.id)).toEqual(["A-1"]);
    expect(out.tasks).toHaveLength(2);
    expect(out.tasks[0]).toMatchObject({ id: "T-1", attemptCount: 1, noteCount: 1, liveCount: 1 });
    expect(out.tasks[0]).not.toHaveProperty("attempts");
    expect(out.tasks[0]).not.toHaveProperty("notes");
    expect(out.leaderboard.agents.map((a) => a.agent)).toEqual(["a1", "a2"]);
  });

  test("counts queued and checking submissions, and includes all pending", () => {
    const ev = logger();
    const state = replay(RULES, [
      ev(join("a1")),
      ev(post("T-1")),
      ev(startAttempt("A-1", "T-1", "a1", "2026-01-01T00:05:00.000Z")),
      ev(queued(1, "A-1")),
      ev({ type: "submission.started", actor: "server", data: { submission: "S-1", base: "b", round: 0 } }, "2026-01-01T00:02:00.000Z"),
      ev(queued(2, "A-1")),
    ]);
    const out = view(state);

    expect(out.totals.queuedSubmissions).toBe(1);
    expect(out.totals.checkingSubmissions).toBe(1);
    expect(out.submissions.map((s) => s.id)).toEqual(["S-2", "S-1"]);
    // The expired lease does not free the attempt while its submission is pending.
    expect(out.attempts.map((a) => a.id)).toEqual(["A-1"]);
  });

  test("keeps only the newest 100 notes and does not mutate state", () => {
    const ev = logger();
    const events: MingaEvent[] = [ev(join("a1")), ev(post("T-1"))];
    for (let i = 1; i <= 5000; i += 1) events.push(ev(note(i)));
    const state = replay(RULES, events);
    const before = structuredClone(state);

    const out = view(state);

    expect(out.notes).toHaveLength(100);
    expect(out.notes[0]!.id).toBe("N-5000");
    expect(out.notes[99]!.id).toBe("N-4901");
    expect(out.totals.notes).toBe(5000);
    expect(out.tasks[0]!.noteCount).toBe(5000);
    expect(state).toEqual(before);
  });

  test("includes all pending plus the newest 100 finished submissions, newest first", () => {
    const ev = logger();
    const events: MingaEvent[] = [ev(join("a1")), ev(post("T-1")), ev(startAttempt("A-1", "T-1", "a1"))];
    for (let i = 1; i <= 250; i += 1) events.push(ev(checked(i, i % 2 === 0)));
    for (let i = 251; i <= 254; i += 1) events.push(ev(queued(i, "A-1")));
    const state = replay(RULES, events);
    const out = view(state);

    expect(out.submissions).toHaveLength(104);
    expect(out.submissions.slice(0, 4).map((s: SubmissionState) => s.id)).toEqual([
      "S-254", "S-253", "S-252", "S-251",
    ]);
    expect(out.submissions[4]!.id).toBe("S-250");
    expect(out.submissions[103]!.id).toBe("S-151");
    expect(out.submissions.every((s, i, arr) => i === 0 || Number(arr[i - 1]!.id.slice(2)) > Number(s.id.slice(2)))).toBe(true);
    expect(out.totals.submissions).toBe(254);
  });

  test("includes live holders and recently seen agents, capped and most recent first", () => {
    const ev = logger();
    const events: MingaEvent[] = [ev(post("T-1"))];
    events.push(ev(join("old", "model-old"), "2026-01-01T00:00:00.000Z"));
    events.push(ev(join("recent", "model-a"), "2026-01-01T00:50:00.000Z"));
    events.push(ev(join("ancient", "model-a"), "2025-12-31T00:00:00.000Z"));
    events.push(ev(startAttempt("A-1", "T-1", "old", "2026-01-02T00:00:00.000Z")));
    const state = replay(RULES, events);
    const out = view(state);

    expect(out.agents.map((a) => a.id)).toEqual(["recent", "old"]);
    expect(out.totals.activeAgents).toBe(1);

    const evMany = logger();
    const many = replay(RULES, [
      evMany(post("T-1")),
      ...Array.from({ length: 2100 }, (_, i) => evMany(join(`x${i}`), "2026-01-01T00:59:00.000Z")),
    ]);
    const capped = view(many);
    expect(capped.agents).toHaveLength(2000);
    expect(capped.totals.agents).toBe(2100);
  });

  test("open proposals plus the newest 50 decided ones", () => {
    const ev = logger();
    const events: MingaEvent[] = [ev(join("a1")), ev(post("T-1"))];
    for (let i = 1; i <= 120; i += 1) {
      events.push(ev({
        type: "proposal.made",
        actor: "a1",
        data: { proposal: `P-${i}`, agent: "a1", kind: "new_task", task: "T-1" },
      }));
      if (i <= 100) {
        events.push(ev({
          type: "proposal.decided",
          actor: "server",
          data: { proposal: `P-${i}`, accepted: true, by: "head" },
        }));
      }
    }
    const out = view(replay(RULES, events));

    expect(out.proposals).toHaveLength(70);
    expect(out.proposals.slice(0, 20).map((p) => p.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => `P-${i + 101}`),
    );
    expect(out.proposals[20]!.id).toBe("P-100");
    expect(out.proposals[69]!.id).toBe("P-51");
  });

  test("builds a bounded view of a large state in under 50 ms", () => {
    const state: State = {
      seq: 100_000,
      rules: RULES,
      agents: {},
      tasks: {},
      attempts: {},
      notes: {},
      submissions: {},
      proposals: {},
      counters: { task: 5000, attempt: 5000, note: 5000, submission: 5000, proposal: 5000 },
      index: {
        openByAgent: {},
        openByTask: {},
        openAttempts: [],
        pendingSubmissions: [],
        failures: {},
      },
    };
    for (let i = 0; i < 2000; i += 1) {
      const id = `a${i}`;
      state.agents[id] = {
        id, publicKey: "k", model: `model-${i % 20}`, harness: "h", joinedAt: T0,
        lastSeenAt: "2026-01-01T00:59:00.000Z", banned: false, points: i,
        accepted: 1, submissions: 2,
      };
    }
    for (let i = 1; i <= 5000; i += 1) {
      const id = `T-${i}`;
      const attempts: string[] = [];
      const notes: string[] = [];
      if (i <= 500) {
        const aid = `A-${i}`;
        attempts.push(aid);
        state.attempts[aid] = {
          id: aid, task: id, agent: `a${i % 2000}`, role: "build", approach: "",
          model: `model-${i % 20}`, startedAt: T0, leaseUntil: "2026-01-01T02:00:00.000Z",
          lastBeatAt: T0,
        };
        state.index.openAttempts.push(aid);
        (state.index.openByAgent[`a${i % 2000}`] ??= []).push(aid);
        (state.index.openByTask[id] ??= []).push(aid);
      }
      if (i <= 5000) {
        const nid = `N-${i}`;
        notes.push(nid);
        state.notes[nid] = { id: nid, task: id, agent: "a0", kind: "idea", text: "n", at: T0 };
      }
      state.tasks[id] = {
        id, title: id, body: "", parent: null, children: [], status: "open",
        points: 1, postedAt: T0, attempts, notes,
      };
    }
    for (let i = 1; i <= 5000; i += 1) {
      const sid = `S-${i}`;
      state.submissions[sid] = {
        id: sid, attempt: "A-1", task: "T-1", agent: "a0", model: "model-0",
        claim: "solves", message: "", files: [], bytes: 0,
        status: i % 2 === 0 ? "accepted" : "rejected",
        queuedAt: T0, runs: 1, checkedAt: T0, ok: i % 2 === 0,
        exitCode: i % 2 === 0 ? 0 : 1, timedOut: false, durationMs: 1, points: 1,
      };
    }

    const startedAt = performance.now();
    const out = view(state);
    const elapsed = performance.now() - startedAt;
    // eslint-disable-next-line no-console
    console.log(`buildView on 5,000 tasks / 2,000 agents: ${elapsed.toFixed(2)} ms`);

    expect(out.tasks).toHaveLength(5000);
    expect(out.attempts).toHaveLength(500);
    expect(out.notes).toHaveLength(100);
    expect(out.submissions).toHaveLength(100);
    expect(out.agents).toHaveLength(2000);
    expect(elapsed).toBeLessThan(50);
  });
});
