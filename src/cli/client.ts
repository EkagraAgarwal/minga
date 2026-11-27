/**
 * Typed HTTP client for the minga protocol (src/core/protocol.ts).
 *
 * POSTs are signed with the agent's ed25519 key over the exact body string that
 * is sent; GET reads are unsigned. Non-2xx responses throw
 * `Error("<status>: <body.error>")`. Plain fetch only: this module is bundled
 * for Node.
 */
import type {
  AttemptView, BeatRequest, BeatResponse, EventsResponse, HeadBanRequest, HeadBanResponse, HeadCloseRequest,
  HeadCloseResponse, HeadDecideRequest, HeadDecideResponse, HeadNoteRequest, HeadNoteResponse,
  HeadPostRequest, HeadPostResponse, HeadRuleRequest, HeadRuleResponse, HeadLeadRequest, HeadLeadResponse,
  JoinRequest, JoinResponse, LeaderboardResponse, NextRequest,
  NextResponse, NoteRequest, NoteResponse, ProposeRequest, ProposeResponse, ProjectInfo,
  ReleaseRequest, ReleaseResponse, ReviewDetail, ReviewRequest, ReviewResponse, ReviewsResponse,
  SubmitRequest, SubmitResponse, SubmissionView, TasksResponse, VoteRequest, VoteResponse,
} from "../core/protocol.ts";
import type { AgentId } from "../core/types.ts";
import { agentIdFromPublicKey, signRequest } from "../identity/keys.ts";
import type { KeyPair } from "../identity/keys.ts";

/** Structural fetch type so tests can inject a mock. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** GET /api/state shape (not part of the v2 public contract). */
export interface StateResponse {
  project: ProjectInfo;
  state: unknown;
  leaderboard: LeaderboardResponse;
  now: string;
}

export interface Client {
  /** Normalised base URL (no trailing slash). */
  readonly url: string;
  /** This client's agent id, derived from the public key. */
  readonly agent: AgentId;
  readonly publicKey: string;

  // unsigned reads
  project(): Promise<ProjectInfo>;
  state(): Promise<StateResponse>;
  events(after?: number, limit?: number): Promise<EventsResponse>;
  leaderboard(): Promise<LeaderboardResponse>;
  /** GET /api/tasks: every task, compact, for a tree overview. */
  tasks(): Promise<TasksResponse>;
  /** GET /api/submission/<id>?wait=<seconds>. Long-polls at most 30 s per call. */
  submission(id: string, waitSeconds?: number): Promise<SubmissionView>;
  attempt(id: string): Promise<AttemptView>;
  /** GET /api/reviews: submissions waiting for a review (public). */
  reviews(): Promise<ReviewsResponse>;
  /** GET /api/review/<S-n>: diff, warnings and votes (public). */
  review(id: string): Promise<ReviewDetail>;

  // signed agent verbs
  join(body: JoinRequest): Promise<JoinResponse>;
  next(body?: NextRequest): Promise<NextResponse>;
  beat(body: BeatRequest): Promise<BeatResponse>;
  note(body: NoteRequest): Promise<NoteResponse>;
  submit(body: SubmitRequest): Promise<SubmitResponse>;
  release(body: ReleaseRequest): Promise<ReleaseResponse>;
  propose(body: ProposeRequest): Promise<ProposeResponse>;
  vote(body: VoteRequest): Promise<VoteResponse>;
  /** POST /api/review: your vote on a submission waiting in review. */
  reviewVote(body: ReviewRequest): Promise<ReviewResponse>;

  // signed head-only verbs
  /** POST /api/head/review: the head's vote settles a review at once. */
  headReview(body: ReviewRequest): Promise<ReviewResponse>;
  headPost(body: HeadPostRequest): Promise<HeadPostResponse>;
  headDecide(body: HeadDecideRequest): Promise<HeadDecideResponse>;
  headRule(body: HeadRuleRequest): Promise<HeadRuleResponse>;
  headBan(body: HeadBanRequest): Promise<HeadBanResponse>;
  headNote(body: HeadNoteRequest): Promise<HeadNoteResponse>;
  headClose(body: HeadCloseRequest): Promise<HeadCloseResponse>;
  headLead(body: HeadLeadRequest): Promise<HeadLeadResponse>;

  // signed area-lead verbs
  /** POST /api/lead/post: parent must lie inside an area the agent leads. */
  leadPost(body: HeadPostRequest): Promise<HeadPostResponse>;
  /** POST /api/lead/decide: proposal.task must lie inside an area the agent leads. */
  leadDecide(body: HeadDecideRequest): Promise<HeadDecideResponse>;
}

function errorMessage(raw: string, status: number, statusText: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; detail?: unknown };
    if (typeof parsed.error === "string" && parsed.error.length > 0) {
      // The server puts the next step in detail; agents need both lines.
      return typeof parsed.detail === "string" && parsed.detail.length > 0
        ? `${parsed.error}
next: ${parsed.detail}`
        : parsed.error;
    }
    if (typeof parsed.detail === "string" && parsed.detail.length > 0) return parsed.detail;
  } catch {
    // not JSON
  }
  const text = raw.trim();
  return text.length > 0 ? text : statusText || `HTTP ${status}`;
}

export function createClient(baseUrl: string, keys: KeyPair, fetchImpl: FetchLike = fetch): Client {
  const base = baseUrl.replace(/\/+$/, "");
  const agent = agentIdFromPublicKey(keys.publicKey);

  async function send<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const url = `${base}${path}`;
    const headers: Record<string, string> = {};
    let payload: string | undefined;
    if (method === "POST") {
      payload = JSON.stringify(body ?? {});
      headers["content-type"] = "application/json";
      Object.assign(headers, signRequest(keys, "POST", new URL(url).pathname, payload));
    }
    const res = await fetchImpl(url, { method, headers, body: payload });
    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`${res.status}: ${errorMessage(raw, res.status, res.statusText)}`);
    }
    if (raw.length === 0) return undefined as T;
    return JSON.parse(raw) as T;
  }

  return {
    url: base,
    agent,
    publicKey: keys.publicKey,

    project: () => send<ProjectInfo>("GET", "/api/project"),
    state: () => send<StateResponse>("GET", "/api/state"),
    events: (after = 0, limit) => {
      const query = `after=${encodeURIComponent(String(after))}` +
        (limit === undefined ? "" : `&limit=${encodeURIComponent(String(limit))}`);
      return send<EventsResponse>("GET", `/api/events?${query}`);
    },
    leaderboard: () => send<LeaderboardResponse>("GET", "/api/leaderboard"),
    tasks: () => send<TasksResponse>("GET", "/api/tasks"),
    attempt: (id) => send<AttemptView>("GET", `/api/attempt/${encodeURIComponent(id)}`),
    reviews: () => send<ReviewsResponse>("GET", "/api/reviews"),
    review: (id) => send<ReviewDetail>("GET", `/api/review/${encodeURIComponent(id)}`),
    submission: (id, waitSeconds = 0) => {
      const wait = Math.max(0, Math.min(30, Math.floor(waitSeconds)));
      const query = wait > 0 ? `?wait=${wait}` : "";
      return send<SubmissionView>("GET", `/api/submission/${encodeURIComponent(id)}${query}`);
    },

    join: (body) => send<JoinResponse>("POST", "/api/join", body),
    next: (body = {}) => send<NextResponse>("POST", "/api/next", body),
    beat: (body) => send<BeatResponse>("POST", "/api/beat", body),
    note: (body) => send<NoteResponse>("POST", "/api/note", body),
    submit: (body) => send<SubmitResponse>("POST", "/api/submit", body),
    release: (body) => send<ReleaseResponse>("POST", "/api/release", body),
    propose: (body) => send<ProposeResponse>("POST", "/api/propose", body),
    vote: (body) => send<VoteResponse>("POST", "/api/vote", body),
    reviewVote: (body) => send<ReviewResponse>("POST", "/api/review", body),

    headPost: (body) => send<HeadPostResponse>("POST", "/api/head/post", body),
    headReview: (body) => send<ReviewResponse>("POST", "/api/head/review", body),
    headDecide: (body) => send<HeadDecideResponse>("POST", "/api/head/decide", body),
    headRule: (body) => send<HeadRuleResponse>("POST", "/api/head/rule", body),
    headBan: (body) => send<HeadBanResponse>("POST", "/api/head/ban", body),
    headNote: (body) => send<HeadNoteResponse>("POST", "/api/head/note", body),
    headClose: (body) => send<HeadCloseResponse>("POST", "/api/head/close", body),
    headLead: (body) => send<HeadLeadResponse>("POST", "/api/head/lead", body),

    leadPost: (body) => send<HeadPostResponse>("POST", "/api/lead/post", body),
    leadDecide: (body) => send<HeadDecideResponse>("POST", "/api/lead/decide", body),
  };
}
