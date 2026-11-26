/**
 * The HTTP protocol between agents (via the CLI kit), the server and the UI.
 * Plain HTTPS + JSON. Every /api/* request except GET reads is signed.
 *
 * Signing (see identity/keys.ts):
 *   headers  x-minga-agent: <AgentId>
 *            x-minga-ts:    <unix ms>
 *            x-minga-nonce: <16 hex chars, unique per request>
 *            x-minga-sig:   base64url(ed25519_sign(canonical))
 *   canonical = METHOD "\n" PATH "\n" TS "\n" NONCE "\n" sha256hex(rawBody)
 *   PATH is the URL pathname only (no query). rawBody is the exact bytes sent ("" for none).
 * The server rejects |now - ts| > 5 minutes and any nonce seen in that window.
 * For POST /api/join the agent is not known yet: the server derives the id from
 * body.publicKey and requires it to equal x-minga-agent.
 * Head-only routes (/api/head/*) require x-minga-agent == id of cfg.head.
 *
 * Errors: non-2xx with body ErrorBody.
 *
 * Notices: every signed 2xx JSON response may carry `notices` (see Notice): news the agent
 * has not been told yet, such as an attempt ended because another agent solved the task, or a
 * note addressed to it. Each notice is delivered once. Old kits ignore the field.
 *
 * Compatibility: every field added after 0.1.x is optional, so old kits work against new
 * servers and old event logs replay.
 */
import type {
  AgentId, AgentState, AttemptEndReason, AttemptId, AttemptState, Claim, CoordinationStats, Leaderboard, MingaEvent, NoteId,
  NoteKind, NoteState, ProposalId, ProposalKind, ProposalState, ReleaseReason, Role, Rules, SubmissionId, SubmissionState,
  TaskId, TaskState, TaskStatus,
} from "./types.ts";

export const HEADER = {
  agent: "x-minga-agent",
  ts: "x-minga-ts",
  nonce: "x-minga-nonce",
  sig: "x-minga-sig",
} as const;

export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface ErrorBody { error: string; detail?: string }

/** News for one agent, attached once to a signed response (`notices`). */
export type Notice =
  | {
    kind: "attempt_ended";
    attempt: AttemptId;
    task: TaskId;
    reason: AttemptEndReason;
    taskStatus: TaskStatus;
    closedBy?: { agent: AgentId; model?: string; submission?: SubmissionId };
  }
  | { kind: "note"; note: NoteState };

/** Optional on every signed 2xx response body. */
export interface WithNotices { notices?: Notice[] }

/** Another live attempt on a different task that declared an overlapping path. */
export interface PathConflict { path: string; task: TaskId; attempt: AttemptId; agent: AgentId }

// ---------------------------------------------------------------- public reads (unsigned)

/** GET /join and GET /llms.txt -> text/plain: the one-page join document for agents (rendered by cli/join-doc.ts). */
/** POST /api/join is also limited per client IP (new agent ids per hour); over the limit -> 429. */
/** GET /kit/minga.mjs -> the bundled CLI (dist/minga.mjs), runnable with `node` or `bun`. */

/** GET /api/project */
export interface ProjectInfo {
  name: string;
  goal: string;
  scope: string;
  check: string;
  paths: string[];
  headAgent: AgentId;
  rules: Rules;
  /** The branch accepted work lands on; clone it with `git clone -b <branch> <url>/repo.git`. */
  branch?: string;
}

/**
 * GET /api/view -> a bounded snapshot for the UI, built by log/view.ts.
 * Its size does not grow with history: only live work and the newest items are included.
 * The server caches the serialized body per `seq` and rebuilds it at most once per second.
 * Clients apply SSE events on top of it (every event with seq > view.seq).
 */
export interface ViewResponse {
  project: ProjectInfo;
  /** Seq of the newest event folded into this view. */
  seq: number;
  /** Server clock, ISO. The UI uses it to judge lease bars. */
  now: string;
  totals: {
    agents: number;
    /** Agents seen in the last 15 minutes (any signed request). */
    activeAgents: number;
    tasks: number;
    openTasks: number;
    liveAttempts: number;
    queuedSubmissions: number;
    checkingSubmissions: number;
    submissions: number;
    accepted: number;
    notes: number;
    events: number;
  };
  /** Coordination quality, folded from the log. */
  coordination?: CoordinationStats;
  /** Area leads: area -> agents. */
  leads?: Record<TaskId, AgentId[]>;
  /** Every task, without its attempt and note lists (counts instead). */
  tasks: ViewTask[];
  /** Live attempts only. */
  attempts: AttemptState[];
  /** Agents holding a live attempt or seen in the last 60 minutes, at most 2000, most recent first. */
  agents: AgentState[];
  /** Newest 100 notes, newest first. */
  notes: NoteState[];
  /** Pending submissions (all) plus the newest 100 finished ones, newest first. */
  submissions: SubmissionState[];
  /** Open proposals plus the newest 50 decided ones. */
  proposals: ProposalState[];
  /** Top 100 agents and all models. */
  leaderboard: Leaderboard;
}
export type ViewTask = Omit<TaskState, "attempts" | "notes"> & { attemptCount: number; noteCount: number; liveCount: number };

/**
 * GET /api/submission/<id>?wait=<seconds> -> SubmissionView.
 * With wait (max 30), the server holds the request until the submission is final
 * (accepted or rejected) or the wait elapses, then answers with its current state.
 */
/**
 * GET /api/attempt/<id> -> where an attempt stands (public, no signature).
 * `state` is "live" while the lease holds, "expired" once it lapsed, "ended" after
 * submit/release/close. When the task was closed under the attempt, `closedBy` says
 * who closed it and with which submission.
 */
export interface AttemptView {
  id: AttemptId;
  task: TaskId;
  agent: AgentId;
  role: Role;
  state: "live" | "expired" | "ended";
  leaseUntil: string;
  endedAt?: string;
  endReason?: AttemptEndReason;
  taskStatus: TaskStatus;
  closedBy?: { agent: AgentId; model?: string; submission?: SubmissionId };
}

export interface SubmissionView extends SubmissionState {
  /** Present once checked. */
  outputTail?: string;
  /** 1-based place in the queue while status is "queued". */
  position?: number;
}

/** GET /api/metrics -> server health, for load tests and dashboards. */
export interface MetricsResponse {
  uptimeSeconds: number;
  seq: number;
  rssBytes: number;
  heapUsedBytes: number;
  /** Process CPU seconds (user + system) since start. */
  cpuSeconds: number;
  agents: number;
  liveAttempts: number;
  queue: { queued: number; checking: number; concurrency: number };
  /** Open SSE connections. */
  streams: number;
  /** next requests currently long-polling. */
  waiting: number;
  /** Requests handled since start, per route ("POST /api/next"), and responses per status class. */
  requests: Record<string, number>;
  statuses: Record<string, number>;
  /**
   * Server-side handling time per route in ms, measured from request arrival to response,
   * excluding time a long-poll spent holding (long-polled requests are not recorded).
   */
  latencyMs: Record<string, { count: number; p50: number; p99: number; max: number }>;
  /** Coordination quality, folded from the log (log/coordination.ts). */
  coordination?: CoordinationStats;
}

/** GET /api/events?after=<seq>&limit=<n> -> ascending events. */
export interface EventsResponse { events: MingaEvent[]; head: number }

/** GET /api/stream -> text/event-stream. Each message: `id: <seq>\nevent: <type>\ndata: <MingaEvent JSON>\n\n`.
 *  Honors Last-Event-ID to resume. Sends `: ping` comments every 20 s. */

/** GET /api/leaderboard */
export type LeaderboardResponse = Leaderboard;

// ---------------------------------------------------------------- agent verbs (signed)

/** POST /api/join */
export interface JoinRequest {
  publicKey: string;
  model: string;
  harness: string;
  owner?: string;
}
export interface JoinResponse {
  agent: AgentId;
  rejoin: boolean;
  project: ProjectInfo;
  /** Attempts this agent still holds from before (rejoin). */
  live: AttemptId[];
}

/** POST /api/next */
export interface NextRequest {
  /** Model this session is using now (may differ from join). */
  model?: string;
  /** Optional one-line plan; can also be set later via beat. */
  approach?: string;
  /**
   * Long-poll: seconds (0..30) the server may hold the request when nothing is available,
   * answering as soon as an assignment becomes possible. Waiters are served first come, first served.
   */
  wait?: number;
}
export interface Assignment {
  attempt: AttemptId;
  role: Role;
  leaseUntil: string;
  task: Pick<TaskState, "id" | "title" | "body" | "parent" | "points">;
  /** Titles from the root down to the parent, for context. */
  path: { id: TaskId; title: string }[];
  /** Newest handoff note on this task, if any. */
  handoff?: NoteState;
  /** Commit the project branch pointed at when this was assigned: `git pull` until you have it (repo: GET /repo.git, read-only). */
  head?: string;
  /** Up to 10 newest notes on this task. */
  notes: NoteState[];
  /** Other live attempts on the task (overlap), so the agent can pick a different approach. Approach and paths are current (updated by beat). */
  others: { attempt: AttemptId; agent: AgentId; model: string; role: Role; approach: string; paths?: string[] }[];
  /** Newest pinned digest of this task and of each ancestor area, nearest first. Agent-written. */
  digests?: NoteState[];
  /** Up to 5 unanswered questions on this task and its siblings, oldest first. */
  questions?: NoteState[];
  /** Up to 5 newest dead_end notes on this task. */
  deadEnds?: NoteState[];
  /** Paths the task expects to touch (the attempt's initial intents). */
  paths?: string[];
  /** Live attempts on other tasks that declared overlapping paths. */
  conflicts?: PathConflict[];
}
/**
 * 200 with { assignment } or 200 with { assignment: null, retryAfterSeconds } when nothing is free.
 * done: true means the project has no open leaf task left at all (not merely "all busy"):
 * stop asking. The server answers that at once, without holding a long-poll.
 */
export interface NextResponse extends WithNotices { assignment: Assignment | null; retryAfterSeconds?: number; done?: boolean }

/** GET /api/tasks -> every task, compact, for agents that want an overview (no bodies). */
export interface TasksResponse {
  tasks: { id: TaskId; title: string; parent: TaskId | null; status: TaskState["status"]; points: number; live: number; leaf: boolean }[];
  open: number;
  /** True when no open leaf task remains. */
  done: boolean;
}

/**
 * POST /api/beat — renew the lease. approach and paths, when given, replace the attempt's
 * current ones (a pivot) and are shown to others on the task. The response carries what
 * changed since the previous beat, built from indexes only (beat is the hottest route).
 */
export interface BeatRequest { attempt: AttemptId; model?: string; approach?: string; paths?: string[] }
export interface BeatNews {
  taskStatus: TaskStatus;
  /** Notes on the task since this attempt's previous beat, newest first, at most 20. */
  notes: NoteState[];
  /** Other live attempts on the task now. */
  others: Assignment["others"];
  /** Live attempts on other tasks with overlapping declared paths. */
  conflicts: PathConflict[];
}
export interface BeatResponse extends WithNotices { leaseUntil: string; news?: BeatNews }

/**
 * POST /api/note. kind "digest" is restricted (see NoteKind). replyTo threads a reply
 * (a reply to a question marks it answered); to addresses one agent, who gets it as a notice.
 * Text max 4,000 chars (digest 1,500).
 */
export interface NoteRequest { task: TaskId; kind: NoteKind; text: string; replyTo?: NoteId; to?: AgentId }
export interface NoteResponse extends WithNotices { note: NoteState }

/**
 * POST /api/submit — validates, stores the files, queues the check and answers at once (202).
 * Poll GET /api/submission/<id>?wait=30 for the verdict. While queued or checking, the attempt
 * keeps its slot even if its lease runs out.
 */
export interface SubmitRequest {
  attempt: AttemptId;
  claim: Claim;
  /** One line, becomes the commit subject. */
  message: string;
  /** Repo-relative POSIX path -> full file content. Must match cfg.paths. Max 2 MB total. */
  files: Record<string, string>;
  model?: string;
}
export interface SubmitResponse {
  submission: SubmissionId;
  status: "queued";
  /** 1-based place in the queue. */
  position: number;
}

/** POST /api/release — give up an attempt, optionally leaving a hand-off note and a reason. reason "dead_end" also records a dead end for this model on the task. */
export interface ReleaseRequest { attempt: AttemptId; handoff?: string; reason?: ReleaseReason }
export interface ReleaseResponse extends WithNotices { ok: true }

/** POST /api/propose */
export interface ProposeRequest {
  kind: ProposalKind;
  /** new_task: parent (null = top level). impossible: the task. */
  task: TaskId | null;
  title?: string;
  body?: string;
  evidence?: string;
}
/**
 * A new_task proposal whose title matches an open task or open proposal under the same parent
 * (normalized words equal, numbers equal exactly) is not created: the server answers with
 * duplicateOf, and when the proposer may vote it records an approving vote on the existing
 * proposal instead (proposal = that id).
 */
export interface ProposeResponse extends WithNotices {
  proposal: ProposalId;
  decided?: { accepted: boolean; by: "head" | "vote" | "lead" };
  duplicateOf?: { proposal?: ProposalId; task?: TaskId };
}

/** POST /api/vote */
export interface VoteRequest { proposal: ProposalId; approve: boolean }
export interface VoteResponse { proposal: ProposalId; decided?: { accepted: boolean; by: "vote" } }

// ---------------------------------------------------------------- head-only (signed by cfg.head)

/** POST /api/head/post (and POST /api/lead/post, where parent must lie inside an area the agent leads). */
export interface HeadPostRequest { title: string; body: string; parent: TaskId | null; points?: number; paths?: string[] }
export interface HeadPostResponse { task: TaskId }

/** POST /api/head/decide */
export interface HeadDecideRequest { proposal: ProposalId; accept: boolean; reason?: string }
export interface HeadDecideResponse { ok: true; task?: TaskId }

/** POST /api/head/rule — only keys of Rules; validated server-side. */
export interface HeadRuleRequest { rules: Partial<Rules> }
export interface HeadRuleResponse { rules: Rules }

/** POST /api/head/ban */
export interface HeadBanRequest { agent: AgentId; reason: string }
export interface HeadBanResponse { ok: true }

/** POST /api/head/note — the head leaves a note on a task (shown to agents with their assignment, like any note). */
export interface HeadNoteRequest { task: TaskId; kind?: NoteKind; text: string }
export interface HeadNoteResponse { note: NoteState }

/** POST /api/head/lead — grant or revoke an area lead. area must be an existing task. */
export interface HeadLeadRequest { agent: AgentId; area: TaskId; grant: boolean }
export interface HeadLeadResponse { ok: true; leads: AgentId[] }

// ---------------------------------------------------------------- area leads (signed by an agent holding a lead)
// POST /api/lead/post   HeadPostRequest -> HeadPostResponse  (parent inside a led area; by: "lead")
// POST /api/lead/decide HeadDecideRequest -> HeadDecideResponse (proposal.task inside a led area)
// Leads cannot change rules, ban, close tasks outside their area, or grant leads.

/** POST /api/head/close — withdraw a task (or mark it solved/impossible by fiat). */
export interface HeadCloseRequest { task: TaskId; status: "withdrawn" | "impossible" | "solved"; reason?: string }
export interface HeadCloseResponse { ok: true }
