/**
 * Near-duplicate detection for new_task proposals. Only the siblings under the
 * same parent are considered, plus undecided proposals with the same parent;
 * proposals are few, so scanning them is cheap, and tasks are reached through
 * the parent's children index (or a single root scan for top-level proposals).
 */
import type { FindDuplicate } from "../core/contracts.ts";
import type { ProposalId, State, TaskId } from "../core/types.ts";

const STOPWORDS = new Set(["a", "an", "the", "of", "for", "to", "in", "on", "and", "or", "with"]);

/** Lowercase words in sorted order, with stopwords and punctuation dropped. Numbers stay exact. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((word) => word !== "" && !STOPWORDS.has(word))
    .sort()
    .join(" ");
}

export const findDuplicate: FindDuplicate = (state: State, parent: TaskId | null, title: string): { proposal?: ProposalId; task?: TaskId } | null => {
  const words = normalizeTitle(title);
  if (!words) return null; // an empty title never matches anything

  // Prefer an undecided proposal: a duplicate should become a vote on it.
  for (const p of Object.values(state.proposals)) {
    if (p.decided || p.kind !== "new_task" || p.task !== parent || p.title === undefined) continue;
    if (normalizeTitle(p.title) === words) return { proposal: p.id };
  }

  const siblings: TaskId[] = parent === null
    ? Object.values(state.tasks).filter((t) => t.parent === null).map((t) => t.id)
    : [...(state.tasks[parent]?.children ?? [])];
  for (const id of siblings) {
    const t = state.tasks[id];
    if (t && t.status === "open" && normalizeTitle(t.title) === words) return { task: id };
  }
  return null;
};
