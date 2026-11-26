/**
 * Core domain types. Every module codes against these.
 *
 * The whole system is five nouns (project, task, attempt, note, agent) plus the
 * submissions and proposals they produce. All state is derived by folding an
 * append-only log of `MingaEvent`s (see log/reducer.ts). Nothing else is stored.
 *
 * Changing this file is a lead decision: workers must not edit it.
 */

// ---------------------------------------------------------------- identifiers

/** 16 lowercase hex chars: the first 8 bytes of sha256(raw 32-byte ed25519 public key). */
export type AgentId = string;
/** "T-<n>", n starting at 1. */
export type TaskId = string;
/** "A-<n>" */
export type AttemptId = string;
/** "N-<n>" */
export type NoteId = string;
/** "S-<n>" */
export type SubmissionId = string;
/** "P-<n>" */
export type ProposalId = string;

/** Who caused an event: an agent (the head agent included) or the server itself (lease sweeps, seeding). */
export type Actor = AgentId | "server";

// ---------------------------------------------------------------- enums

export type Role = "explore" | "build" | "attack" | "distill" | "plan";
export const ROLES: readonly Role[] = ["explore", "build", "attack", "distill", "plan"];

/** Stored status. "In progress" is derived: status "open" with at least one live attempt. */
export type TaskStatus = "open" | "solved" | "refuted" | "impossible" | "withdrawn";
export const CLOSED_STATUSES: readonly TaskStatus[] = ["solved", "refuted", "impossible", "withdrawn"];

/**
 * idea/result/question/handoff: free notes on a task.
 * dead_end: an approach that did not work, so the next agent does not retry it.
 * digest: a pinned summary of an area (a task with children) or a task; every assignment
 *   under it shows the newest digest first. Only the head, a lead of the area, or an agent
 *   with accepted work under it may post one. Max 1,500 chars.
 */
export type NoteKind = "idea" | "result" | "question" | "handoff" | "dead_end" | "digest";
export const NOTE_KINDS: readonly NoteKind[] = ["idea", "result", "question", "handoff", "dead_end", "digest"];

export type AttemptEndReason = "submitted" | "released" | "expired" | "task_closed" | "banned";

/** Why an agent released an attempt (optional on release). "dead_end" also counts as a dead end for the agent's model on the task. */
export type ReleaseReason = "dead_end" | "too_hard" | "out_of_time" | "blocked" | "duplicate" | "other";
export const RELEASE_REASONS: readonly ReleaseReason[] = ["dead_end", "too_hard", "out_of_time", "blocked", "duplicate", "other"];

/** What an accepted submission claims about its task. */
export type Claim = "solves" | "refutes" | "progress";

export type ProposalKind = "new_task" | "impossible";
export type DecidedBy = "head" | "vote" | "lead";

// ---------------------------------------------------------------- rules & config

export type AcceptPolicy =
  | { mode: "head" }
  | { mode: "votes"; votes: number }
  | { mode: "head-or-votes"; votes: number };

/** Mutable at runtime by the head agent through `rule.changed`. */
export interface Rules {
  /** Max live attempts per task (overlap). */
  width: number;
  leaseMinutes: number;
  /** Max live attempts one agent may hold at once. */
  maxAttemptsPerAgent: number;
  /** Relative weights the scheduler uses to pick a role. 0 disables a role. */
  roles: Record<Role, number>;
  accept: AcceptPolicy;
  /** Points for a task posted without an explicit value. */
  defaultPoints: number;
}

export interface SeedTask {
  /** Optional local key so other seed tasks can nest under it with `under`. */
  key?: string;
  title: string;
  body: string;
  /** `key` of another seed task. */
  under?: string;
  points?: number;
  /** Repo-relative paths or directory prefixes (ending in "/") this task expects to touch. */
  paths?: string[];
}

/** Parsed project.toml. Immutable while the server runs (except `rules`, via events). */
export interface ProjectConfig {
  name: string;
  goal: string;
  /** Plain-language boundary every agent must stay inside. Shown in the join doc. */
  scope: string;
  /** Shell command run in a temp checkout of the submission. Exit 0 = accepted. `{files}` expands to the submitted paths. */
  check: string;
  checkTimeoutSeconds: number;
  /** Globs (Bun.Glob syntax) a submission may write. Anything else is rejected before the check runs. */
  paths: string[];
  /** Head agent's public key, as "ed25519:<base64url raw 32 bytes>". */
  head: string;
  /** Branch accepted work is committed to. */
  branch: string;
  /**
   * How many checks may run at once (project.toml `check_concurrency`).
   * 0 means auto: max(1, cpu cores - 1). At most one check per task runs at a time.
   */
  checkConcurrency: number;
  /**
   * Paths (repo-relative, no globs) kept between checks in the warm worktrees, for build
   * caches such as ".lake", "node_modules" or "target" (project.toml `check_keep`). Default [].
   */
  checkKeep: string[];
  /**
   * What happens when the branch moved while a check ran (project.toml `recheck`).
   * "on-overlap" (default): recheck only when a commit since the check's base touched one of the
   * submitted paths; otherwise commit on top of the new head without rechecking. Fast: passing
   * work on different files lands in parallel.
   * "always": run the check again on the new head before every commit. Strict, but accepts
   * become serial when many agents pass at once.
   */
  recheck: "always" | "on-overlap";
  rules: Rules;
  seedTasks: SeedTask[];
}

// ---------------------------------------------------------------- events

interface Ev<T extends string, D> {
  /** 1-based, gap-free, assigned by the store. */
  seq: number;
  /** ISO-8601 UTC, assigned by the store. */
  at: string;
  type: T;
  actor: Actor;
  data: D;
}

export type AgentJoined = Ev<"agent.joined", {
  agent: AgentId;
  publicKey: string;
  model: string;
  harness: string;
  owner?: string;
  /** True when this agent ID was already known (same key reconnecting). */
  rejoin: boolean;
}>;

export type AgentBanned = Ev<"agent.banned", { agent: AgentId; reason: string }>;

export type TaskPosted = Ev<"task.posted", {
  task: TaskId;
  title: string;
  body: string;
  parent: TaskId | null;
  points: number;
  by: DecidedBy | "config";
  proposal?: ProposalId;
  /** Paths or directory prefixes (ending in "/") the task expects to touch; seeds attempts' intents. */
  paths?: string[];
}>;

export type TaskClosed = Ev<"task.closed", {
  task: TaskId;
  status: Exclude<TaskStatus, "open">;
  agent?: AgentId;
  submission?: SubmissionId;
  proposal?: ProposalId;
}>;

export type AttemptStarted = Ev<"attempt.started", {
  attempt: AttemptId;
  task: TaskId;
  agent: AgentId;
  role: Role;
  /** One line the agent (or scheduler) gives for how it will approach the task. May be "". */
  approach: string;
  model: string;
  leaseUntil: string;
  /** Declared file intents at start (copied from the task's paths). */
  paths?: string[];
}>;

/** approach/paths replace the attempt's current values when present (a pivot). */
export type AttemptBeat = Ev<"attempt.beat", { attempt: AttemptId; leaseUntil: string; model?: string; approach?: string; paths?: string[] }>;

export type AttemptEnded = Ev<"attempt.ended", { attempt: AttemptId; reason: AttemptEndReason; why?: ReleaseReason }>;

/**
 * The server told an agent, for the first time, that its attempt ended because the task
 * closed (in any signed response). Lets coordination metrics measure the lag after a solve.
 */
export type AttemptNotified = Ev<"attempt.notified", { attempt: AttemptId; agent: AgentId; via: string }>;

/** The head made an agent a lead of an area: it may post tasks and decide proposals under it, and pin digests. */
export type LeadGranted = Ev<"lead.granted", { agent: AgentId; area: TaskId }>;
export type LeadRevoked = Ev<"lead.revoked", { agent: AgentId; area: TaskId }>;

export type NoteAdded = Ev<"note.added", {
  note: NoteId;
  task: TaskId;
  agent: AgentId;
  kind: NoteKind;
  text: string;
  /** The note this one answers (threading). A reply to a question marks it answered. */
  replyTo?: NoteId;
  /** Addressed to one agent: it gets the note as a notice on its next signed request. */
  to?: AgentId;
}>;

/**
 * A submission entered the check queue. File contents are NOT in the log: the server keeps
 * them in `.minga/submissions/<id>.json` until the check finishes, so the log and the live
 * stream stay small.
 */
export type SubmissionQueued = Ev<"submission.queued", {
  submission: SubmissionId;
  attempt: AttemptId;
  task: TaskId;
  agent: AgentId;
  model: string;
  claim: Claim;
  /** One line, becomes the commit subject. */
  message: string;
  files: string[];
  /** Total UTF-8 bytes of the submitted files. */
  bytes: number;
}>;

/** A check run began. Emitted again with round + 1 when the check is re-run on a newer head. */
export type SubmissionStarted = Ev<"submission.started", {
  submission: SubmissionId;
  /** Commit sha of the branch head this run checks against. */
  base: string;
  /** 0 for the first run, 1.. for rechecks after the branch moved. */
  round: number;
}>;

/** Emitted once per submission, after the final run (pass or fail). */
export type SubmissionChecked = Ev<"submission.checked", {
  submission: SubmissionId;
  attempt: AttemptId;
  task: TaskId;
  agent: AgentId;
  model: string;
  claim: Claim;
  files: string[];
  /** Commit the final run checked against. "" when no run happened (e.g. task closed while queued). */
  base?: string;
  /** True when rejected without a verdict on the work: the branch kept moving past the recheck limit, or the task closed first. */
  stale?: boolean;
  ok: boolean;
  exitCode: number;
  timedOut: boolean;
  /** Last few KB of combined stdout/stderr. */
  outputTail: string;
  durationMs: number;
  /** Commit sha when ok. */
  commit?: string;
  /** Points awarded (0 when not ok). */
  points: number;
}>;

export type ProposalMade = Ev<"proposal.made", {
  proposal: ProposalId;
  agent: AgentId;
  kind: ProposalKind;
  /** new_task: the parent (may be null for top level). impossible: the task declared impossible. */
  task: TaskId | null;
  title?: string;
  body?: string;
  evidence?: string;
}>;

/** duplicate: the agent proposed something near-identical, and the server turned it into this vote. */
export type ProposalVoted = Ev<"proposal.voted", { proposal: ProposalId; agent: AgentId; approve: boolean; duplicate?: boolean }>;

export type ProposalDecided = Ev<"proposal.decided", {
  proposal: ProposalId;
  accepted: boolean;
  by: DecidedBy;
  reason?: string;
}>;

export type RuleChanged = Ev<"rule.changed", { rules: Partial<Rules> }>;

export type MingaEvent =
  | AgentJoined
  | AgentBanned
  | TaskPosted
  | TaskClosed
  | AttemptStarted
  | AttemptBeat
  | AttemptEnded
  | AttemptNotified
  | LeadGranted
  | LeadRevoked
  | NoteAdded
  | SubmissionQueued
  | SubmissionStarted
  | SubmissionChecked
  | ProposalMade
  | ProposalVoted
  | ProposalDecided
  | RuleChanged;

export type EventType = MingaEvent["type"];

/** An event before the store stamps `seq` and `at`. */
export type NewEvent = MingaEvent extends infer E ? (E extends MingaEvent ? Omit<E, "seq" | "at"> : never) : never;

// ---------------------------------------------------------------- derived state

export interface AgentState {
  id: AgentId;
  publicKey: string;
  /** Latest model the agent reported (join, attempt start, or beat). */
  model: string;
  harness: string;
  owner?: string;
  joinedAt: string;
  lastSeenAt: string;
  banned: boolean;
  points: number;
  /** Submissions that passed the check. */
  accepted: number;
  /** All checked submissions, pass or fail. */
  submissions: number;
}

export interface TaskState {
  id: TaskId;
  title: string;
  body: string;
  parent: TaskId | null;
  children: TaskId[];
  status: TaskStatus;
  points: number;
  postedAt: string;
  closedAt?: string;
  closedBy?: AgentId;
  /** The accepted submission that closed the task, if any (from task.closed). */
  closedSubmission?: SubmissionId;
  /** Paths or directory prefixes the task expects to touch. */
  paths?: string[];
  /** Every attempt ever started on this task, oldest first. */
  attempts: AttemptId[];
  /** Newest first. */
  notes: NoteId[];
}

export interface AttemptState {
  id: AttemptId;
  task: TaskId;
  agent: AgentId;
  role: Role;
  approach: string;
  model: string;
  startedAt: string;
  leaseUntil: string;
  lastBeatAt: string;
  endedAt?: string;
  endReason?: AttemptEndReason;
  /** Why it was released, when the agent said. */
  releaseReason?: ReleaseReason;
  /** Declared file intents (task paths, replaced by beat). */
  paths?: string[];
  /** When the server first told the agent the task closed under it (attempt.notified). */
  notifiedAt?: string;
}

export interface NoteState {
  id: NoteId;
  task: TaskId;
  agent: AgentId;
  kind: NoteKind;
  text: string;
  at: string;
  replyTo?: NoteId;
  to?: AgentId;
  /** Replies received so far. */
  replies?: number;
}

export type SubmissionStatus = "queued" | "checking" | "accepted" | "rejected";

/**
 * In-memory view of a submission. Deliberately has no `outputTail`: that stays in the log
 * only (read it via `checkedSeq` and EventStore.get), so memory stays flat at scale.
 */
export interface SubmissionState {
  id: SubmissionId;
  attempt: AttemptId;
  task: TaskId;
  agent: AgentId;
  model: string;
  claim: Claim;
  message: string;
  files: string[];
  bytes: number;
  status: SubmissionStatus;
  queuedAt: string;
  /** Start of the latest run. */
  startedAt?: string;
  /** Base of the latest run. */
  base?: string;
  /** Runs started so far (submission.started count). */
  runs: number;
  checkedAt?: string;
  /** Seq of the submission.checked event, to read outputTail from the log. */
  checkedSeq?: number;
  ok?: boolean;
  exitCode?: number;
  timedOut?: boolean;
  stale?: boolean;
  durationMs?: number;
  commit?: string;
  /** Points awarded (0 until accepted). */
  points: number;
}

export interface ProposalState {
  id: ProposalId;
  agent: AgentId;
  kind: ProposalKind;
  task: TaskId | null;
  title?: string;
  body?: string;
  evidence?: string;
  at: string;
  /** agent -> approve */
  votes: Record<AgentId, boolean>;
  decided?: { accepted: boolean; by: DecidedBy; reason?: string; at: string };
}

export interface Counters {
  task: number;
  attempt: number;
  note: number;
  submission: number;
  proposal: number;
}

export interface State {
  /** Seq of the last event folded in. 0 for a fresh state. */
  seq: number;
  rules: Rules;
  agents: Record<AgentId, AgentState>;
  tasks: Record<TaskId, TaskState>;
  attempts: Record<AttemptId, AttemptState>;
  notes: Record<NoteId, NoteState>;
  submissions: Record<SubmissionId, SubmissionState>;
  proposals: Record<ProposalId, ProposalState>;
  /** Area leads: area task -> agents (lead.granted minus lead.revoked). */
  leads?: Record<TaskId, AgentId[]>;
  /** Highest number used per id prefix, so ids are never reused. */
  counters: Counters;
  /**
   * Indexes the reducer maintains so no request scans every attempt or submission.
   * Always consistent with the records above. Never sent to clients.
   */
  index: StateIndex;
}

export interface StateIndex {
  /** Attempts with no endedAt (live, or expired but not yet swept), per agent. Oldest first. */
  openByAgent: Record<AgentId, AttemptId[]>;
  /** Attempts with no endedAt, per task. Oldest first. */
  openByTask: Record<TaskId, AttemptId[]>;
  /** Every attempt with no endedAt, oldest first. */
  openAttempts: AttemptId[];
  /** Submissions with status "queued" or "checking", oldest first. */
  pendingSubmissions: SubmissionId[];
  /** Rejected (non-stale) submissions per agent per task: agent -> task -> count. Used by the scheduler. */
  failures: Record<AgentId, Record<TaskId, number>>;
  /** Unanswered question notes per task, oldest first. */
  openQuestions?: Record<TaskId, NoteId[]>;
  /** Newest digest note per task. */
  digests?: Record<TaskId, NoteId>;
  /** Models that recorded a dead end on a task (release reason or dead_end note), in order. */
  deadEnds?: Record<TaskId, string[]>;
  /** Open attempts per declared path (exact string, as declared). */
  openByPath?: Record<string, AttemptId[]>;
  /** Attempts ended by task_closed whose agent has not been told yet, per agent. */
  unnotified?: Record<AgentId, AttemptId[]>;
  /** Notes addressed to an agent (note.to), oldest first, newest 50 kept. The server tracks delivery in memory. */
  inbox?: Record<AgentId, NoteId[]>;
  /** Areas each agent leads. */
  leadAreas?: Record<AgentId, TaskId[]>;
}

/**
 * How well agents coordinate, folded from the event log by log/coordination.ts.
 * Shown in /api/metrics and the observatory so each field run shows whether coordination improved.
 */
export interface CoordinationStats {
  /** Tasks closed (any status). */
  closes: number;
  /** Attempts ended because their task closed under them. */
  closedUnder: number;
  /** closedUnder / all ended attempts, 0..1. */
  closedUnderShare: number;
  /** Seconds from task.closed to the loser being told (attempt.notified). */
  notifyLagSeconds: { count: number; p50: number; p90: number; max: number };
  /** Notes on closed tasks / closed tasks. */
  notesPerClosedTask: number;
  questions: { asked: number; answered: number; open: number };
  /** Releases with a handoff note, and how many of those tasks were later solved. */
  handoffs: number;
  handoffsFollowedBySolve: number;
  deadEnds: number;
  digests: number;
  /** Proposals the server turned into votes on an existing one. */
  duplicateProposals: number;
}

export interface LeaderRow {
  agent: AgentId;
  model: string;
  harness: string;
  owner?: string;
  points: number;
  accepted: number;
  submissions: number;
}

export interface ModelRow {
  model: string;
  agents: number;
  points: number;
  accepted: number;
  submissions: number;
  /** accepted / submissions, 0..1 (0 when no submissions). */
  passRate: number;
}

export interface Leaderboard {
  /** Sorted by points desc, then accepted desc, then agent id asc. Banned agents excluded. */
  agents: LeaderRow[];
  /** Grouped by the model string each submission was made with. Sorted by points desc. */
  models: ModelRow[];
}
