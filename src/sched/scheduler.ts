/**
 * Pure scheduling decisions: which task and role an agent gets next, which
 * leases have expired, and whether a proposal has reached a vote threshold.
 *
 * Scheduler liveness is deliberately computed inline (an attempt is live while
 * it has not ended and its lease is in the future) instead of importing the log
 * module, so this file stays a pure function of `State`.
 */
import type {
  DecideByVotes,
  ExpiredAttempts,
  ModelFamily,
  Pick,
  PickTask,
} from "../core/contracts.ts";
import type { AttemptId, AttemptState, Role, State, TaskId, TaskState } from "../core/types.ts";
import { ROLES } from "../core/types.ts";

function isLive(attempt: AttemptState, nowMs: number): boolean {
  return attempt.endedAt === undefined && Date.parse(attempt.leaseUntil) > nowMs;
}

/** Lowercased model name up to its first "-", "/" or ":"; "" maps to "unknown". */
export const modelFamily: ModelFamily = (model) => {
  const normalized = model.trim().toLowerCase();
  if (normalized === "") return "unknown";
  const cut = normalized.search(/[-/:]/);
  const family = cut === -1 ? normalized : normalized.slice(0, cut);
  return family === "" ? "unknown" : family;
};

/** Attempts that have not ended and whose leaseUntil <= now. */
export const expiredAttempts: ExpiredAttempts = (state, now) => {
  const nowMs = now.getTime();
  const expired: AttemptId[] = [];
  for (const attempt of Object.values(state.attempts)) {
    if (attempt.endedAt === undefined && Date.parse(attempt.leaseUntil) <= nowMs) {
      expired.push(attempt.id);
    }
  }
  return expired;
};

/** Weighted random role over `rules.roles`; weight-0 roles are never chosen. */
function pickRole(roles: Record<Role, number>, rng: () => number): Role {
  const weights = ROLES.map((role) => {
    const weight = roles[role];
    return typeof weight === "number" && Number.isFinite(weight) && weight > 0 ? weight : 0;
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);

  if (total > 0) {
    let ticket = rng() * total;
    for (let index = 0; index < ROLES.length; index += 1) {
      ticket -= weights[index] ?? 0;
      if (ticket < 0) return ROLES[index] as Role;
    }
    for (let index = ROLES.length - 1; index >= 0; index -= 1) {
      if ((weights[index] ?? 0) > 0) return ROLES[index] as Role;
    }
  }

  // rules.roles should always have a positive weight; stay deterministic if not.
  return ROLES[0] as Role;
}

/**
 * Chooses a task and role for `agent`, or null when nothing is available.
 *
 * Candidates: open leaf tasks with room under `rules.width`, excluding tasks
 * the agent already holds live, when the agent is under `maxAttemptsPerAgent`
 * and not banned. Candidates are scored (same-family avoidance, zero live
 * attempts, no prior failure, age) with a small rng tiebreak.
 */
export const pickTask: PickTask = (input) => {
  const { state, agent, now } = input;
  const rng = input.rng ?? Math.random;
  const nowMs = now.getTime();
  const agentState = state.agents[agent];

  if (agentState?.banned) return null;

  const liveAttempts = Object.values(state.attempts).filter((attempt) => isLive(attempt, nowMs));
  const heldAttempts = liveAttempts.filter((attempt) => attempt.agent === agent);
  if (heldAttempts.length >= state.rules.maxAttemptsPerAgent) return null;

  const liveCountByTask = new Map<TaskId, number>();
  const liveFamiliesByTask = new Map<TaskId, Set<string>>();
  for (const attempt of liveAttempts) {
    liveCountByTask.set(attempt.task, (liveCountByTask.get(attempt.task) ?? 0) + 1);
    let families = liveFamiliesByTask.get(attempt.task);
    if (!families) {
      families = new Set<string>();
      liveFamiliesByTask.set(attempt.task, families);
    }
    families.add(modelFamily(attempt.model));
  }

  const heldTasks = new Set<TaskId>(heldAttempts.map((attempt) => attempt.task));
  const failedTasks = new Set<TaskId>();
  for (const submission of Object.values(state.submissions)) {
    if (submission.agent === agent && submission.ok === false) failedTasks.add(submission.task);
  }

  const agentFamily = modelFamily(agentState?.model ?? "");
  const candidates = Object.values(state.tasks).filter(
    (task) =>
      task.status === "open" &&
      task.children.length === 0 &&
      (liveCountByTask.get(task.id) ?? 0) < state.rules.width &&
      !heldTasks.has(task.id),
  );
  if (candidates.length === 0) return null;

  let oldest = Infinity;
  let newest = -Infinity;
  for (const task of candidates) {
    const postedAt = Date.parse(task.postedAt);
    if (Number.isFinite(postedAt)) {
      if (postedAt < oldest) oldest = postedAt;
      if (postedAt > newest) newest = postedAt;
    }
  }
  const ageSpan = newest - oldest;

  let bestTask: TaskState | null = null;
  let bestScore = -Infinity;
  for (const task of candidates) {
    let score = 0;

    if (!liveFamiliesByTask.get(task.id)?.has(agentFamily)) score += 4;
    if ((liveCountByTask.get(task.id) ?? 0) === 0) score += 2;
    if (!failedTasks.has(task.id)) score += 1;

    const postedAt = Date.parse(task.postedAt);
    if (Number.isFinite(postedAt) && Number.isFinite(oldest) && Number.isFinite(newest)) {
      score += ageSpan > 0 ? (newest - postedAt) / ageSpan : 1;
    }

    score += rng() * 0.5;

    if (score > bestScore) {
      bestScore = score;
      bestTask = task;
    }
  }

  if (!bestTask) return null;
  const pick: Pick = { task: bestTask.id, role: pickRole(state.rules.roles, rng) };
  return pick;
};

/**
 * Applies `rules.accept` to an undecided proposal using its votes. Only votes
 * from unbanned agents with at least one accepted submission count, and never
 * the proposer's own vote.
 */
export const decideByVotes: DecideByVotes = (state, proposalId) => {
  const proposal = state.proposals[proposalId];
  if (!proposal || proposal.decided) return null;

  const policy = state.rules.accept;
  if (policy.mode === "head") return null;

  let approvals = 0;
  let rejections = 0;
  for (const [voter, approve] of Object.entries(proposal.votes)) {
    if (voter === proposal.agent) continue;
    const voterState = state.agents[voter];
    if (!voterState || voterState.banned || voterState.accepted < 1) continue;
    if (approve) approvals += 1;
    else rejections += 1;
  }

  if (approvals >= policy.votes) return { accepted: true };
  if (rejections >= policy.votes) return { accepted: false };
  return null;
};
