/**
 * Bounded UI snapshot. Reads only the indexes and a small, constant number of
 * newest items; it never folds events, touches the clock or mutates state.
 */
import type { BuildView, ViewInput } from "../core/contracts.ts";
import type { ViewResponse, ViewTask } from "../core/protocol.ts";
import type {
  AgentId, AgentState, AttemptId, AttemptState, NoteState, ProposalState, SubmissionState,
} from "../core/types.ts";
import { computeLeaderboard } from "./reducer.ts";

const HOUR_MS = 60 * 60 * 1000;
const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const MAX_NOTES = 100;
const MAX_FINISHED = 100;
const MAX_DECIDED = 50;
const MAX_AGENTS = 2000;
const MAX_LEADERS = 100;

function idNumber(id: string): number {
  const n = Number.parseInt(id.slice(id.lastIndexOf("-") + 1), 10);
  return Number.isFinite(n) ? n : 0;
}

/** Attempt ids whose submission is still queued or checking. */
function pendingAttempts(state: ViewInput["state"]): Set<AttemptId> {
  const pending = new Set<AttemptId>();
  for (const id of state.index?.pendingSubmissions ?? []) {
    const submission = state.submissions[id];
    if (submission) pending.add(submission.attempt);
  }
  return pending;
}

function isLiveAttempt(attempt: AttemptState, nowMs: number, pending: ReadonlySet<AttemptId>): boolean {
  return attempt.endedAt === undefined &&
    (Date.parse(attempt.leaseUntil) > nowMs || pending.has(attempt.id));
}

/**
 * Walk sequential ids backwards from the counter, skipping gaps and items that
 * fail `accept` without spending one of the `want` slots.
 */
function newest<T>(
  counter: number,
  prefix: string,
  byId: Record<string, T>,
  want: number,
  accept?: (item: T) => boolean,
): T[] {
  const found: T[] = [];
  for (let n = counter; n >= 1 && found.length < want; n -= 1) {
    const item = byId[`${prefix}-${n}`];
    if (item !== undefined && (accept === undefined || accept(item))) found.push(item);
  }
  return found;
}

export const buildView: BuildView = (input: ViewInput): ViewResponse => {
  const { state, project, events } = input;
  const nowMs = input.now.getTime();
  const pending = pendingAttempts(state);

  // ---- live work (one pass over the open-attempt index) --------------------
  const live: AttemptState[] = [];
  const liveCountByTask = new Map<string, number>();
  const liveAgents = new Set<AgentId>();
  for (const id of state.index?.openAttempts ?? Object.keys(state.attempts)) {
    const attempt = state.attempts[id];
    if (!attempt || !isLiveAttempt(attempt, nowMs, pending)) continue;
    live.push(attempt);
    liveCountByTask.set(attempt.task, (liveCountByTask.get(attempt.task) ?? 0) + 1);
    liveAgents.add(attempt.agent);
  }

  // ---- tasks: all of them, but counts instead of attempt/note lists --------
  const tasks: ViewTask[] = [];
  let openTasks = 0;
  for (const task of Object.values(state.tasks)) {
    if (task.status === "open") openTasks += 1;
    const viewTask: ViewTask = {
      id: task.id,
      title: task.title,
      body: task.body,
      parent: task.parent,
      children: [...task.children],
      status: task.status,
      points: task.points,
      postedAt: task.postedAt,
      attemptCount: task.attempts.length,
      noteCount: task.notes.length,
      liveCount: liveCountByTask.get(task.id) ?? 0,
    };
    if (task.closedAt !== undefined) viewTask.closedAt = task.closedAt;
    if (task.closedBy !== undefined) viewTask.closedBy = task.closedBy;
    tasks.push(viewTask);
  }

  // ---- agents: live holders or seen in the last hour, most recent first ---
  const agents: AgentState[] = [];
  const included = new Set<AgentId>();
  let activeAgents = 0;
  for (const agent of Object.values(state.agents)) {
    const seen = Date.parse(agent.lastSeenAt);
    if (Number.isFinite(seen) && nowMs - seen <= FIFTEEN_MIN_MS) activeAgents += 1;
    if (!Number.isFinite(seen) || nowMs - seen > HOUR_MS) continue;
    agents.push(agent);
    included.add(agent.id);
  }
  for (const attempt of live) {
    if (included.has(attempt.agent)) continue;
    const agent = state.agents[attempt.agent];
    if (!agent) continue;
    agents.push(agent);
    included.add(agent.id);
  }
  agents.sort((a, b) =>
    Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  agents.length = Math.min(agents.length, MAX_AGENTS);

  // ---- submissions: all pending, plus the newest finished ones ------------
  let queuedSubmissions = 0;
  let checkingSubmissions = 0;
  const submissions: SubmissionState[] = [];
  const submissionIds = new Set<string>();
  for (const id of state.index?.pendingSubmissions ?? []) {
    const submission = state.submissions[id];
    if (!submission || submissionIds.has(id)) continue;
    if (submission.status === "queued") queuedSubmissions += 1;
    if (submission.status === "checking") checkingSubmissions += 1;
    submissions.push(submission);
    submissionIds.add(id);
  }
  for (const submission of newest(
    state.counters.submission,
    "S",
    state.submissions,
    MAX_FINISHED,
    (item) => item.status === "accepted" || item.status === "rejected",
  )) {
    if (submissionIds.has(submission.id)) continue;
    submissions.push(submission);
    submissionIds.add(submission.id);
  }
  submissions.sort((a, b) => idNumber(b.id) - idNumber(a.id));

  // ---- proposals: every open one, plus the newest decided ones -------------
  const openProposals: ProposalState[] = [];
  for (const proposal of Object.values(state.proposals)) {
    if (proposal.decided === undefined) openProposals.push(proposal);
  }
  openProposals.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const decidedProposals = newest(
    state.counters.proposal,
    "P",
    state.proposals,
    MAX_DECIDED,
    (item) => item.decided !== undefined,
  );
  const proposals = [...openProposals, ...decidedProposals];

  const notes: NoteState[] = newest(state.counters.note, "N", state.notes, MAX_NOTES);
  let accepted = 0;
  for (const agent of Object.values(state.agents)) accepted += agent.accepted;

  return {
    project,
    seq: state.seq,
    now: input.now.toISOString(),
    totals: {
      agents: Object.keys(state.agents).length,
      activeAgents,
      tasks: Object.keys(state.tasks).length,
      openTasks,
      liveAttempts: live.length,
      queuedSubmissions,
      checkingSubmissions,
      submissions: Object.keys(state.submissions).length,
      accepted,
      notes: Object.keys(state.notes).length,
      events,
    },
    tasks,
    attempts: live,
    agents,
    notes,
    submissions,
    proposals,
    leaderboard: computeLeaderboard(state, MAX_LEADERS),
  };
};
