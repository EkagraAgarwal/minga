/**
 * Pure review rules: who may vote on a submission and whether the votes reach
 * the policy threshold. No I/O and no clock. The server owns head votes and the
 * final submission.checked event; this module only folds vote policy over the
 * state the reducer already built.
 */
import type { DecideReview, ReviewEligible } from "../core/contracts.ts";
import type { AgentId, State, SubmissionId } from "../core/types.ts";

type Verdict = { ok: true } | { ok: false; reason: string };

/** Shared eligibility check. Decision-time counting re-checks it but skips the
 * "already voted" rule, since every recorded vote would otherwise be ignored. */
function eligible(
  state: State,
  submissionId: SubmissionId,
  agent: AgentId,
  checkAlreadyVoted: boolean,
): Verdict {
  const submission = state.submissions[submissionId];
  if (!submission) return { ok: false, reason: "unknown submission" };

  const voter = state.agents[agent];
  if (!voter) return { ok: false, reason: "unknown agent" };
  if (voter.banned) return { ok: false, reason: "agent is banned" };
  if (agent === submission.agent) return { ok: false, reason: "author cannot vote" };
  if (voter.accepted < 1) return { ok: false, reason: "no accepted work" };

  // Rivals must not judge each other: no open attempt on the same task.
  for (const attemptId of state.index?.openByTask?.[submission.task] ?? []) {
    const attempt = state.attempts[attemptId];
    if (attempt && attempt.endedAt === undefined && attempt.agent === agent) {
      return { ok: false, reason: "open attempt on this task" };
    }
  }

  // ...and no other submission of theirs still waiting in review on that task.
  for (const otherId of state.index?.reviewSubmissions ?? []) {
    if (otherId === submissionId) continue;
    const other = state.submissions[otherId];
    if (other && other.status === "review" && other.task === submission.task && other.agent === agent) {
      return { ok: false, reason: "another submission in review on this task" };
    }
  }

  if (checkAlreadyVoted && (submission.reviews ?? []).some((vote) => vote.agent === agent)) {
    return { ok: false, reason: "already voted" };
  }
  return { ok: true };
}

export const reviewEligible: ReviewEligible = (state, submissionId, agent) =>
  eligible(state, submissionId, agent, true);

export const decideReview: DecideReview = (state, submissionId, policy) => {
  if (policy.mode === "none" || policy.mode === "head") return null;
  const submission = state.submissions[submissionId];
  if (!submission) return null;

  let approvals = 0;
  let rejections = 0;
  for (const vote of submission.reviews ?? []) {
    // Head votes settle the review on the server; they are not counted here.
    if (vote.head) continue;
    if (!eligible(state, submissionId, vote.agent, false).ok) continue;
    if (vote.approve) approvals += 1;
    else rejections += 1;
  }

  if (approvals >= policy.votes) return { approved: true };
  if (rejections >= policy.votes) return { approved: false };
  return null;
};
