/**
 * Notices: news an agent has not been told yet, attached once to a signed 2xx
 * response. Delivery cursors live only in memory: after a restart an addressed
 * note may be re-delivered, which is acceptable.
 *
 * Everything here reads reducer indexes, never scans the attempt/note/submission
 * records, so it stays cheap on the hottest routes (beat and next).
 */
import type { AttemptView, Notice } from "../core/protocol.ts";
import type {
  AgentId, AttemptId, MingaEvent, NewEvent, NoteId, State, TaskId,
} from "../core/types.ts";

export type Emit = (event: NewEvent) => MingaEvent;

/** Who closed a task: the accepted submission the task records, else the closing agent. */
export function closedByOf(state: State, task: TaskId): AttemptView["closedBy"] {
  const t = state.tasks[task];
  if (!t || t.status === "open") return undefined;
  const sub = t.closedSubmission ? state.submissions[t.closedSubmission] : undefined;
  if (sub) return { agent: sub.agent, model: sub.model, submission: sub.id };
  return t.closedBy ? { agent: t.closedBy } : undefined;
}

/** Numeric suffix of a note id ("N-12" -> 12), 0 when malformed. */
function noteNumber(id: NoteId): number {
  const n = Number.parseInt(id.slice(2), 10);
  return Number.isFinite(n) ? n : 0;
}

export class Notices {
  /** Highest note id number already delivered to each agent. */
  private delivered = new Map<AgentId, number>();
  /** task -> agents with accepted work on this task or any descendant. */
  private accepted = new Map<TaskId, Set<AgentId>>();

  constructor(private readonly state: State, private readonly emit: Emit) {
    for (const sub of Object.values(state.submissions)) {
      if (sub.status === "accepted") this.recordAccepted(sub.task, sub.agent);
    }
  }

  /**
   * Record accepted work, propagating to every ancestor. A digest permission
   * check is then a single set lookup on the task, never a descendant walk.
   */
  recordAccepted(task: TaskId, agent: AgentId): void {
    let id: TaskId | undefined = task;
    while (id) {
      let set = this.accepted.get(id);
      if (!set) this.accepted.set(id, (set = new Set<AgentId>()));
      set.add(agent);
      id = this.state.tasks[id]?.parent ?? undefined;
    }
  }

  /** True when the agent has accepted work on this task or one of its descendants. */
  hasAcceptedWork(task: TaskId, agent: AgentId): boolean {
    return this.accepted.get(task)?.has(agent) ?? false;
  }

  /** The failure already told the agent; stop re-sending this attempt as a notice. */
  markNotified(attempt: AttemptId, agent: AgentId, via: string): void {
    if (!(this.state.index.unnotified?.[agent] ?? []).includes(attempt)) return;
    this.emit({ type: "attempt.notified", actor: "server", data: { attempt, agent, via } });
  }

  /** Builds pending news for `agent`; emits attempt.notified for closed-under attempts. */
  pending(agent: AgentId, via: string): Notice[] | undefined {
    const out: Notice[] = [];
    for (const attempt of [...(this.state.index.unnotified?.[agent] ?? [])]) {
      const at = this.state.attempts[attempt];
      if (!at) continue;
      out.push({
        kind: "attempt_ended",
        attempt,
        task: at.task,
        reason: at.endReason ?? "task_closed",
        taskStatus: this.state.tasks[at.task]?.status ?? "open",
        closedBy: closedByOf(this.state, at.task),
      });
      this.emit({ type: "attempt.notified", actor: "server", data: { attempt, agent, via } });
    }

    const cursor = this.delivered.get(agent) ?? 0;
    let seen = cursor;
    for (const id of this.state.index.inbox?.[agent] ?? []) {
      const n = noteNumber(id);
      if (n <= cursor) continue;
      const note = this.state.notes[id];
      if (!note) continue;
      out.push({ kind: "note", note });
      if (n > seen) seen = n;
    }
    if (seen > cursor) this.delivered.set(agent, seen);
    return out.length ? out : undefined;
  }
}
