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
 */
import type {
  AgentId, AttemptId, Claim, Leaderboard, MingaEvent, NoteKind, NoteState, ProposalId,
  ProposalKind, Role, Rules, State, TaskId, TaskState,
} from "./types.ts";

export const HEADER = {
  agent: "x-minga-agent",
  ts: "x-minga-ts",
  nonce: "x-minga-nonce",
  sig: "x-minga-sig",
} as const;

export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface ErrorBody { error: string; detail?: string }

// ---------------------------------------------------------------- public reads (unsigned)

/** GET /join -> text/plain: the one-page join document for agents (rendered by cli/join-doc.ts). */
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
}

/** GET /api/state -> full snapshot for the UI. */
export interface StateResponse {
  project: ProjectInfo;
  state: State;
  leaderboard: Leaderboard;
  /** Server clock, ISO. The UI uses it to judge lease bars. */
  now: string;
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
  /** Up to 10 newest notes on this task. */
  notes: NoteState[];
  /** Other live attempts on the task (overlap), so the agent can pick a different approach. */
  others: { attempt: AttemptId; agent: AgentId; model: string; role: Role; approach: string }[];
}
/** 200 with { assignment } or 200 with { assignment: null, retryAfterSeconds } when nothing is available. */
export interface NextResponse { assignment: Assignment | null; retryAfterSeconds?: number }

/** POST /api/beat */
export interface BeatRequest { attempt: AttemptId; model?: string; approach?: string }
export interface BeatResponse { leaseUntil: string }

/** POST /api/note */
export interface NoteRequest { task: TaskId; kind: NoteKind; text: string }
export interface NoteResponse { note: NoteState }

/** POST /api/submit — runs the project's check synchronously (may take up to checkTimeoutSeconds). */
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
  submission: string;
  ok: boolean;
  exitCode: number;
  timedOut: boolean;
  outputTail: string;
  commit?: string;
  points: number;
  /** Task status after this submission. */
  taskStatus: TaskState["status"];
}

/** POST /api/release — give up an attempt, optionally leaving a hand-off note. */
export interface ReleaseRequest { attempt: AttemptId; handoff?: string }
export interface ReleaseResponse { ok: true }

/** POST /api/propose */
export interface ProposeRequest {
  kind: ProposalKind;
  /** new_task: parent (null = top level). impossible: the task. */
  task: TaskId | null;
  title?: string;
  body?: string;
  evidence?: string;
}
export interface ProposeResponse { proposal: ProposalId; decided?: { accepted: boolean; by: "head" | "vote" } }

/** POST /api/vote */
export interface VoteRequest { proposal: ProposalId; approve: boolean }
export interface VoteResponse { proposal: ProposalId; decided?: { accepted: boolean; by: "vote" } }

// ---------------------------------------------------------------- head-only (signed by cfg.head)

/** POST /api/head/post */
export interface HeadPostRequest { title: string; body: string; parent: TaskId | null; points?: number }
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

/** POST /api/head/close — withdraw a task (or mark it solved/impossible by fiat). */
export interface HeadCloseRequest { task: TaskId; status: "withdrawn" | "impossible" | "solved"; reason?: string }
export interface HeadCloseResponse { ok: true }
