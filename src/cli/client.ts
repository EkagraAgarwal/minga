/**
 * Typed HTTP client for the minga protocol (src/core/protocol.ts).
 *
 * POSTs are signed with the agent's ed25519 key over the exact body string that
 * is sent; GET reads are unsigned. Non-2xx responses throw
 * `Error("<status>: <body.error>")`. Plain fetch only: this module is bundled
 * for Node.
 */
import type {
  BeatRequest, BeatResponse, EventsResponse, HeadBanRequest, HeadBanResponse, HeadCloseRequest,
  HeadCloseResponse, HeadDecideRequest, HeadDecideResponse, HeadPostRequest, HeadPostResponse,
  HeadRuleRequest, HeadRuleResponse, JoinRequest, JoinResponse, LeaderboardResponse, NextRequest,
  NextResponse, NoteRequest, NoteResponse, ProposeRequest, ProposeResponse, ProjectInfo,
  ReleaseRequest, ReleaseResponse, StateResponse, SubmitRequest, SubmitResponse, VoteRequest,
  VoteResponse,
} from "../core/protocol.ts";
import type { AgentId } from "../core/types.ts";
import { agentIdFromPublicKey, signRequest } from "../identity/keys.ts";
import type { KeyPair } from "../identity/keys.ts";

/** Structural fetch type so tests can inject a mock. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

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

  // signed agent verbs
  join(body: JoinRequest): Promise<JoinResponse>;
  next(body?: NextRequest): Promise<NextResponse>;
  beat(body: BeatRequest): Promise<BeatResponse>;
  note(body: NoteRequest): Promise<NoteResponse>;
  submit(body: SubmitRequest): Promise<SubmitResponse>;
  release(body: ReleaseRequest): Promise<ReleaseResponse>;
  propose(body: ProposeRequest): Promise<ProposeResponse>;
  vote(body: VoteRequest): Promise<VoteResponse>;

  // signed head-only verbs
  headPost(body: HeadPostRequest): Promise<HeadPostResponse>;
  headDecide(body: HeadDecideRequest): Promise<HeadDecideResponse>;
  headRule(body: HeadRuleRequest): Promise<HeadRuleResponse>;
  headBan(body: HeadBanRequest): Promise<HeadBanResponse>;
  headClose(body: HeadCloseRequest): Promise<HeadCloseResponse>;
}

function errorMessage(raw: string, status: number, statusText: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; detail?: unknown };
    if (typeof parsed.error === "string" && parsed.error.length > 0) return parsed.error;
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

    join: (body) => send<JoinResponse>("POST", "/api/join", body),
    next: (body = {}) => send<NextResponse>("POST", "/api/next", body),
    beat: (body) => send<BeatResponse>("POST", "/api/beat", body),
    note: (body) => send<NoteResponse>("POST", "/api/note", body),
    submit: (body) => send<SubmitResponse>("POST", "/api/submit", body),
    release: (body) => send<ReleaseResponse>("POST", "/api/release", body),
    propose: (body) => send<ProposeResponse>("POST", "/api/propose", body),
    vote: (body) => send<VoteResponse>("POST", "/api/vote", body),

    headPost: (body) => send<HeadPostResponse>("POST", "/api/head/post", body),
    headDecide: (body) => send<HeadDecideResponse>("POST", "/api/head/decide", body),
    headRule: (body) => send<HeadRuleResponse>("POST", "/api/head/rule", body),
    headBan: (body) => send<HeadBanResponse>("POST", "/api/head/ban", body),
    headClose: (body) => send<HeadCloseResponse>("POST", "/api/head/close", body),
  };
}
