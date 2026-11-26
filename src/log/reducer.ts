/**
 * State is a pure fold over the event log. No I/O, no clock: every timestamp
 * comes from `event.at`, so replaying the same log always yields the same
 * state.
 */
import type {
  ComputeLeaderboard, InitialState, IsLive, LiveAttempts, NextId, Reduce, Replay,
} from "../core/contracts.ts";
import type {
  AgentState, AttemptState, LeaderRow, ModelRow, MingaEvent, NoteState, ProposalState,
  Rules, State, SubmissionState, TaskState,
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

export const initialState: InitialState = (rules: Rules): State => ({
  seq: 0,
  rules: cloneRules(rules),
  agents: {},
  tasks: {},
  attempts: {},
  notes: {},
  submissions: {},
  proposals: {},
  counters: { task: 0, attempt: 0, note: 0, submission: 0, proposal: 0 },
});

export const reduce: Reduce = (state: State, event: MingaEvent): State => {
  if (event.seq !== state.seq + 1) {
    throw new Error(
      `event seq gap: expected ${state.seq + 1}, got ${event.seq} (${event.type})`,
    );
  }
  state.seq = event.seq;
  const at = event.at;

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
      state.attempts[d.attempt] = attempt;
      task.attempts.push(d.attempt);
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
      attempt.endedAt = at;
      attempt.endReason = d.reason;
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
      state.notes[d.note] = note;
      task.notes.unshift(d.note);
      state.counters.note = Math.max(state.counters.note, idNumber(d.note));
      break;
    }

    case "submission.checked": {
      const d = event.data;
      const submission: SubmissionState = { ...d, at };
      state.submissions[d.submission] = submission;
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
  if (!attempt) return false;
  if (attempt.endedAt !== undefined) return false;
  return Date.parse(attempt.leaseUntil) > now.getTime();
};

export const liveAttempts: LiveAttempts = (state, taskId, now) => {
  const task = state.tasks[taskId];
  if (!task) return [];
  return task.attempts.filter((id) => isLive(state, id, now));
};

export const computeLeaderboard: ComputeLeaderboard = (state) => {
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

  return { agents, models };
};
