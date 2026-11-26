import { describe, expect, test } from "bun:test";
import {
  decideByVotes,
  expiredAttempts,
  modelFamily,
  pickTask,
} from "../src/sched/scheduler.ts";
import type {
  AgentState,
  AttemptState,
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
  return attempt;
}

function addSubmission(
  state: State,
  id: string,
  task: string,
  agent: string,
  ok: boolean,
  overrides: Partial<SubmissionState> = {},
): SubmissionState {
  const submission: SubmissionState = {
    submission: id,
    attempt: "A-0",
    task,
    agent,
    model: "gpt-4o",
    claim: "progress",
    files: [],
    ok,
    exitCode: ok ? 0 : 1,
    timedOut: false,
    outputTail: "",
    durationMs: 1,
    points: ok ? 5 : 0,
    at: iso(0),
    ...overrides,
  };
  state.submissions[id] = submission;
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
