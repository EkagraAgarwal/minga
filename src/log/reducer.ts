/**
 * State is a pure fold over the event log. No I/O, no clock: every timestamp
 * comes from `event.at`, so replaying the same log always yields the same
 * state.
 *
 * Alongside the records the reducer keeps `state.index`: small lists of open
 * work so readers (view, scheduler) never have to scan all attempts or
 * submissions.
 */
import type {
  AgentLiveAttempts, ComputeLeaderboard, InitialState, IsLive, LiveAttempts,
  NextId, Reduce, Replay,
} from "../core/contracts.ts";
import type {
  AgentState, AttemptState, LeaderRow, ModelRow, MingaEvent, NoteState, ProposalState,
  ReviewVote, Rules, State, StateIndex, SubmissionState, TaskState,
} from "../core/types.ts";

const PREFIX: Record<"task" | "attempt" | "note" | "submission" | "proposal", string> = {
  task: "T",
  attempt: "A",
  note: "N",
  submission: "S",
  proposal: "P",
};

/** Numeric suffix of an id like "T-12", or 0 when absent/not numeric. */
function idNumber(id: string): number {
  const dash = id.lastIndexOf("-");
  const tail = dash >= 0 ? id.slice(dash + 1) : id;
  const n = Number.parseInt(tail, 10);
  return Number.isFinite(n) ? n : 0;
}

/** Rule factory so the initialState never aliases the caller's config object. */
function cloneRules(rules: Rules): Rules {
  return {
    ...rules,
    roles: { ...rules.roles },
    accept: { ...rules.accept },
  };
}

function emptyIndex(): StateIndex {
  return {
    openByAgent: {},
    openByTask: {},
    openAttempts: [],
    pendingSubmissions: [],
    failures: {},
    openQuestions: {},
    digests: {},
    deadEnds: {},
    openByPath: {},
    unnotified: {},
    inbox: {},
    leadAreas: {},
  };
}

/** Fills index maps added after 0.1.x, for states built by older code or tests. */
function upgradeIndex(index: StateIndex): Required<StateIndex> {
  index.openQuestions ??= {};
  index.digests ??= {};
  index.deadEnds ??= {};
  index.openByPath ??= {};
  index.unnotified ??= {};
  index.inbox ??= {};
  index.leadAreas ??= {};
  return index as Required<StateIndex>;
}

const INBOX_KEEP = 50;

function addToList(map: Record<string, string[]>, key: string, id: string): void {
  const list = (map[key] ??= []);
  if (!list.includes(id)) list.push(id);
}

function removeFromList(map: Record<string, string[]>, key: string, id: string): void {
  const list = map[key];
  if (!list) return;
  removeId(list, id);
  if (list.length === 0) delete map[key];
}

function indexPaths(index: Required<StateIndex>, attempt: AttemptState): void {
  for (const path of attempt.paths ?? []) addToList(index.openByPath, path, attempt.id);
}

function unindexPaths(index: Required<StateIndex>, attempt: AttemptState): void {
  for (const path of attempt.paths ?? []) removeFromList(index.openByPath, path, attempt.id);
}

function recordDeadEnd(index: Required<StateIndex>, task: string, model: string): void {
  (index.deadEnds[task] ??= []).push(model);
}

/** Remove every occurrence of `id` (normally one) without changing oldest-first order. */
function removeId(list: string[], id: string): void {
  for (let i = list.indexOf(id); i !== -1; i = list.indexOf(id)) list.splice(i, 1);
}

function indexAttempt(index: StateIndex, attempt: AttemptState): void {
  (index.openByAgent[attempt.agent] ??= []).push(attempt.id);
  (index.openByTask[attempt.task] ??= []).push(attempt.id);
  index.openAttempts.push(attempt.id);
}

function unindexAttempt(index: StateIndex, attempt: AttemptState): void {
  const byAgent = index.openByAgent[attempt.agent];
  if (byAgent) {
    removeId(byAgent, attempt.id);
    if (byAgent.length === 0) delete index.openByAgent[attempt.agent];
  }
  const byTask = index.openByTask[attempt.task];
  if (byTask) {
    removeId(byTask, attempt.id);
    if (byTask.length === 0) delete index.openByTask[attempt.task];
  }
  removeId(index.openAttempts, attempt.id);
}

/** True when an attempt's submission is still queued or checking. */
function hasPendingSubmission(state: State, attemptId: string): boolean {
  for (const id of state.index.pendingSubmissions) {
    if (state.submissions[id]?.attempt === attemptId) return true;
  }
  return false;
}

export const initialState: InitialState = (rules: Rules): State => ({
  seq: 0,
  rules: cloneRules(rules),
  agents: {},
  tasks: {},
  attempts: {},
  notes: {},
  submissions: {},
  proposals: {},
  leads: {},
  counters: { task: 0, attempt: 0, note: 0, submission: 0, proposal: 0 },
  index: emptyIndex(),
});

export const reduce: Reduce = (state: State, event: MingaEvent): State => {
  if (event.seq !== state.seq + 1) {
    throw new Error(
      `event seq gap: expected ${state.seq + 1}, got ${event.seq} (${event.type})`,
    );
  }
  state.seq = event.seq;
  const at = event.at;
  // States replayed from older code may not have the index yet.
  state.index ??= emptyIndex();
  const index = upgradeIndex(state.index);
  state.leads ??= {};
  const leads = state.leads;

  // Any event by a known agent is a heartbeat.
  if (event.actor !== "server") {
    const actor = state.agents[event.actor];
    if (actor) actor.lastSeenAt = at;
  }

  switch (event.type) {
    case "agent.joined": {
      const d = event.data;
      const existing = state.agents[d.agent];
      if (existing) {
        existing.model = d.model;
        existing.harness = d.harness;
        existing.owner = d.owner;
        existing.lastSeenAt = at;
      } else {
        const agent: AgentState = {
          id: d.agent,
          publicKey: d.publicKey,
          model: d.model,
          harness: d.harness,
          joinedAt: at,
          lastSeenAt: at,
          banned: false,
          points: 0,
          accepted: 0,
          submissions: 0,
        };
        if (d.owner !== undefined) agent.owner = d.owner;
        state.agents[d.agent] = agent;
      }
      break;
    }

    case "agent.banned": {
      const agent = state.agents[event.data.agent];
      if (agent) agent.banned = true;
      break;
    }

    case "task.posted": {
      const d = event.data;
      const task: TaskState = {
        id: d.task,
        title: d.title,
        body: d.body,
        parent: d.parent,
        children: [],
        status: "open",
        points: d.points,
        postedAt: at,
        attempts: [],
        notes: [],
      };
      if (d.paths !== undefined && d.paths.length > 0) task.paths = [...d.paths];
      state.tasks[d.task] = task;
      if (d.parent !== null) state.tasks[d.parent]?.children.push(d.task);
      state.counters.task = Math.max(state.counters.task, idNumber(d.task));
      break;
    }

    case "task.closed": {
      const d = event.data;
      const task = state.tasks[d.task];
      if (task) {
        task.status = d.status;
        task.closedAt = at;
        if (d.agent !== undefined) task.closedBy = d.agent;
        if (d.submission !== undefined) task.closedSubmission = d.submission;
      }
      break;
    }

    case "attempt.started": {
      const d = event.data;
      const task = state.tasks[d.task];
      if (!task) break; // unknown task: ignore, never throw
      const attempt: AttemptState = {
        id: d.attempt,
        task: d.task,
        agent: d.agent,
        role: d.role,
        approach: d.approach,
        model: d.model,
        startedAt: at,
        leaseUntil: d.leaseUntil,
        lastBeatAt: at,
      };
      const paths = d.paths ?? task.paths;
      if (paths !== undefined && paths.length > 0) attempt.paths = [...paths];
      state.attempts[d.attempt] = attempt;
      task.attempts.push(d.attempt);
      indexAttempt(index, attempt);
      indexPaths(index, attempt);
      const agent = state.agents[d.agent];
      if (agent) agent.model = d.model;
      state.counters.attempt = Math.max(state.counters.attempt, idNumber(d.attempt));
      break;
    }

    case "attempt.beat": {
      const d = event.data;
      const attempt = state.attempts[d.attempt];
      if (!attempt) break;
      attempt.leaseUntil = d.leaseUntil;
      attempt.lastBeatAt = at;
      if (d.approach !== undefined) attempt.approach = d.approach;
      if (d.paths !== undefined) {
        const open = attempt.endedAt === undefined;
        if (open) unindexPaths(index, attempt);
        if (d.paths.length > 0) attempt.paths = [...d.paths];
        else delete attempt.paths;
        if (open) indexPaths(index, attempt);
      }
      if (d.model !== undefined) {
        attempt.model = d.model;
        const agent = state.agents[attempt.agent];
        if (agent) agent.model = d.model;
      }
      break;
    }

    case "attempt.ended": {
      const d = event.data;
      const attempt = state.attempts[d.attempt];
      if (!attempt) break;
      if (attempt.endedAt === undefined) {
        unindexAttempt(index, attempt);
        unindexPaths(index, attempt);
      }
      attempt.endedAt = at;
      attempt.endReason = d.reason;
      if (d.why !== undefined) {
        attempt.releaseReason = d.why;
        if (d.why === "dead_end") recordDeadEnd(index, attempt.task, attempt.model);
      }
      if (d.reason === "task_closed" && attempt.notifiedAt === undefined) {
        addToList(index.unnotified, attempt.agent, attempt.id);
      }
      // A release means the agent gave up on this task: reuse the rejection
      // counter so the scheduler steers it elsewhere while other work exists.
      if (d.reason === "released") {
        const byTask = (index.failures[attempt.agent] ??= {});
        byTask[attempt.task] = (byTask[attempt.task] ?? 0) + 1;
      }
      break;
    }

    case "attempt.notified": {
      const d = event.data;
      const attempt = state.attempts[d.attempt];
      if (attempt && attempt.notifiedAt === undefined) attempt.notifiedAt = at;
      removeFromList(index.unnotified, d.agent, d.attempt);
      break;
    }

    case "lead.granted": {
      const d = event.data;
      addToList(leads, d.area, d.agent);
      addToList(index.leadAreas, d.agent, d.area);
      break;
    }

    case "lead.revoked": {
      const d = event.data;
      removeFromList(leads, d.area, d.agent);
      removeFromList(index.leadAreas, d.agent, d.area);
      break;
    }

    case "note.added": {
      const d = event.data;
      const task = state.tasks[d.task];
      if (!task) break;
      const note: NoteState = {
        id: d.note,
        task: d.task,
        agent: d.agent,
        kind: d.kind,
        text: d.text,
        at,
      };
      if (d.replyTo !== undefined) note.replyTo = d.replyTo;
      if (d.to !== undefined) note.to = d.to;
      state.notes[d.note] = note;
      task.notes.unshift(d.note);
      state.counters.note = Math.max(state.counters.note, idNumber(d.note));
      if (d.replyTo !== undefined) {
        const parent = state.notes[d.replyTo];
        if (parent) {
          parent.replies = (parent.replies ?? 0) + 1;
          if (parent.kind === "question") removeFromList(index.openQuestions, parent.task, parent.id);
        }
      }
      if (d.kind === "question") addToList(index.openQuestions, d.task, d.note);
      if (d.kind === "digest") index.digests[d.task] = d.note;
      if (d.kind === "dead_end") recordDeadEnd(index, d.task, state.agents[d.agent]?.model ?? "");
      if (d.to !== undefined) {
        const box = (index.inbox[d.to] ??= []);
        box.push(d.note);
        if (box.length > INBOX_KEEP) box.splice(0, box.length - INBOX_KEEP);
      }
      break;
    }

    case "submission.queued": {
      const d = event.data;
      const submission: SubmissionState = {
        id: d.submission,
        attempt: d.attempt,
        task: d.task,
        agent: d.agent,
        model: d.model,
        claim: d.claim,
        message: d.message,
        files: [...d.files],
        bytes: d.bytes,
        status: "queued",
        queuedAt: at,
        runs: 0,
        points: 0,
      };
      state.submissions[d.submission] = submission;
      index.pendingSubmissions.push(d.submission);
      state.counters.submission = Math.max(
        state.counters.submission,
        idNumber(d.submission),
      );
      break;
    }

    case "submission.started": {
      const d = event.data;
      const submission = state.submissions[d.submission];
      if (!submission || (submission.status !== "queued" && submission.status !== "checking" && submission.status !== "review")) break;
      // An approved submission rechecked on a newer head moves back to pending.
      // Its review metadata (votes, passedAt, warnings) is intentionally kept.
      if (submission.status === "review") {
        if (index.reviewSubmissions !== undefined) removeId(index.reviewSubmissions, d.submission);
        if (!index.pendingSubmissions.includes(d.submission)) index.pendingSubmissions.push(d.submission);
      }
      submission.status = "checking";
      submission.startedAt = at;
      submission.base = d.base;
      submission.runs += 1;
      break;
    }

    case "submission.passed": {
      const d = event.data;
      const submission = state.submissions[d.submission];
      if (submission) {
        submission.status = "review";
        submission.passedAt = at;
        submission.passedSeq = event.seq;
        submission.base = d.base;
        submission.durationMs = d.durationMs;
        if (d.warnings !== undefined) submission.warnings = [...d.warnings];
        if (d.holdout !== undefined) submission.holdout = d.holdout;
      }
      // No longer pending; but review must NOT keep the attempt alive.
      removeId(index.pendingSubmissions, d.submission);
      // Older states/logs have no reviewSubmissions: create it lazily.
      const review = (index.reviewSubmissions ??= []);
      if (!review.includes(d.submission)) review.push(d.submission);
      break;
    }

    case "submission.reviewed": {
      const d = event.data;
      const submission = state.submissions[d.submission];
      if (!submission) break;
      const vote: ReviewVote = { agent: d.agent, approve: d.approve, at };
      if (d.reason !== undefined) vote.reason = d.reason;
      if (d.head !== undefined) vote.head = d.head;
      (submission.reviews ??= []).push(vote);
      break;
    }

    case "submission.checked": {
      const d = event.data;
      const existing = state.submissions[d.submission];
      const status = d.ok ? "accepted" : "rejected";
      if (existing) {
        existing.status = status;
        existing.checkedAt = at;
        existing.checkedSeq = event.seq;
        existing.ok = d.ok;
        existing.exitCode = d.exitCode;
        existing.timedOut = d.timedOut;
        existing.stale = d.stale;
        existing.durationMs = d.durationMs;
        existing.commit = d.commit;
        existing.points = d.points;
        if (d.base !== undefined) existing.base = d.base;
        if (d.gate !== undefined) existing.gate = [...d.gate];
        if (d.warnings !== undefined) existing.warnings = [...d.warnings];
        if (d.holdout !== undefined) existing.holdout = d.holdout;
        if (d.review !== undefined) existing.review = { ...d.review };
        removeId(index.pendingSubmissions, d.submission);
      } else {
        // v1 logs have no submission.queued event: synthesize the record.
        const submission: SubmissionState = {
          id: d.submission,
          attempt: d.attempt,
          task: d.task,
          agent: d.agent,
          model: d.model,
          claim: d.claim,
          message: "",
          files: [...d.files],
          bytes: 0,
          status,
          queuedAt: at,
          runs: 1,
          checkedAt: at,
          checkedSeq: event.seq,
          ok: d.ok,
          exitCode: d.exitCode,
          timedOut: d.timedOut,
          stale: d.stale,
          durationMs: d.durationMs,
          commit: d.commit,
          points: d.points,
        };
        if (d.base !== undefined) submission.base = d.base;
        if (d.gate !== undefined) submission.gate = [...d.gate];
        if (d.warnings !== undefined) submission.warnings = [...d.warnings];
        if (d.holdout !== undefined) submission.holdout = d.holdout;
        if (d.review !== undefined) submission.review = { ...d.review };
        state.submissions[d.submission] = submission;
        removeId(index.pendingSubmissions, d.submission);
      }
      if (index.reviewSubmissions !== undefined) removeId(index.reviewSubmissions, d.submission);
      state.counters.submission = Math.max(
        state.counters.submission,
        idNumber(d.submission),
      );
      const agent = state.agents[d.agent];
      if (agent) {
        agent.submissions += 1;
        if (d.ok) {
          agent.accepted += 1;
          agent.points += d.points;
        }
      }
      if (!d.ok && !d.stale) {
        const byTask = (index.failures[d.agent] ??= {});
        byTask[d.task] = (byTask[d.task] ?? 0) + 1;
      }
      break;
    }

    case "proposal.made": {
      const d = event.data;
      const proposal: ProposalState = {
        id: d.proposal,
        agent: d.agent,
        kind: d.kind,
        task: d.task,
        at,
        votes: {},
      };
      if (d.title !== undefined) proposal.title = d.title;
      if (d.body !== undefined) proposal.body = d.body;
      if (d.evidence !== undefined) proposal.evidence = d.evidence;
      state.proposals[d.proposal] = proposal;
      state.counters.proposal = Math.max(
        state.counters.proposal,
        idNumber(d.proposal),
      );
      break;
    }

    case "proposal.voted": {
      const d = event.data;
      const proposal = state.proposals[d.proposal];
      if (proposal) proposal.votes[d.agent] = d.approve;
      break;
    }

    case "proposal.decided": {
      const d = event.data;
      const proposal = state.proposals[d.proposal];
      if (proposal) {
        const decided: NonNullable<ProposalState["decided"]> = {
          accepted: d.accepted,
          by: d.by,
          at,
        };
        if (d.reason !== undefined) decided.reason = d.reason;
        proposal.decided = decided;
      }
      break;
    }

    case "rule.changed": {
      const d = event.data.rules;
      if (d.width !== undefined) state.rules.width = d.width;
      if (d.leaseMinutes !== undefined) state.rules.leaseMinutes = d.leaseMinutes;
      if (d.maxAttemptsPerAgent !== undefined) {
        state.rules.maxAttemptsPerAgent = d.maxAttemptsPerAgent;
      }
      // Replacing wholesale: a partial merge would leave stale roles enabled.
      if (d.roles !== undefined) state.rules.roles = { ...d.roles };
      if (d.accept !== undefined) state.rules.accept = { ...d.accept };
      if (d.defaultPoints !== undefined) state.rules.defaultPoints = d.defaultPoints;
      break;
    }
  }

  return state;
};

export const replay: Replay = (
  rules: Rules,
  events: Iterable<MingaEvent>,
): State => {
  const state = initialState(rules);
  for (const event of events) reduce(state, event);
  return state;
};

export const nextId: NextId = (state, kind) =>
  `${PREFIX[kind]}-${state.counters[kind] + 1}`;

export const isLive: IsLive = (state, attemptId, now) => {
  const attempt = state.attempts[attemptId];
  if (!attempt || attempt.endedAt !== undefined) return false;
  return Date.parse(attempt.leaseUntil) > now.getTime() || hasPendingSubmission(state, attemptId);
};

/** Filters live ids from an index list, tolerating states built before the index existed. */
function liveIds(state: State, ids: readonly string[], now: Date): string[] {
  const result: string[] = [];
  for (const id of ids) if (isLive(state, id, now)) result.push(id);
  return result;
}

export const liveAttempts: LiveAttempts = (state, taskId, now) => {
  const ids = state.index?.openByTask?.[taskId] ?? state.tasks[taskId]?.attempts ?? [];
  return liveIds(state, ids, now);
};

export const agentLiveAttempts: AgentLiveAttempts = (state, agent, now) => {
  const ids = state.index?.openByAgent?.[agent] ?? [];
  return liveIds(state, ids, now);
};

export const computeLeaderboard: ComputeLeaderboard = (state, limit) => {
  const agents: LeaderRow[] = [];
  for (const agent of Object.values(state.agents)) {
    if (agent.banned) continue;
    const row: LeaderRow = {
      agent: agent.id,
      model: agent.model,
      harness: agent.harness,
      points: agent.points,
      accepted: agent.accepted,
      submissions: agent.submissions,
    };
    if (agent.owner !== undefined) row.owner = agent.owner;
    agents.push(row);
  }
  agents.sort(
    (a, b) =>
      b.points - a.points ||
      b.accepted - a.accepted ||
      (a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0),
  );

  const byModel = new Map<
    string,
    { agents: Set<string>; points: number; accepted: number; submissions: number }
  >();
  for (const submission of Object.values(state.submissions)) {
    let group = byModel.get(submission.model);
    if (!group) {
      group = { agents: new Set(), points: 0, accepted: 0, submissions: 0 };
      byModel.set(submission.model, group);
    }
    group.agents.add(submission.agent);
    group.submissions += 1;
    if (submission.ok) {
      group.accepted += 1;
      group.points += submission.points;
    }
  }

  const models: ModelRow[] = [...byModel.entries()].map(([model, g]) => ({
    model,
    agents: g.agents.size,
    points: g.points,
    accepted: g.accepted,
    submissions: g.submissions,
    passRate: g.submissions > 0 ? g.accepted / g.submissions : 0,
  }));
  models.sort((a, b) => b.points - a.points || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));

  return {
    agents: limit === undefined ? agents : agents.slice(0, Math.max(0, limit)),
    models,
  };
};
