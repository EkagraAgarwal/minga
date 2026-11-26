/**
 * Coordination quality folded incrementally from the event log.
 *
 * apply() is O(1) amortised per event. Only the small per-task/per-attempt
 * facts still needed by future events are kept (note counts are dropped once
 * a task closes); no event bodies or note text are retained. Notify lags live
 * in a deterministic bounded reservoir (2,000 exact samples), so the log's
 * history does not accumulate. Nothing here reads the clock: lag comes from
 * the `at` fields of the events themselves.
 */
import type { CoordinationTracker, CreateCoordinationTracker } from "../core/contracts.ts";
import type { CoordinationStats, MingaEvent, NoteId, TaskId } from "../core/types.ts";

const SAMPLE_CAP = 2000;
/** Replies that arrive before their question are remembered, but only briefly. */
const EARLY_REPLY_CAP = 2000;

/**
 * Deterministic reservoir slot (Algorithm R): a fixed-seed LCG, so replaying
 * the same sample sequence always picks the same samples without a clock.
 */
function reservoirSlot(seed: number, sampleCount: number): { seed: number; slot: number } {
  const next = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return { seed: next, slot: Math.floor((next / 0x1_0000_0000) * sampleCount) };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export const createCoordinationTracker: CreateCoordinationTracker = (): CoordinationTracker => {
  let closes = 0;
  let closedUnder = 0;
  let endedAttempts = 0;
  let deadEnds = 0;
  let digests = 0;
  let duplicateProposals = 0;
  let handoffs = 0;
  let handoffsFollowedBySolve = 0;

  // Task -> note count, and the subset of tasks that have been closed. Notes
  // posted after a close still count, so the running numerator is updated on
  // both note.added and the first task.closed for a task.
  const notesByTask = new Map<TaskId, number>();
  const closedTasks = new Set<TaskId>();
  let notesOnClosedTasks = 0;

  // Questions and their replies. A counted question leaves the pending set,
  // so replying twice cannot count it twice.
  const pendingQuestions = new Set<NoteId>();
  const earlyReplies = new Map<NoteId, true>();
  let questionsAsked = 0;
  let questionsAnswered = 0;

  // Hand-off notes are credited when (and only when) their task is later solved.
  const handoffsByTask = new Map<TaskId, number>();
  const solvedTasks = new Set<TaskId>();

  // Attempt -> task, and task -> close time, for notification lag.
  const taskOfAttempt = new Map<string, TaskId>();
  const closedAtByTask = new Map<TaskId, number>();
  const samples: number[] = [];
  let sortedSamples: number[] | null = null;
  let reservoirSeed = 0x9e3779b9;
  let lagCount = 0;
  let lagMax = 0;

  function recordLag(lag: number): void {
    lagCount += 1;
    if (lag > lagMax) lagMax = lag;
    if (samples.length < SAMPLE_CAP) {
      samples.push(lag);
      sortedSamples = null;
      return;
    }
    const pick = reservoirSlot(reservoirSeed, lagCount);
    reservoirSeed = pick.seed;
    if (pick.slot < SAMPLE_CAP) {
      samples[pick.slot] = lag;
      sortedSamples = null;
    }
  }

  function percentile(q: number): number {
    if (samples.length === 0) return 0;
    sortedSamples ??= [...samples].sort((a, b) => a - b);
    const index = Math.min(sortedSamples.length - 1, Math.max(0, Math.ceil(q * sortedSamples.length) - 1));
    return round(sortedSamples[index]!);
  }

  const apply = (event: MingaEvent): void => {
    switch (event.type) {
      case "task.closed": {
        const task = event.data.task;
        closes += 1;
        if (!closedTasks.has(task)) {
          closedTasks.add(task);
          notesOnClosedTasks += notesByTask.get(task) ?? 0;
          notesByTask.delete(task);
        }
        closedAtByTask.set(task, Date.parse(event.at));
        if (event.data.status === "solved" && !solvedTasks.has(task)) {
          solvedTasks.add(task);
          handoffsFollowedBySolve += handoffsByTask.get(task) ?? 0;
          handoffsByTask.delete(task);
        }
        break;
      }
      case "attempt.started":
        taskOfAttempt.set(event.data.attempt, event.data.task);
        break;
      case "attempt.ended": {
        endedAttempts += 1;
        if (event.data.reason === "task_closed") closedUnder += 1;
        if (event.data.why === "dead_end") deadEnds += 1;
        break;
      }
      case "attempt.notified": {
        const task = taskOfAttempt.get(event.data.attempt);
        const closedAt = task === undefined ? undefined : closedAtByTask.get(task);
        if (closedAt === undefined) break;
        const lag = Math.max(0, (Date.parse(event.at) - closedAt) / 1000);
        if (Number.isFinite(lag)) recordLag(lag);
        break;
      }
      case "note.added": {
        const d = event.data;
        if (closedTasks.has(d.task)) {
          notesOnClosedTasks += 1;
        } else {
          notesByTask.set(d.task, (notesByTask.get(d.task) ?? 0) + 1);
        }

        if (d.kind === "question") {
          questionsAsked += 1;
          if (earlyReplies.delete(d.note)) questionsAnswered += 1;
          else pendingQuestions.add(d.note);
        } else if (d.kind === "handoff") {
          handoffs += 1;
          if (!solvedTasks.has(d.task)) {
            handoffsByTask.set(d.task, (handoffsByTask.get(d.task) ?? 0) + 1);
          }
        } else if (d.kind === "dead_end") {
          deadEnds += 1;
        } else if (d.kind === "digest") {
          digests += 1;
        }

        if (d.replyTo !== undefined) {
          if (pendingQuestions.delete(d.replyTo)) {
            questionsAnswered += 1;
          } else if (!earlyReplies.has(d.replyTo)) {
            earlyReplies.set(d.replyTo, true);
            if (earlyReplies.size > EARLY_REPLY_CAP) {
              const oldest = earlyReplies.keys().next().value;
              if (oldest !== undefined) earlyReplies.delete(oldest);
            }
          }
        }
        break;
      }
      case "proposal.voted":
        if (event.data.duplicate === true) duplicateProposals += 1;
        break;
      default:
        break;
    }
  };

  const snapshot = (): CoordinationStats => ({
    closes,
    closedUnder,
    closedUnderShare: endedAttempts === 0 ? 0 : closedUnder / endedAttempts,
    notifyLagSeconds: {
      count: lagCount,
      p50: percentile(0.5),
      p90: percentile(0.9),
      max: round(lagMax),
    },
    notesPerClosedTask: closes === 0 ? 0 : notesOnClosedTasks / closes,
    questions: {
      asked: questionsAsked,
      answered: questionsAnswered,
      open: questionsAsked - questionsAnswered,
    },
    handoffs,
    handoffsFollowedBySolve,
    deadEnds,
    digests,
    duplicateProposals,
  });

  return { apply, snapshot };
};
