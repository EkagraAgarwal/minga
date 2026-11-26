/**
 * The coordinator: turns verified requests into events, folds them into state,
 * and fans them out to SSE listeners. One instance per project.
 *
 * Every state change goes through `emit`, which appends to the log first and
 * then reduces, so the log is always the source of truth.
 */
import type { CheckResult, CommitInput, EventStore, RunCheck, CommitAccepted } from "../core/contracts.ts";
import type {
  Assignment, ErrorBody, EventsResponse, HeadBanRequest, HeadCloseRequest, HeadDecideRequest,
  HeadPostRequest, HeadRuleRequest, JoinRequest, JoinResponse, NextRequest, NextResponse, NoteRequest,
  ProjectInfo, ProposeRequest, ReleaseRequest, StateResponse, SubmitRequest, SubmitResponse,
  BeatRequest, VoteRequest,
} from "../core/protocol.ts";
import {
  CLOSED_STATUSES, NOTE_KINDS, ROLES,
  type AgentId, type AttemptEndReason, type AttemptId, type Claim, type MingaEvent, type NewEvent,
  type ProjectConfig, type ProposalId, type Rules, type State, type TaskId,
} from "../core/types.ts";
import { agentIdFromPublicKey, parseHeadKey } from "../identity/keys.ts";
import { computeLeaderboard, initialState, isLive, liveAttempts, nextId, reduce } from "../log/reducer.ts";
import { pathAllowed, parseAcceptPolicy } from "../project/config.ts";
import { decideByVotes, expiredAttempts, pickTask } from "../sched/scheduler.ts";
import { authenticate, HttpError, NonceCache, RateLimiter } from "./auth.ts";

export interface AppDeps {
  cfg: ProjectConfig;
  store: EventStore;
  repoDir: string;
  runCheck: RunCheck;
  commitAccepted: CommitAccepted;
  now?: () => Date;
  rng?: () => number;
  /** Signed requests per agent per minute. Default 120. */
  rateLimitPerMinute?: number;
}

const MAX_BODY = 3 * 1024 * 1024;
const MAX_FILES_BYTES = 2 * 1024 * 1024;
const NOTE_MAX = 4000;

export function createApp(deps: AppDeps) {
  const { cfg, store, repoDir } = deps;
  const now = deps.now ?? (() => new Date());
  const headPublicKey = parseHeadKey(cfg.head);
  const headId = agentIdFromPublicKey(headPublicKey);
  const nonces = new NonceCache();
  const limiter = new RateLimiter(deps.rateLimitPerMinute ?? 120);
  const listeners = new Set<(e: MingaEvent) => void>();

  // ---------------------------------------------------------------- state
  const state: State = initialState(structuredClone(cfg.rules));
  for (const e of store.since(0)) reduce(state, e);

  function emit(ev: NewEvent): MingaEvent {
    const stored = store.append(ev, now());
    reduce(state, stored);
    for (const l of listeners) {
      try { l(stored); } catch (err) { console.error("listener failed", err); }
    }
    return stored;
  }

  // Seed tasks from project.toml the first time this project starts.
  if (!Object.keys(state.tasks).length && cfg.seedTasks.length) {
    const byKey = new Map<string, TaskId>();
    for (const s of cfg.seedTasks) {
      const id = nextId(state, "task");
      emit({ type: "task.posted", actor: "server", data: {
        task: id, title: s.title, body: s.body, parent: s.under ? byKey.get(s.under) ?? null : null,
        points: s.points ?? state.rules.defaultPoints, by: "config",
      } });
      if (s.key) byKey.set(s.key, id);
    }
  }

  // ---------------------------------------------------------------- helpers
  const leaseUntil = () => new Date(now().getTime() + state.rules.leaseMinutes * 60_000).toISOString();
  const projectInfo = (): ProjectInfo => ({
    name: cfg.name, goal: cfg.goal, scope: cfg.scope, check: cfg.check, paths: cfg.paths, headAgent: headId, rules: state.rules,
  });
  const json = (data: unknown, status = 200) => Response.json(data, { status });
  const fail = (status: number, error: string, detail?: string) => json({ error, ...(detail ? { detail } : {}) } satisfies ErrorBody, status);

  function str(v: unknown, name: string, max: number, opts: { optional?: boolean; allowEmpty?: boolean } = {}): string {
    if (v === undefined || v === null) {
      if (opts.optional) return "";
      throw new HttpError(400, `${name} is required`);
    }
    if (typeof v !== "string") throw new HttpError(400, `${name} must be a string`);
    if (!opts.allowEmpty && !v.trim() && !opts.optional) throw new HttpError(400, `${name} must not be empty`);
    if (v.length > max) throw new HttpError(400, `${name} is longer than ${max} characters`);
    return v;
  }

  function agentOrThrow(id: AgentId) {
    const a = state.agents[id];
    if (!a) throw new HttpError(401, "unknown agent", "run join first");
    if (a.banned) throw new HttpError(403, "agent is banned");
    return a;
  }

  function ownLiveAttempt(agent: AgentId, attempt: unknown): AttemptId {
    const id = str(attempt, "attempt", 32);
    const at = state.attempts[id];
    if (!at || at.agent !== agent) throw new HttpError(404, `no attempt ${id} for this agent`);
    if (at.endedAt) throw new HttpError(410, `attempt ${id} already ended (${at.endReason})`);
    if (!isLive(state, id, now())) throw new HttpError(410, `attempt ${id} lease expired`, "run next to get a new assignment");
    return id;
  }

  function endAttempts(ids: AttemptId[], reason: AttemptEndReason) {
    for (const a of ids) if (!state.attempts[a]?.endedAt) emit({ type: "attempt.ended", actor: "server", data: { attempt: a, reason } });
  }

  function closeTask(task: TaskId, status: "solved" | "refuted" | "impossible" | "withdrawn", extra: { agent?: AgentId; submission?: string; proposal?: ProposalId }, actor: AgentId | "server") {
    emit({ type: "task.closed", actor, data: { task, status, ...extra } });
    endAttempts(liveAttempts(state, task, now()), "task_closed");
    // An area closes once every task under it is closed: solved if any child was solved or refuted.
    const parent = state.tasks[task]?.parent ? state.tasks[state.tasks[task]!.parent!] : undefined;
    if (parent && parent.status === "open" && parent.children.every((c) => state.tasks[c]?.status !== "open")) {
      const productive = parent.children.some((c) => ["solved", "refuted"].includes(state.tasks[c]!.status));
      closeTask(parent.id, productive ? "solved" : "withdrawn", {}, "server");
    }
  }

  /** Attempts with a submission waiting for or inside the check. Sweeps skip them. */
  const queued = new Set<AttemptId>();

  function sweep() {
    const expired = expiredAttempts(state, now()).filter((a) => !queued.has(a));
    endAttempts(expired, "expired");
    return expired.length;
  }

  function applyDecision(proposal: ProposalId, accepted: boolean, by: "head" | "vote", actor: AgentId | "server", reason?: string): TaskId | undefined {
    emit({ type: "proposal.decided", actor, data: { proposal, accepted, by, ...(reason ? { reason } : {}) } });
    if (!accepted) return undefined;
    const p = state.proposals[proposal]!;
    if (p.kind === "new_task") {
      const id = nextId(state, "task");
      emit({ type: "task.posted", actor, data: {
        task: id, title: p.title ?? "Untitled", body: p.body ?? "", parent: p.task, points: state.rules.defaultPoints, by, proposal,
      } });
      return id;
    }
    if (p.task && state.tasks[p.task]?.status === "open") closeTask(p.task, "impossible", { agent: p.agent, proposal }, actor);
    return p.task ?? undefined;
  }

  // Submissions run one at a time: check, commit and the closing events form one
  // critical section, so two agents can never both win a task, and every check
  // runs against the exact tree its commit lands on. The cost is one check at a time.
  let submitChain: Promise<unknown> = Promise.resolve();
  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = submitChain.then(fn, fn);
    submitChain = run.then(() => undefined, () => undefined);
    return run;
  }

  // ---------------------------------------------------------------- agent verbs
  function join(agent: AgentId, b: JoinRequest): JoinResponse {
    const model = str(b.model, "model", 80);
    const harness = str(b.harness, "harness", 40);
    const owner = b.owner === undefined ? undefined : str(b.owner, "owner", 40);
    const existing = state.agents[agent];
    if (existing?.banned) throw new HttpError(403, "agent is banned");
    emit({ type: "agent.joined", actor: agent, data: {
      agent, publicKey: b.publicKey, model, harness, ...(owner ? { owner } : {}), rejoin: !!existing,
    } });
    const live = Object.values(state.attempts).filter((a) => a.agent === agent && isLive(state, a.id, now())).map((a) => a.id);
    return { agent, rejoin: !!existing, project: projectInfo(), live };
  }

  function next(agent: AgentId, b: NextRequest): NextResponse {
    const a = agentOrThrow(agent);
    sweep();
    const model = b.model === undefined ? a.model : str(b.model, "model", 80);
    const approach = str(b.approach, "approach", 300, { optional: true });
    const holding = Object.values(state.attempts).filter((x) => x.agent === agent && isLive(state, x.id, now()));
    if (holding.length >= state.rules.maxAttemptsPerAgent) {
      throw new HttpError(409, `already holding ${holding.map((h) => h.id).join(", ")}`, "beat, submit or release it first");
    }
    const pick = pickTask({ state, agent, now: now(), ...(deps.rng ? { rng: deps.rng } : {}) });
    if (!pick) return { assignment: null, retryAfterSeconds: 60 };
    const attempt = nextId(state, "attempt");
    const until = leaseUntil();
    emit({ type: "attempt.started", actor: agent, data: { attempt, task: pick.task, agent, role: pick.role, approach, model, leaseUntil: until } });
    const t = state.tasks[pick.task]!;
    const path: { id: TaskId; title: string }[] = [];
    for (let p = t.parent; p; p = state.tasks[p]?.parent ?? null) {
      const pt = state.tasks[p];
      if (!pt) break;
      path.unshift({ id: pt.id, title: pt.title });
    }
    const notes = t.notes.slice(0, 10).map((n) => state.notes[n]!).filter(Boolean);
    const handoffId = t.notes.find((n) => state.notes[n]?.kind === "handoff");
    const others = liveAttempts(state, t.id, now()).filter((x) => x !== attempt).map((x) => {
      const o = state.attempts[x]!;
      return { attempt: o.id, agent: o.agent, model: o.model, role: o.role, approach: o.approach };
    });
    const assignment: Assignment = {
      attempt, role: pick.role, leaseUntil: until,
      task: { id: t.id, title: t.title, body: t.body, parent: t.parent, points: t.points },
      path, notes, others, ...(handoffId ? { handoff: state.notes[handoffId]! } : {}),
    };
    return { assignment };
  }

  function beat(agent: AgentId, b: BeatRequest) {
    agentOrThrow(agent);
    const attempt = ownLiveAttempt(agent, b.attempt);
    const model = b.model === undefined ? undefined : str(b.model, "model", 80);
    const until = leaseUntil();
    emit({ type: "attempt.beat", actor: agent, data: { attempt, leaseUntil: until, ...(model ? { model } : {}) } });
    return { leaseUntil: until };
  }

  function note(agent: AgentId, b: NoteRequest) {
    agentOrThrow(agent);
    const task = str(b.task, "task", 32);
    if (!state.tasks[task]) throw new HttpError(404, `no task ${task}`);
    if (!NOTE_KINDS.includes(b.kind)) throw new HttpError(400, `kind must be one of ${NOTE_KINDS.join(", ")}`);
    const text = str(b.text, "text", NOTE_MAX);
    const id = nextId(state, "note");
    emit({ type: "note.added", actor: agent, data: { note: id, task, agent, kind: b.kind, text } });
    return { note: state.notes[id]! };
  }

  function submit(agent: AgentId, b: SubmitRequest): Promise<SubmitResponse> {
    // Validate cheaply up front so bad requests never wait in the queue, then again inside it.
    const { attempt } = validateSubmit(agent, b);
    if (queued.has(attempt)) throw new HttpError(409, `attempt ${attempt} already has a submission in the queue`);
    queued.add(attempt);
    return serialized(() => submitLocked(agent, b)).finally(() => queued.delete(attempt));
  }

  function validateSubmit(agent: AgentId, b: SubmitRequest) {
    const a = agentOrThrow(agent);
    // A queued attempt keeps its slot even if its lease runs out while it waits.
    const id = typeof b.attempt === "string" ? b.attempt : "";
    const attempt = queued.has(id) && state.attempts[id]?.agent === agent && !state.attempts[id]?.endedAt ? id : ownLiveAttempt(agent, b.attempt);
    const at = state.attempts[attempt]!;
    const task = state.tasks[at.task]!;
    if (task.status !== "open") throw new HttpError(409, `task ${task.id} is already ${task.status}`);
    return { a, attempt, at, task };
  }

  async function submitLocked(agent: AgentId, b: SubmitRequest): Promise<SubmitResponse> {
    const { a, attempt, at, task } = validateSubmit(agent, b);
    const claims: Claim[] = ["solves", "refutes", "progress"];
    if (!claims.includes(b.claim)) throw new HttpError(400, "claim must be solves, refutes or progress");
    const message = str(b.message, "message", 200).split("\n")[0]!;
    const model = b.model === undefined ? at.model : str(b.model, "model", 80);
    if (!b.files || typeof b.files !== "object" || Array.isArray(b.files)) throw new HttpError(400, "files must be an object of path -> content");
    const paths = Object.keys(b.files);
    if (!paths.length) throw new HttpError(400, "files is empty");
    let bytes = 0;
    for (const p of paths) {
      const c = b.files[p];
      if (typeof c !== "string") throw new HttpError(400, `content of ${p} must be a string`);
      if (!pathAllowed(cfg, p)) throw new HttpError(400, `path not allowed: ${p}`, `allowed: ${cfg.paths.join(", ")}`);
      bytes += Buffer.byteLength(c);
    }
    if (bytes > MAX_FILES_BYTES) throw new HttpError(413, "files exceed 2 MB");

    const result: CheckResult = await deps.runCheck({
      repoDir, branch: cfg.branch, files: b.files, command: cfg.check, timeoutSeconds: cfg.checkTimeoutSeconds,
    });

    let commit: string | undefined;
    let points = 0;
    if (result.ok) {
      const commitInput: CommitInput = {
        repoDir, branch: cfg.branch, files: b.files, message: `${task.id}: ${message}`,
        author: `minga agent ${agent.slice(0, 8)}`,
        trailers: {
          "Agent-Id": agent, "Agent-Model": model, "Agent-Harness": a.harness,
          "Minga-Task": task.id, "Minga-Attempt": attempt, "Minga-Claim": b.claim,
        },
      };
      commit = await deps.commitAccepted(commitInput);
      points = b.claim === "progress" ? Math.max(1, Math.round(task.points / 5)) : task.points;
    }
    const submission = nextId(state, "submission");
    emit({ type: "submission.checked", actor: agent, data: {
      submission, attempt, task: task.id, agent, model, claim: b.claim, files: paths,
      ok: result.ok, exitCode: result.exitCode, timedOut: result.timedOut, outputTail: result.outputTail,
      durationMs: result.durationMs, points, ...(commit ? { commit } : {}),
    } });
    if (commit) {
      endAttempts([attempt], "submitted");
      if (b.claim !== "progress") closeTask(task.id, b.claim === "solves" ? "solved" : "refuted", { agent, submission }, agent);
    }
    return {
      submission, ok: result.ok, exitCode: result.exitCode, timedOut: result.timedOut, outputTail: result.outputTail,
      points, taskStatus: state.tasks[task.id]!.status, ...(commit ? { commit } : {}),
    };
  }

  function release(agent: AgentId, b: ReleaseRequest) {
    agentOrThrow(agent);
    const attempt = ownLiveAttempt(agent, b.attempt);
    const handoff = str(b.handoff, "handoff", NOTE_MAX, { optional: true });
    if (handoff.trim()) {
      const id = nextId(state, "note");
      emit({ type: "note.added", actor: agent, data: { note: id, task: state.attempts[attempt]!.task, agent, kind: "handoff", text: handoff } });
    }
    emit({ type: "attempt.ended", actor: agent, data: { attempt, reason: "released" } });
    return { ok: true as const };
  }

  function propose(agent: AgentId, b: ProposeRequest) {
    agentOrThrow(agent);
    let task: TaskId | null = null;
    if (b.kind === "new_task") {
      if (b.task !== null && b.task !== undefined) {
        task = str(b.task, "task", 32);
        if (!state.tasks[task]) throw new HttpError(404, `no task ${task}`);
      }
      str(b.title, "title", 200);
    } else if (b.kind === "impossible") {
      task = str(b.task, "task", 32);
      if (state.tasks[task]?.status !== "open") throw new HttpError(409, `task ${task} is not open`);
      str(b.evidence, "evidence", NOTE_MAX);
    } else throw new HttpError(400, "kind must be new_task or impossible");
    const id = nextId(state, "proposal");
    emit({ type: "proposal.made", actor: agent, data: {
      proposal: id, agent, kind: b.kind, task,
      ...(b.title ? { title: b.title } : {}), ...(b.body ? { body: str(b.body, "body", NOTE_MAX) } : {}),
      ...(b.evidence ? { evidence: b.evidence } : {}),
    } });
    return { proposal: id };
  }

  function vote(agent: AgentId, b: VoteRequest) {
    const a = agentOrThrow(agent);
    const id = str(b.proposal, "proposal", 32);
    const p = state.proposals[id];
    if (!p) throw new HttpError(404, `no proposal ${id}`);
    if (p.decided) throw new HttpError(409, `proposal ${id} is already decided`);
    if (p.agent === agent) throw new HttpError(403, "you cannot vote on your own proposal");
    if (typeof b.approve !== "boolean") throw new HttpError(400, "approve must be true or false");
    emit({ type: "proposal.voted", actor: a.id, data: { proposal: id, agent, approve: b.approve } });
    const d = decideByVotes(state, id);
    if (d) {
      applyDecision(id, d.accepted, "vote", "server");
      return { proposal: id, decided: { accepted: d.accepted, by: "vote" as const } };
    }
    return { proposal: id };
  }

  // ---------------------------------------------------------------- head verbs
  function headPost(b: HeadPostRequest) {
    const title = str(b.title, "title", 200);
    const body = str(b.body, "body", NOTE_MAX, { optional: true });
    const parent = b.parent ?? null;
    if (parent && !state.tasks[parent]) throw new HttpError(404, `no task ${parent}`);
    const points = b.points ?? state.rules.defaultPoints;
    if (!Number.isInteger(points) || points < 0) throw new HttpError(400, "points must be an integer >= 0");
    const id = nextId(state, "task");
    emit({ type: "task.posted", actor: headId, data: { task: id, title, body, parent, points, by: "head" } });
    return { task: id };
  }

  function headDecide(b: HeadDecideRequest) {
    if (state.rules.accept.mode === "votes") throw new HttpError(403, "accept policy is votes only");
    const p = state.proposals[b.proposal];
    if (!p) throw new HttpError(404, `no proposal ${b.proposal}`);
    if (p.decided) throw new HttpError(409, "already decided");
    const task = applyDecision(p.id, !!b.accept, "head", headId, b.reason ? str(b.reason, "reason", 500) : undefined);
    return { ok: true as const, ...(task ? { task } : {}) };
  }

  function headRule(b: HeadRuleRequest): { rules: Rules } {
    const r = b.rules ?? {};
    const out: Partial<Rules> = {};
    const posInt = (k: "width" | "leaseMinutes" | "maxAttemptsPerAgent" | "defaultPoints", min: number) => {
      const v = r[k];
      if (v === undefined) return;
      if (!Number.isInteger(v) || v < min) throw new HttpError(400, `${k} must be an integer >= ${min}`);
      out[k] = v;
    };
    posInt("width", 1); posInt("leaseMinutes", 1); posInt("maxAttemptsPerAgent", 1); posInt("defaultPoints", 0);
    if (r.accept !== undefined) {
      try { out.accept = typeof r.accept === "string" ? parseAcceptPolicy(r.accept) : parseAcceptPolicy(r.accept.mode === "head" ? "head" : `${r.accept.mode}:${r.accept.votes}`); }
      catch (err) { throw new HttpError(400, (err as Error).message); }
    }
    if (r.roles !== undefined) {
      const roles = { ...state.rules.roles };
      for (const [k, v] of Object.entries(r.roles)) {
        if (!ROLES.includes(k as never) || typeof v !== "number" || v < 0) throw new HttpError(400, `bad role weight ${k}`);
        roles[k as keyof typeof roles] = v;
      }
      if (!Object.values(roles).some((v) => v > 0)) throw new HttpError(400, "at least one role weight must be > 0");
      out.roles = roles;
    }
    const unknown = Object.keys(r).filter((k) => !["width", "leaseMinutes", "maxAttemptsPerAgent", "defaultPoints", "accept", "roles"].includes(k));
    if (unknown.length) throw new HttpError(400, `unknown rule: ${unknown.join(", ")}`);
    emit({ type: "rule.changed", actor: headId, data: { rules: out } });
    return { rules: state.rules };
  }

  function headBan(b: HeadBanRequest) {
    const target = str(b.agent, "agent", 16);
    if (!state.agents[target]) throw new HttpError(404, `no agent ${target}`);
    emit({ type: "agent.banned", actor: headId, data: { agent: target, reason: str(b.reason, "reason", 500) } });
    endAttempts(Object.values(state.attempts).filter((a) => a.agent === target && !a.endedAt).map((a) => a.id), "banned");
    return { ok: true as const };
  }

  function headClose(b: HeadCloseRequest) {
    const task = str(b.task, "task", 32);
    if (state.tasks[task]?.status !== "open") throw new HttpError(409, `task ${task} is not open`);
    if (!["withdrawn", "impossible", "solved"].includes(b.status)) throw new HttpError(400, "status must be withdrawn, impossible or solved");
    closeTask(task, b.status, {}, headId);
    return { ok: true as const };
  }

  // ---------------------------------------------------------------- SSE
  function stream(req: Request): Response {
    const lastId = Number(req.headers.get("last-event-id") ?? new URL(req.url).searchParams.get("after") ?? NaN);
    const enc = new TextEncoder();
    let cleanup = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        const send = (e: MingaEvent) => ctrl.enqueue(enc.encode(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
        ctrl.enqueue(enc.encode(`retry: 3000\n\n`));
        if (Number.isFinite(lastId)) for (const e of store.since(lastId, 5000)) send(e);
        const l = (e: MingaEvent) => { try { send(e); } catch { cleanup(); } };
        listeners.add(l);
        const ping = setInterval(() => { try { ctrl.enqueue(enc.encode(`: ping\n\n`)); } catch { cleanup(); } }, 20_000);
        cleanup = () => { listeners.delete(l); clearInterval(ping); };
        req.signal.addEventListener("abort", () => { cleanup(); try { ctrl.close(); } catch {} });
      },
      cancel() { cleanup(); },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" } });
  }

  // ---------------------------------------------------------------- router
  type Handler = (agent: AgentId, body: any) => unknown | Promise<unknown>;
  const signed: Record<string, Handler> = {
    "/api/next": next, "/api/beat": beat, "/api/note": note, "/api/submit": submit,
    "/api/release": release, "/api/propose": propose, "/api/vote": vote,
  };
  const head: Record<string, (body: any) => unknown> = {
    "/api/head/post": headPost, "/api/head/decide": headDecide, "/api/head/rule": headRule,
    "/api/head/ban": headBan, "/api/head/close": headClose,
  };

  async function handleApi(req: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    if (req.method === "GET") {
      if (path === "/api/project") return json(projectInfo());
      if (path === "/api/state") return json({ project: projectInfo(), state, leaderboard: computeLeaderboard(state), now: now().toISOString() } satisfies StateResponse);
      if (path === "/api/leaderboard") return json(computeLeaderboard(state));
      if (path === "/api/events") {
        const after = Number(url.searchParams.get("after") ?? 0) || 0;
        const limit = Math.min(5000, Number(url.searchParams.get("limit") ?? 1000) || 1000);
        return json({ events: store.since(after, limit), head: store.head() } satisfies EventsResponse);
      }
      if (path === "/api/stream") return stream(req);
      return fail(404, "not found");
    }
    if (req.method !== "POST") return fail(405, "method not allowed");

    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > MAX_BODY) return fail(413, "request too large");
    const raw = await req.text();
    if (raw.length > MAX_BODY) return fail(413, "request too large");
    let body: any;
    try { body = raw ? JSON.parse(raw) : {}; } catch { return fail(400, "body is not valid JSON"); }
    if (typeof body !== "object" || body === null || Array.isArray(body)) return fail(400, "body must be a JSON object");

    const nowMs = now().getTime();
    const lookup = (id: AgentId) => (id === headId ? headPublicKey : state.agents[id]?.publicKey);
    if (path === "/api/join") {
      if (typeof body.publicKey !== "string") return fail(400, "publicKey is required");
      const agent = authenticate({ req, body: raw, nowMs, nonces, lookup, claimedPublicKey: body.publicKey });
      if (!limiter.take(agent, nowMs)) return fail(429, "slow down");
      return json(join(agent, body));
    }
    const agent = authenticate({ req, body: raw, nowMs, nonces, lookup });
    if (!limiter.take(agent, nowMs)) return fail(429, "slow down");
    const h = head[path];
    if (h) {
      if (agent !== headId) return fail(403, "head key required");
      return json(await h(body));
    }
    const s = signed[path];
    if (!s) return fail(404, "not found");
    return json(await s(agent, body));
  }

  async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith("/api/")) return await handleApi(req, url);
      return fail(404, "not found");
    } catch (err) {
      if (err instanceof HttpError) return fail(err.status, err.message, err.detail);
      console.error(err);
      return fail(500, "internal error", (err as Error).message);
    }
  }

  return {
    fetch, sweep, emit, projectInfo,
    get state() { return state; },
    headId,
    /** Number of open SSE connections. */
    get listeners() { return listeners.size; },
    /** Closed statuses re-exported for callers. */
    CLOSED_STATUSES,
  };
}

export type App = ReturnType<typeof createApp>;
