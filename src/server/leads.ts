/**
 * Area-lead lookup. An area is the task the head granted, and any task below it;
 * the nearest led ancestor wins. Pure read over the reducer's lead index.
 */
import type { LeadAreaFor } from "../core/contracts.ts";
import type { AgentId, State, TaskId } from "../core/types.ts";

export const leadAreaFor: LeadAreaFor = (state: State, agent: AgentId, task: TaskId | null): TaskId | null => {
  if (task === null) return null;
  const areas = state.index.leadAreas?.[agent];
  if (!areas || areas.length === 0) return null;
  const mine = new Set(areas);
  for (let id: TaskId | null | undefined = task; id; id = state.tasks[id]?.parent ?? null) {
    if (mine.has(id)) return id;
  }
  return null;
};
