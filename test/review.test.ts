import { describe, expect, test } from "bun:test";
import { decideReview, reviewEligible } from "../src/server/review.ts";
import type {
  AgentState, AttemptState, ReviewVote, Rules, State, SubmissionState,
} from "../src/core/types.ts";

const T0 = "2026-01-01T00:00:00.000Z";

const RULES: Rules = {
  width: 2,
  leaseMinutes: 10,
  maxAttemptsPerAgent: 2,
  roles: { explore: 1, build: 1, attack: 0, distill: 0, plan: 0 },
  accept: { mode: "head" },
  defaultPoints: 3,
};

function makeState(): State {
  return {
    seq: 0,
    rules: RULES,
    agents: {},
    tasks: {},
    attempts: {},
    notes: {},
    submissions: {},
    proposals: {},
    leads: {},
    counters: { task: 1, attempt: 0, note: 0, submission: 1, proposal: 0 },
    index: {
      openByAgent: {},
      openByTask: {},
      openAttempts: [],
      pendingSubmissions: [],
      failures: {},
    },
  };
}

function addAgent(state: State, id: string, accepted = 1, banned = false): AgentState {
  const agent: AgentState = {
    id, publicKey: `pk-${id}`, model: "m", harness: "h", joinedAt: T0, lastSeenAt: T0,
    banned, points: accepted, accepted, submissions: accepted,
  };
  state.agents[id] = agent;
  return agent;
}

function addSubmission(
  state: State,
  id: string,
  agent: string,
  task: string,
  reviews: ReviewVote[] = [],
  status: SubmissionState["status"] = "review",
): SubmissionState {
  const submission: SubmissionState = {
    id, attempt: "A-0", task, agent, model: "m", claim: "solves", message: "",
    files: [], bytes: 0, status, queuedAt: T0, runs: 1, checkedAt: T0, checkedSeq: 0,
    ok: status === "accepted", exitCode: 0, timedOut: false, durationMs: 1,
    points: 0, reviews,
  };
  state.submissions[id] = submission;
  if (status === "review") (state.index.reviewSubmissions ??= []).push(id);
  return submission;
}

function addAttempt(state: State, id: string, task: string, agent: string): AttemptState {
  const attempt: AttemptState = {
    id, task, agent, role: "build", approach: "", model: "m", startedAt: T0,
    leaseUntil: "2026-01-01T00:10:00.000Z", lastBeatAt: T0,
  };
  state.attempts[id] = attempt;
  (state.index.openByTask[task] ??= []).push(id);
  return attempt;
}

function endAttempt(state: State, id: string): void {
  const attempt = state.attempts[id]!;
  attempt.endedAt = T0;
  const list = state.index.openByTask[attempt.task]!;
  list.splice(list.indexOf(id), 1);
  if (list.length === 0) delete state.index.openByTask[attempt.task];
}

const vote = (agent: string, approve: boolean, opts: { reason?: string; head?: boolean } = {}): ReviewVote => ({
  agent, approve, at: T0,
  ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
  ...(opts.head !== undefined ? { head: opts.head } : {}),
});

function setup(): { state: State; submission: SubmissionState } {
  const state = makeState();
  addAgent(state, "aaa"); // author
  addAgent(state, "bbb"); // eligible rival
  addAgent(state, "head");
  const submission = addSubmission(state, "S-1", "aaa", "T-1");
  return { state, submission };
}

describe("decideReview", () => {
  test("none/head decide nothing; votes decide only at the threshold", () => {
    const { state, submission } = setup();
    addAgent(state, "ccc");
    expect(decideReview(state, "S-1", { mode: "none" })).toBeNull();
    expect(decideReview(state, "S-1", { mode: "head" })).toBeNull();

    submission.reviews = [vote("bbb", true)];
    expect(decideReview(state, "S-1", { mode: "votes", votes: 2 })).toBeNull();
    expect(decideReview(state, "S-1", { mode: "head-or-votes", votes: 2 })).toBeNull();
    submission.reviews.push(vote("ccc", true));
    expect(decideReview(state, "S-1", { mode: "votes", votes: 2 })).toEqual({ approved: true });
    expect(decideReview(state, "S-1", { mode: "head-or-votes", votes: 2 })).toEqual({ approved: true });
  });

  test("rejections reach the negative threshold", () => {
    const { state, submission } = setup();
    addAgent(state, "ccc");
    submission.reviews = [vote("bbb", false), vote("ccc", false)];
    expect(decideReview(state, "S-1", { mode: "votes", votes: 2 })).toEqual({ approved: false });
    expect(decideReview(state, "S-1", { mode: "head-or-votes", votes: 2 })).toEqual({ approved: false });
  });

  test("head votes are not counted", () => {
    const { state, submission } = setup();
    submission.reviews = [vote("head", true, { head: true }), vote("bbb", true)];
    expect(decideReview(state, "S-1", { mode: "votes", votes: 2 })).toBeNull();
    expect(decideReview(state, "S-1", { mode: "head-or-votes", votes: 2 })).toBeNull();
  });

  test("re-checks eligibility at decision time but skips the already-voted rule", () => {
    const { state, submission } = setup();
    submission.reviews = [vote("bbb", true), vote("bbb", true)];
    expect(decideReview(state, "S-1", { mode: "votes", votes: 2 })).toEqual({ approved: true });

    state.agents["bbb"]!.banned = true;
    expect(decideReview(state, "S-1", { mode: "votes", votes: 2 })).toBeNull();

    submission.reviews = [vote("aaa", true), vote("head", true, { head: true })];
    expect(decideReview(state, "S-1", { mode: "votes", votes: 1 })).toBeNull();
  });
});

describe("reviewEligible", () => {
  test("refuses the author, unknown agents, banned agents and voters without accepted work", () => {
    const { state } = setup();
    expect(reviewEligible(state, "S-1", "aaa")).toEqual({ ok: false, reason: "author cannot vote" });
    expect(reviewEligible(state, "S-1", "ghost")).toEqual({ ok: false, reason: "unknown agent" });

    state.agents["bbb"]!.banned = true;
    expect(reviewEligible(state, "S-1", "bbb")).toEqual({ ok: false, reason: "agent is banned" });
    state.agents["bbb"]!.banned = false;
    state.agents["bbb"]!.accepted = 0;
    expect(reviewEligible(state, "S-1", "bbb")).toEqual({ ok: false, reason: "no accepted work" });
  });

  test("refuses a rival holding an open attempt on the same task, not on other tasks", () => {
    const { state } = setup();
    addAttempt(state, "A-1", "T-1", "bbb");
    expect(reviewEligible(state, "S-1", "bbb")).toEqual({ ok: false, reason: "open attempt on this task" });
    endAttempt(state, "A-1");
    expect(reviewEligible(state, "S-1", "bbb")).toEqual({ ok: true });

    addAttempt(state, "A-2", "T-2", "bbb");
    expect(reviewEligible(state, "S-1", "bbb")).toEqual({ ok: true });
  });

  test("refuses a rival with another submission in review on the same task", () => {
    const { state } = setup();
    addSubmission(state, "S-2", "bbb", "T-1");
    expect(reviewEligible(state, "S-1", "bbb")).toEqual({
      ok: false, reason: "another submission in review on this task",
    });

    const other = makeState();
    addAgent(other, "aaa");
    addAgent(other, "bbb");
    addSubmission(other, "S-1", "aaa", "T-1");
    addSubmission(other, "S-2", "bbb", "T-2");
    expect(reviewEligible(other, "S-1", "bbb")).toEqual({ ok: true });

    // An already-accepted submission is not "in review" and does not disqualify.
    const accepted = makeState();
    addAgent(accepted, "aaa");
    addAgent(accepted, "bbb");
    addSubmission(accepted, "S-1", "aaa", "T-1");
    addSubmission(accepted, "S-2", "bbb", "T-1", [], "accepted");
    expect(reviewEligible(accepted, "S-1", "bbb")).toEqual({ ok: true });
  });

  test("refuses a second vote with reason 'already voted'", () => {
    const { state, submission } = setup();
    expect(reviewEligible(state, "S-1", "bbb")).toEqual({ ok: true });
    submission.reviews = [vote("bbb", true, { reason: "looks fine" })];
    expect(reviewEligible(state, "S-1", "bbb")).toEqual({ ok: false, reason: "already voted" });
    expect(reviewEligible(state, "S-1", "head")).toEqual({ ok: true });
  });
});
