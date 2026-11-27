import { describe, expect, test } from "bun:test";
import {
  decideByVotes,
  expiredAttempts,
  modelFamily,
  pickTask,
} from "../src/sched/scheduler.ts";
import { initialState, reduce } from "../src/log/reducer.ts";
import type {
  AgentState,
  AttemptState,
  MingaEvent,
  NewEvent,
  Role,
  Rules,
  State,
  SubmissionState,
  TaskState,
} from "../src/core/types.ts";

const BASE = Date.parse("2026-01-01T00:00:00.000Z");
const iso = (minutes: number): string => new Date(BASE + minutes * 60_000).toISOString();
const NOW = new Date(BASE + 30 * 60_000);
const LEASE = iso(90);

function defaultRules(): Rules {
  return {
    width: 3,
    leaseMinutes: 45,
    maxAttemptsPerAgent: 1,
    roles: { explore: 2, build: 5, attack: 2, distill: 1, plan: 0 },
    accept: { mode: "head-or-votes", votes: 3 },
    defaultPoints: 10,
  };
}

function makeState(): State {
  return {
    seq: 0,
    rules: defaultRules(),
    agents: {},
    tasks: {},
    attempts: {},
    notes: {},
    submissions: {},
    proposals: {},
    counters: { task: 0, attempt: 0, note: 0, submission: 0, proposal: 0 },
    index: {
      openByAgent: {},
      openByTask: {},
      openAttempts: [],
      pendingSubmissions: [],
      failures: {},
    },
  };
}

function addAgent(
  state: State,
  id: string,
  model = "claude-3-opus",
  overrides: Partial<AgentState> = {},
): AgentState {
  const agent: AgentState = {
    id,
    publicKey: "key",
    model,
    harness: "test",
    joinedAt: iso(0),
    lastSeenAt: iso(0),
    banned: false,
    points: 0,
    accepted: 1,
    submissions: 0,
    ...overrides,
  };
  state.agents[id] = agent;
  return agent;
}

function addTask(state: State, id: string, overrides: Partial<TaskState> = {}): TaskState {
  const task: TaskState = {
    id,
    title: id,
    body: "",
    parent: null,
    children: [],
    status: "open",
    points: 10,
    postedAt: iso(0),
    attempts: [],
    notes: [],
    ...overrides,
  };
  state.tasks[id] = task;
  return task;
}

function addAttempt(
  state: State,
  id: string,
  task: string,
  agent: string,
  overrides: Partial<AttemptState> = {},
): AttemptState {
  const attempt: AttemptState = {
    id,
    task,
    agent,
    role: "build",
    approach: "",
    model: "gpt-4o",
    startedAt: iso(0),
    leaseUntil: LEASE,
    lastBeatAt: iso(0),
    ...overrides,
  };
  state.attempts[id] = attempt;
  state.tasks[task]?.attempts.push(id);
  if (attempt.endedAt === undefined) {
    (state.index.openByAgent[attempt.agent] ??= []).push(id);
    (state.index.openByTask[attempt.task] ??= []).push(id);
    state.index.openAttempts.push(id);
  }
  return attempt;
}

/** Declare file intents on an attempt and index them in openByPath. */
function declarePaths(state: State, attemptId: string, paths: string[]): void {
  const attempt = state.attempts[attemptId]!;
  attempt.paths = paths;
  const byPath = (state.index.openByPath ??= {});
  for (const path of paths) (byPath[path] ??= []).push(attemptId);
}

function addSubmission(
  state: State,
  id: string,
  task: string,
  agent: string,
  ok: boolean,
  overrides: Partial<SubmissionState> = {},
): SubmissionState {
  const status = overrides.status ?? (ok ? "accepted" : "rejected");
  const submission: SubmissionState = {
    id,
    attempt: "A-0",
    task,
    agent,
    model: "gpt-4o",
    claim: "progress",
    files: [],
    message: "",
    bytes: 0,
    status,
    queuedAt: iso(0),
    runs: 1,
    checkedAt: iso(1),
    ok,
    exitCode: ok ? 0 : 1,
    timedOut: false,
    durationMs: 1,
    points: ok ? 5 : 0,
    ...overrides,
  };
  state.submissions[id] = submission;
  if (status === "queued" || status === "checking") state.index.pendingSubmissions.push(id);
  if (!ok && !submission.stale) {
    const byTask = (state.index.failures[agent] ??= {});
    byTask[task] = (byTask[task] ?? 0) + 1;
  }
  return submission;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("modelFamily", () => {
  test("lowercases and cuts at the first separator", () => {
    expect(modelFamily("Claude-3-Opus")).toBe("claude");
    expect(modelFamily("openai/gpt-4o")).toBe("openai");
    expect(modelFamily("qwen:7b")).toBe("qwen");
    expect(modelFamily("mystery")).toBe("mystery");
    expect(modelFamily("")).toBe("unknown");
    expect(modelFamily("   ")).toBe("unknown");
  });
});

describe("expiredAttempts", () => {
  test("returns unended attempts with a lease at or before now", () => {
    const state = makeState();
    addTask(state, "T-1");
    addAttempt(state, "A-1", "T-1", "a", { leaseUntil: iso(30) });
    addAttempt(state, "A-2", "T-1", "b", { leaseUntil: iso(31) });
    addAttempt(state, "A-3", "T-1", "c", { leaseUntil: iso(10), endedAt: iso(10) });

    expect(expiredAttempts(state, NOW)).toEqual(["A-1"]);
  });

  test("skips attempts with a pending submission", () => {
    const state = makeState();
    addTask(state, "T-1");
    addTask(state, "T-2");
    addAttempt(state, "A-1", "T-1", "a", { leaseUntil: iso(10) });
    addAttempt(state, "A-2", "T-2", "b", { leaseUntil: iso(12) });
    addSubmission(state, "S-1", "T-1", "a", true, { status: "queued", attempt: "A-1" });

    expect(expiredAttempts(state, NOW)).toEqual(["A-2"]);
  });
});

describe("pickTask", () => {
  test("returns null for a banned agent", () => {
    const state = makeState();
    addAgent(state, "me", "claude-3", { banned: true });
    addTask(state, "T-1");
    expect(pickTask({ state, agent: "me", now: NOW, rng: () => 0 })).toBeNull();
  });

  test("returns null when there is no candidate", () => {
    const state = makeState();
    addAgent(state, "me");
    expect(pickTask({ state, agent: "me", now: NOW, rng: () => 0 })).toBeNull();
  });

  test("respects rules.width", () => {
    const state = makeState();
    state.rules.width = 1;
    state.rules.maxAttemptsPerAgent = 5;
    addAgent(state, "me", "claude-3");
    addAgent(state, "other", "gpt-4");
    addTask(state, "T-1");
    addAttempt(state, "A-1", "T-1", "other", { model: "gpt-4" });

    expect(pickTask({ state, agent: "me", now: NOW, rng: () => 0 })).toBeNull();
  });

  test("respects rules.maxAttemptsPerAgent", () => {
    const state = makeState();
    state.rules.maxAttemptsPerAgent = 1;
    addAgent(state, "me", "claude-3");
    addTask(state, "T-1");
    addTask(state, "T-2");
    addAttempt(state, "A-1", "T-1", "me", { model: "claude-3" });

    expect(pickTask({ state, agent: "me", now: NOW, rng: () => 0 })).toBeNull();
  });

  test("ended attempts free capacity", () => {
    const state = makeState();
    state.rules.maxAttemptsPerAgent = 1;
    addAgent(state, "me", "claude-3");
    addTask(state, "T-1");
    addTask(state, "T-2");
    addAttempt(state, "A-1", "T-1", "me", { model: "claude-3", endedAt: iso(10) });

    expect(pickTask({ state, agent: "me", now: NOW, rng: () => 0 })).not.toBeNull();
  });

  test("expired leases neither count toward width nor block the holder", () => {
    const state = makeState();
    state.rules.width = 1;
    state.rules.maxAttemptsPerAgent = 5;
    addAgent(state, "me", "claude-3");
    addAgent(state, "other", "gpt-4");
    addTask(state, "T-1");
    addAttempt(state, "A-1", "T-1", "other", { model: "gpt-4", leaseUntil: iso(30) });

    expect(pickTask({ state, agent: "me", now: NOW, rng: () => 0 })?.task).toBe("T-1");
  });

  test("a lease one millisecond in the future is still live", () => {
    const state = makeState();
    state.rules.width = 1;
    state.rules.maxAttemptsPerAgent = 5;
    addAgent(state, "me", "claude-3");
    addAgent(state, "other", "gpt-4");
    addTask(state, "T-1");
    addAttempt(state, "A-1", "T-1", "other", {
      model: "gpt-4",
      leaseUntil: new Date(NOW.getTime() + 1).toISOString(),
    });

    expect(pickTask({ state, agent: "me", now: NOW, rng: () => 0 })).toBeNull();
  });

  test("prefers a task with no attempt from the same model family", () => {
    const state = makeState();
    state.rules.maxAttemptsPerAgent = 5;
    addAgent(state, "me", "claude-4-sonnet");
    addAgent(state, "other");
    addTask(state, "T-1");
    addTask(state, "T-2");
    addAttempt(state, "A-1", "T-1", "other", { model: "claude-3-opus" });
    addAttempt(state, "A-2", "T-2", "other", { model: "gpt-4o" });

    expect(pickTask({ state, agent: "me", now: NOW, rng: () => 0 })?.task).toBe("T-2");

    const reversed = makeState();
    reversed.rules.maxAttemptsPerAgent = 5;
    addAgent(reversed, "me", "claude-4-sonnet");
    addAgent(reversed, "other");
    addTask(reversed, "T-2");
    addTask(reversed, "T-1");
    addAttempt(reversed, "A-2", "T-2", "other", { model: "gpt-4o" });
    addAttempt(reversed, "A-1", "T-1", "other", { model: "claude-3-opus" });

    expect(pickTask({ state: reversed, agent: "me", now: NOW, rng: () => 0 })?.task).toBe("T-2");
  });

  test("prefers untouched tasks over tasks with live attempts", () => {
    const state = makeState();
    state.rules.maxAttemptsPerAgent = 5;
    addAgent(state, "me", "claude-4");
    addAgent(state, "other");
    addTask(state, "T-1");
    addTask(state, "T-2");
    addAttempt(state, "A-1", "T-1", "other", { model: "claude-3" });

    expect(pickTask({ state, agent: "me", now: NOW, rng: () => 0 })?.task).toBe("T-2");
  });

  test("skips non-leaf and closed tasks", () => {
    const state = makeState();
    addAgent(state, "me");
    addTask(state, "T-1", { children: ["T-2"] });
    addTask(state, "T-2");
    addTask(state, "T-3", { status: "solved" });

    expect(pickTask({ state, agent: "me", now: NOW, rng: () => 0 })?.task).toBe("T-2");

    state.tasks["T-2"]!.status = "withdrawn";
    expect(pickTask({ state, agent: "me", now: NOW, rng: () => 0 })).toBeNull();
  });

  test("avoids tasks the agent has already failed", () => {
    const state = makeState();
    addAgent(state, "me");
    addTask(state, "T-1");
    addTask(state, "T-2");
    addSubmission(state, "S-1", "T-1", "me", false);

    expect(pickTask({ state, agent: "me", now: NOW, rng: () => 0 })?.task).toBe("T-2");
  });

  test("only the agent's own failures penalize a task", () => {
    const state = makeState();
    addAgent(state, "me");
    addAgent(state, "other");
    addTask(state, "T-1");
    addTask(state, "T-2");
    addSubmission(state, "S-1", "T-2", "other", false);

    // Both tasks are otherwise identical, so the first-seen task wins on the tie.
    expect(pickTask({ state, agent: "me", now: NOW, rng: () => 0 })?.task).toBe("T-1");
  });

  test("a pending submission holds a task and the agent's slot past the lease", () => {
    const state = makeState();
    state.rules.maxAttemptsPerAgent = 1;
    addAgent(state, "me", "claude-3");
    addTask(state, "T-1");
    addTask(state, "T-2");
    addAttempt(state, "A-1", "T-1", "me", { leaseUntil: iso(10) });
    addSubmission(state, "S-1", "T-1", "me", true, { status: "checking", attempt: "A-1" });

    expect(pickTask({ state, agent: "me", now: NOW, rng: () => 0 })).toBeNull();
  });

  test("uses the failure index instead of scanning submissions", () => {
    const state = makeState();
    addAgent(state, "me");
    addTask(state, "T-1");
    addTask(state, "T-2");
    addSubmission(state, "S-1", "T-1", "me", false);
    // A recorded failure without a submission record still counts.
    state.index.failures["me"] = { "T-1": 2 };
    delete state.submissions["S-1"];

    expect(pickTask({ state, agent: "me", now: NOW, rng: () => 0 })?.task).toBe("T-2");
  });

  /** Build a state where "me" started then released the first of `taskIds`. */
  function stateAfterRelease(taskIds: string[]): State {
    const state = initialState(defaultRules());
    let seq = 0;
    const fold = (event: NewEvent, at = iso(0)): void => {
      seq += 1;
      reduce(state, { ...event, seq, at } as MingaEvent);
    };
    fold({
      type: "agent.joined", actor: "me",
      data: { agent: "me", publicKey: "k", model: "claude-3", harness: "test", rejoin: false },
    });
    for (const id of taskIds) {
      fold({
        type: "task.posted", actor: "server",
        data: { task: id, title: id, body: "", parent: null, points: 10, by: "config" },
      });
    }
    fold({
      type: "attempt.started", actor: "me",
      data: {
        attempt: "A-1", task: taskIds[0]!, agent: "me", role: "build",
        approach: "", model: "claude-3", leaseUntil: LEASE,
      },
    });
    fold({ type: "attempt.ended", actor: "me", data: { attempt: "A-1", reason: "released" } }, iso(5));
    return state;
  }

  test("a released task is skipped while another open task exists", () => {
    const state = stateAfterRelease(["T-1", "T-2"]);
    expect(state.index.failures).toEqual({ me: { "T-1": 1 } });

    // Both tasks are otherwise identical; only the release tier steers away from T-1.
    expect(pickTask({ state, agent: "me", now: NOW, rng: () => 0 })?.task).toBe("T-2");
  });

  test("a released task is still pickable when it is the only open task", () => {
    const state = stateAfterRelease(["T-1"]);
    expect(pickTask({ state, agent: "me", now: NOW, rng: () => 0 })?.task).toBe("T-1");
  });

  test("a failed task is never chosen while any un-failed task remains", () => {
    const state = makeState();
    state.rules.maxAttemptsPerAgent = 5;
    addAgent(state, "me", "claude-4-sonnet");
    addTask(state, "T-1");
    addTask(state, "T-2");
    addTask(state, "T-3");
    // T-1 is failed by release and also the newest/most attractive otherwise.
    state.index.failures["me"] = { "T-1": 3 };
    addAttempt(state, "A-1", "T-2", "other", { model: "gpt-4" });
    addAttempt(state, "A-2", "T-3", "other", { model: "gpt-4" });
    state.tasks["T-1"]!.postedAt = iso(20);

    const picked = pickTask({ state, agent: "me", now: NOW, rng: () => 0 })?.task;
    expect(picked).not.toBe("T-1");
    expect(["T-2", "T-3"]).toContain(picked!);
  });

  test("a candidate path overlapping a live attempt on another task loses points", () => {
    const state = makeState();
    state.rules.maxAttemptsPerAgent = 5;
    addAgent(state, "me", "claude-3");
    addAgent(state, "other", "gpt-4");
    addTask(state, "T-1", { paths: ["src/scheduler.ts"] });
    addTask(state, "T-2", { paths: ["src/reducer.ts"] });
    // Closed task holds the colliding live attempt so it is not a candidate.
    addTask(state, "T-3", { status: "solved" });
    addAttempt(state, "A-1", "T-3", "other", { model: "gpt-4" });
    declarePaths(state, "A-1", ["src/scheduler.ts"]);

    // Equal base scores; only the -3 cross-task penalty steers away from T-1.
    expect(pickTask({ state, agent: "me", now: NOW, rng: () => 0 })?.task).toBe("T-2");
  });

  test("directory and file path overlaps are detected in both directions", () => {
    const build = (taskPath: string, livePath: string): State => {
      const state = makeState();
      state.rules.maxAttemptsPerAgent = 5;
      addAgent(state, "me", "claude-3");
      addAgent(state, "other", "gpt-4");
      addTask(state, "T-1", { paths: [taskPath] });
      addTask(state, "T-2", { paths: ["src/unrelated.ts"] });
      addTask(state, "T-3", { status: "solved" });
      addAttempt(state, "A-1", "T-3", "other", { model: "gpt-4" });
      declarePaths(state, "A-1", [livePath]);
      return state;
    };

    // The candidate is a directory prefix of the live path.
    expect(pickTask({
      state: build("src/sched/", "src/sched/scheduler.ts"),
      agent: "me", now: NOW, rng: () => 0,
    })?.task).toBe("T-2");

    // The live attempt is a directory prefix of the candidate's path.
    expect(pickTask({
      state: build("src/sched/scheduler.ts", "src/sched/"),
      agent: "me", now: NOW, rng: () => 0,
    })?.task).toBe("T-2");
  });

  test("an expired attempt's paths do not penalise a candidate", () => {
    const state = makeState();
    state.rules.maxAttemptsPerAgent = 5;
    addAgent(state, "me", "claude-3");
    addAgent(state, "other", "gpt-4");
    addTask(state, "T-1", { paths: ["src/scheduler.ts"] });
    addTask(state, "T-2", { paths: ["src/reducer.ts"] });
    addTask(state, "T-3", { status: "solved" });
    addAttempt(state, "A-1", "T-3", "other", { model: "gpt-4", leaseUntil: iso(10) });
    declarePaths(state, "A-1", ["src/scheduler.ts"]);

    // A-1 is not live, so both candidates tie and the first-seen one wins.
    expect(pickTask({ state, agent: "me", now: NOW, rng: () => 0 })?.task).toBe("T-1");
  });

  test("overlap with a live attempt on the same task is not penalised", () => {
    const state = makeState();
    state.rules.maxAttemptsPerAgent = 5;
    addAgent(state, "me", "claude-3");
    addAgent(state, "other", "gpt-4");
    addTask(state, "T-1", { paths: ["src/a.ts"] });
    addTask(state, "T-2", { paths: ["src/b.ts"] });
    addAttempt(state, "A-1", "T-1", "other", { model: "gpt-4" });
    declarePaths(state, "A-1", ["src/a.ts"]);
    addAttempt(state, "A-2", "T-2", "other", { model: "gpt-4" });
    declarePaths(state, "A-2", ["src/c.ts"]);

    // Both tasks have one gpt-4 attempt; only T-1 has a same-task path overlap.
    expect(pickTask({ state, agent: "me", now: NOW, rng: () => 0 })?.task).toBe("T-1");
  });

  test("a dead end by the same model family demotes a task to the fallback tier", () => {
    const state = makeState();
    addAgent(state, "me", "claude-opus-5.5");
    addTask(state, "T-1");
    addTask(state, "T-2");
    state.index.deadEnds = { "T-1": ["claude-sonnet-5.5"] };

    expect(pickTask({ state, agent: "me", now: NOW, rng: () => 0 })?.task).toBe("T-2");

    // With nothing else free, the demoted task is offered.
    state.tasks["T-2"]!.status = "solved";
    expect(pickTask({ state, agent: "me", now: NOW, rng: () => 0 })?.task).toBe("T-1");
  });

  test("a dead end by another model family does not demote a task", () => {
    const state = makeState();
    addAgent(state, "me", "claude-opus-5.5");
    addTask(state, "T-1");
    addTask(state, "T-2");
    state.index.deadEnds = { "T-1": ["gpt-6"] };

    expect(pickTask({ state, agent: "me", now: NOW, rng: () => 0 })?.task).toBe("T-1");
  });

  test("old states without openByPath or deadEnds still work", () => {
    const state = makeState();
    addAgent(state, "me", "claude-3");
    addAgent(state, "other", "gpt-4");
    addTask(state, "T-1", { paths: ["src/a.ts"] });
    addTask(state, "T-2", { paths: ["src/b.ts"] });
    // Attempts carry paths but the new index fields were never populated.
    addAttempt(state, "A-1", "T-1", "other", { model: "gpt-4", paths: ["src/a.ts"] });
    addAttempt(state, "A-2", "T-2", "other", { model: "gpt-4", paths: ["src/b.ts"] });

    expect(state.index.openByPath).toBeUndefined();
    expect(state.index.deadEnds).toBeUndefined();
    expect(pickTask({ state, agent: "me", now: NOW, rng: () => 0 })?.task).toBe("T-1");
  });

  test("5,000 tasks and 2,000 two-path attempts pick under 50 ms average", () => {
    const state = makeState();
    state.rules.width = 5;
    state.rules.maxAttemptsPerAgent = 5;
    for (let i = 0; i < 2000; i += 1) addAgent(state, `a${i}`, `model-${i % 20}`);
    for (let i = 1; i <= 5000; i += 1) {
      addTask(state, `T-${i}`, { paths: [`src/t${i}/a.ts`, `src/t${i}/b.ts`] });
    }
    for (let i = 0; i < 2000; i += 1) {
      const id = `A-${i + 1}`;
      addAttempt(state, id, `T-${i + 1}`, `a${i}`, { leaseUntil: LEASE });
      declarePaths(state, id, [`src/t${i + 1}/a.ts`, `src/t${i + 1}/b.ts`]);
    }

    const rng = mulberry32(123);
    const startedAt = performance.now();
    for (let i = 0; i < 1000; i += 1) {
      expect(pickTask({ state, agent: `a${i % 2000}`, now: NOW, rng })).not.toBeNull();
    }
    const avg = (performance.now() - startedAt) / 1000;
    // eslint-disable-next-line no-console
    console.log(`1,000 picks over 5,000 tasks / 2,000 attempts: ${avg.toFixed(3)} ms avg`);
    expect(avg).toBeLessThan(50);
  }, 30_000);

  test("1,000 picks over 5,000 tasks and 2,000 agents average under 3 ms", () => {
    const state = makeState();
    state.rules.width = 5;
    state.rules.maxAttemptsPerAgent = 5;
    for (let i = 0; i < 2000; i += 1) addAgent(state, `a${i}`, `model-${i % 20}`);
    for (let i = 1; i <= 5000; i += 1) addTask(state, `T-${i}`);
    for (let i = 0; i < 200; i += 1) {
      addAttempt(state, `A-${i + 1}`, `T-${i + 1}`, `a${i}`, { leaseUntil: LEASE });
    }
    const rng = mulberry32(99);
    const startedAt = performance.now();
    for (let i = 0; i < 1000; i += 1) {
      expect(pickTask({ state, agent: `a${i % 2000}`, now: NOW, rng })).not.toBeNull();
    }
    const avg = (performance.now() - startedAt) / 1000;
    // eslint-disable-next-line no-console
    console.log(`1,000 pickTask calls: ${avg.toFixed(3)} ms avg`);
    // ~1.1-1.3 ms alone; after the path-intent tests have run (JIT state) and on a loaded
    // machine it reaches ~2.5 ms. next is long-polled, so 3 ms over 5,000 tasks is fine.
    expect(avg).toBeLessThan(3);
  }, 30_000);

  test("is deterministic with a seeded rng", () => {
    const build = (): State => {
      const state = makeState();
      addAgent(state, "me", "claude-3");
      addTask(state, "T-1");
      addTask(state, "T-2");
      return state;
    };

    const first = pickTask({ state: build(), agent: "me", now: NOW, rng: mulberry32(42) });
    const second = pickTask({ state: build(), agent: "me", now: NOW, rng: mulberry32(42) });

    expect(first).toEqual(second);
    expect(first).not.toBeNull();
    expect(["T-1", "T-2"]).toContain(first!.task);
  });

  test("selects roles by weight and never picks a zero-weight role", () => {
    const state = makeState();
    addAgent(state, "me");
    addTask(state, "T-1");

    state.rules.roles = { explore: 0, build: 0, attack: 0, distill: 0, plan: 1 };
    expect(pickTask({ state, agent: "me", now: NOW, rng: () => 0 })?.role).toBe("plan");

    state.rules.roles = { explore: 0, build: 1, attack: 1, distill: 0, plan: 0 };
    const rng = mulberry32(7);
    const seen = new Set<Role>();
    for (let i = 0; i < 200; i += 1) {
      const pick = pickTask({ state, agent: "me", now: NOW, rng });
      expect(pick).not.toBeNull();
      seen.add(pick!.role);
    }
    expect(seen.has("explore")).toBe(false);
    expect(seen.has("distill")).toBe(false);
    expect(seen.has("plan")).toBe(false);
    expect(seen.has("build")).toBe(true);
    expect(seen.has("attack")).toBe(true);
  });
});

describe("decideByVotes", () => {
  function setup(): State {
    const state = makeState();
    addAgent(state, "proposer", "claude-3", { accepted: 5 });
    addAgent(state, "a", "claude-3", { accepted: 1 });
    addAgent(state, "b", "gpt-4", { accepted: 2 });
    addAgent(state, "c", "gpt-4", { accepted: 0 });
    addAgent(state, "banned", "gpt-4", { accepted: 9, banned: true });
    return state;
  }

  function propose(state: State, votes: Record<string, boolean>): void {
    state.proposals["P-1"] = {
      id: "P-1",
      agent: "proposer",
      kind: "new_task",
      task: null,
      at: iso(0),
      votes,
    };
  }

  test("accepts at the approval threshold, ignoring the proposer and ineligible voters", () => {
    const state = setup();
    state.rules.accept = { mode: "head-or-votes", votes: 2 };
    propose(state, { proposer: true, a: true, b: true, c: true, banned: true });

    expect(decideByVotes(state, "P-1")).toEqual({ accepted: true });
  });

  test("returns null below the threshold", () => {
    const state = setup();
    state.rules.accept = { mode: "head-or-votes", votes: 2 };
    propose(state, { proposer: true, a: true, c: true, banned: true });

    expect(decideByVotes(state, "P-1")).toBeNull();
  });

  test("rejects at the rejection threshold", () => {
    const state = setup();
    state.rules.accept = { mode: "votes", votes: 2 };
    propose(state, { proposer: true, a: false, b: false, c: false });

    expect(decideByVotes(state, "P-1")).toEqual({ accepted: false });
  });

  test("never counts the proposer's own vote", () => {
    const state = setup();
    state.rules.accept = { mode: "votes", votes: 1 };
    propose(state, { proposer: true });
    expect(decideByVotes(state, "P-1")).toBeNull();

    state.proposals["P-1"]!.votes["a"] = true;
    expect(decideByVotes(state, "P-1")).toEqual({ accepted: true });
  });

  test("an already decided or missing proposal yields null", () => {
    const state = setup();
    state.rules.accept = { mode: "votes", votes: 1 };
    propose(state, { a: true });
    state.proposals["P-1"]!.decided = { accepted: true, by: "vote", at: iso(1) };
    expect(decideByVotes(state, "P-1")).toBeNull();
    expect(decideByVotes(state, "P-404")).toBeNull();
  });

  test("head mode never decides by votes", () => {
    const state = setup();
    state.rules.accept = { mode: "head" };
    propose(state, { a: true, b: true });

    expect(decideByVotes(state, "P-1")).toBeNull();
  });
});
