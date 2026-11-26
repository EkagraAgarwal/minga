/**
 * The coordinator: turns verified requests into events, folds them into state,
 * and fans them out to SSE listeners. One instance per project.
 *
 * Every state change goes through `emit`, which appends to the log first and
 * then reduces, so the log is always the source of truth.
 *
 * Built for thousands of agents on a 2-3 core machine:
 * - hot paths use the reducer's indexes, never full scans;
 * - submissions are queued and answered at once; a fixed pool of warm worktrees runs
 *   checks in parallel, at most one per task, each pinned to the commit it lands on;
 * - `next` and submission reads can long-poll, so idle agents cost one open request;
 * - the UI snapshot is bounded and cached, and SSE frames are encoded once per event.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import type { BranchHead, ChangedPaths, CheckPool, CheckResult, CommitAccepted, EventStore } from "../core/contracts.ts";
import type {
  Assignment, BeatRequest, ErrorBody, EventsResponse, HeadBanRequest, HeadCloseRequest, HeadDecideRequest,
  HeadPostRequest, HeadRuleRequest, JoinRequest, JoinResponse, MetricsResponse, NextRequest, NextResponse,
  NoteRequest, ProjectInfo, ProposeRequest, ReleaseRequest, SubmissionView, SubmitRequest, SubmitResponse, TasksResponse,
  VoteRequest,
} from "../core/protocol.ts";
import {
  CLOSED_STATUSES, NOTE_KINDS, ROLES,
  type AgentId, type AttemptEndReason, type AttemptId, type Claim, type MingaEvent, type NewEvent,
  type ProjectConfig, type ProposalId, type Rules, type State, type SubmissionId, type SubmissionState, type TaskId,
} from "../core/types.ts";
import { agentIdFromPublicKey, parseHeadKey } from "../identity/keys.ts";
import { agentLiveAttempts, computeLeaderboard, initialState, isLive, liveAttempts, nextId, reduce } from "../log/reducer.ts";
import { buildView } from "../log/view.ts";
import { pathAllowed, parseAcceptPolicy } from "../project/config.ts";
import { decideByVotes, expiredAttempts, pickTask } from "../sched/scheduler.ts";
import { authenticate, HttpError, NonceCache, RateLimiter } from "./auth.ts";
import { Latency } from "./latency.ts";

export interface AppDeps {
  cfg: ProjectConfig;
  store: EventStore;
  repoDir: string;
  /** Runs checks; its size is the check concurrency. */
  pool: Pick<CheckPool, "run" | "size" | "busy">;
  commitAccepted: CommitAccepted;
  branchHead: BranchHead;
  changedPaths: ChangedPaths;
  /** Where queued submissions' files wait for their check. Default `<repoDir>/.minga/submissions`. */
  submissionsDir?: string;
  now?: () => Date;
  rng?: () => number;
  /** Signed requests per agent per minute. Default 120. */
  rateLimitPerMinute?: number;
  /** New agent ids per client IP per hour. 0 disables. Default 20. */
  joinLimitPerHour?: number;
  /** Re-runs of a passing check after the branch moved, before giving up as stale. Default 3. */
  recheckLimit?: number;
}

const MAX_BODY = 3 * 1024 * 1024;
const MAX_FILES_BYTES = 2 * 1024 * 1024;
const NOTE_MAX = 4000;
const MAX_WAIT_SECONDS = 30;
/** SSE frames a slow viewer may fall behind before it is disconnected (it reconnects with Last-Event-ID). */
const MAX_STREAM_BACKLOG = 2000;
/** Event types that can free capacity for, or end, a waiting `next`. */
const CAPACITY_EVENTS = new Set<MingaEvent["type"]>(["task.posted", "attempt.ended", "rule.changed", "task.closed"]);

type Waiter = { agent: AgentId; model: string; approach: string; finish: (a: Assignment | null | "done") => void };

export function createApp(deps: AppDeps) {
  const { cfg, store, repoDir } = deps;
  const now = deps.now ?? (() => new Date());
  const headPublicKey = parseHeadKey(cfg.head);
  const headId = agentIdFromPublicKey(headPublicKey);
  const nonces = new NonceCache();
  const limiter = new RateLimiter(deps.rateLimitPerMinute ?? 120);
  const joinLimit = deps.joinLimitPerHour ?? 20;
  const recheckLimit = deps.recheckLimit ?? 3;
  const submissionsDir = deps.submissionsDir ?? pathJoin(repoDir, ".minga", "submissions");
  mkdirSync(submissionsDir, { recursive: true });
  const startedAt = Date.now();
  const enc = new TextEncoder();
  const listeners = new Set<(bytes: Uint8Array) => void>();
  const requests: Record<string, number> = {};
  /** Long-polling `next` requests, oldest first (Map keeps insertion order). One per agent. */
  const waiters = new Map<AgentId, Waiter>();
  let waitersScheduled = false;
  const submissionWaiters = new Map<SubmissionId, Set<() => void>>();
  const statuses: Record<string, number> = {};
  const latency = new Map<string, Latency>();
  /** Requests that long-polled; their wall time is not handling time, so latency skips them. */
  const heldRequests = new WeakSet<AbortSignal>();

  // ---------------------------------------------------------------- state
  const state: State = initialState(structuredClone(cfg.rules));
  for (const e of store.since(0)) reduce(state, e);

  function emit(ev: NewEvent): MingaEvent {
    const stored = store.append(ev, now());
    reduce(state, stored);
    if (listeners.size) {
      const frame = enc.encode(`id: ${stored.seq}\nevent: ${stored.type}\ndata: ${JSON.stringify(stored)}\n\n`);
      for (const l of listeners) {
        try { l(frame); } catch (err) { console.error("listener failed", err); }
      }
    }
    if (CAPACITY_EVENTS.has(stored.type)) scheduleWaiters();
    if (stored.type === "submission.checked") settleSubmissionWaiters(stored.data.submission);
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

  function str(v: unknown, name: string, max: number, opts: { optional?: boolean } = {}): string {
    if (v === undefined || v === null) {
      if (opts.optional) return "";
      throw new HttpError(400, `${name} is required`);
    }
    if (typeof v !== "string") throw new HttpError(400, `${name} must be a string`);
    if (!v.trim() && !opts.optional) throw new HttpError(400, `${name} must not be empty`);
    if (v.length > max) throw new HttpError(400, `${name} is longer than ${max} characters`);
    return v;
  }

  function waitSeconds(v: unknown): number {
    if (v === undefined || v === null || v === "") return 0;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new HttpError(400, "wait must be a number of seconds >= 0");
    return Math.min(MAX_WAIT_SECONDS, n);
  }

  function agentOrThrow(id: AgentId) {
    const a = state.agents[id];
    if (!a) throw new HttpError(401, "unknown agent", "run join first");
    if (a.banned) throw new HttpError(403, "agent is banned");
    return a;
  }

  function pendingFor(attempt: AttemptId): SubmissionId | undefined {
    return state.index.pendingSubmissions.find((s) => state.submissions[s]?.attempt === attempt);
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

  function closeTask(task: TaskId, status: "solved" | "refuted" | "impossible" | "withdrawn", extra: { agent?: AgentId; submission?: SubmissionId; proposal?: ProposalId }, actor: AgentId | "server") {
    emit({ type: "task.closed", actor, data: { task, status, ...extra } });
    // Attempts still waiting on a check keep running; their check finishes as stale.
    endAttempts(liveAttempts(state, task, now()).filter((a) => !pendingFor(a)), "task_closed");
    // An area closes once every task under it is closed: solved if any child was solved or refuted.
    const parentId = state.tasks[task]?.parent;
    const parent = parentId ? state.tasks[parentId] : undefined;
    if (parent && parent.status === "open" && parent.children.every((c) => state.tasks[c]?.status !== "open")) {
      const productive = parent.children.some((c) => ["solved", "refuted"].includes(state.tasks[c]!.status));
      closeTask(parent.id, productive ? "solved" : "withdrawn", {}, "server");
    }
  }

  function sweep() {
    const expired = expiredAttempts(state, now());
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

  // ---------------------------------------------------------------- assignments (next + long-poll)
  function tryAssign(agent: AgentId, model: string, approach: string): Assignment | null {
    const pick = pickTask({ state, agent, now: now(), ...(deps.rng ? { rng: deps.rng } : {}) });
    if (!pick) return null;
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
    return {
      attempt, role: pick.role, leaseUntil: until,
      task: { id: t.id, title: t.title, body: t.body, parent: t.parent, points: t.points },
      path, notes, others, ...(handoffId ? { handoff: state.notes[handoffId]! } : {}),
    };
  }

  function scheduleWaiters() {
    if (waitersScheduled || !waiters.size) return;
    waitersScheduled = true;
    queueMicrotask(serveWaiters);
  }
  /** True while some open task has no children: there is still work, even if every slot is busy. */
  function hasOpenLeaf(): boolean {
    for (const t of Object.values(state.tasks)) if (t.status === "open" && t.children.length === 0) return true;
    return false;
  }
  function serveWaiters() {
    waitersScheduled = false;
    if (!hasOpenLeaf()) {
      for (const w of [...waiters.values()]) w.finish("done");
      return;
    }
    for (const w of [...waiters.values()]) {
      const a = state.agents[w.agent];
      if (!a || a.banned) { w.finish(null); continue; }
      if (agentLiveAttempts(state, w.agent, now()).length >= state.rules.maxAttemptsPerAgent) { w.finish(null); continue; }
      const assignment = tryAssign(w.agent, w.model, w.approach);
      // An agent that holds nothing sees every free slot, so a miss means no capacity is left.
      if (!assignment) break;
      w.finish(assignment);
    }
  }

  function next(agent: AgentId, b: NextRequest, signal?: AbortSignal): NextResponse | Promise<NextResponse> {
    const a = agentOrThrow(agent);
    sweep();
    const model = b.model === undefined ? a.model : str(b.model, "model", 80);
    const approach = str(b.approach, "approach", 300, { optional: true });
    const wait = waitSeconds(b.wait);
    const holding = agentLiveAttempts(state, agent, now());
    if (holding.length >= state.rules.maxAttemptsPerAgent) {
      throw new HttpError(409, `already holding ${holding.join(", ")}`, "beat, submit or release it first");
    }
    // Waiters queued earlier are served first.
    const assignment = waiters.size ? null : tryAssign(agent, model, approach);
    if (assignment) return { assignment };
    if (!hasOpenLeaf()) return { assignment: null, done: true };
    if (!wait) return { assignment: null, retryAfterSeconds: 60 };
    if (signal) heldRequests.add(signal);
    return new Promise<NextResponse>((resolve) => {
      waiters.get(agent)?.finish(null); // a newer request from the same agent replaces the older one
      let timer: ReturnType<typeof setTimeout> | undefined;
      const w: Waiter = {
        agent, model, approach,
        finish(x) {
          if (timer) clearTimeout(timer);
          if (waiters.get(agent) === w) waiters.delete(agent);
          resolve(x === "done" ? { assignment: null, done: true } : x ? { assignment: x } : { assignment: null, retryAfterSeconds: 0 });
        },
      };
      waiters.set(agent, w);
      timer = setTimeout(() => w.finish(null), wait * 1000);
      signal?.addEventListener("abort", () => w.finish(null), { once: true });
      scheduleWaiters();
    });
  }

  // ---------------------------------------------------------------- agent verbs
  const joinsByIp = new Map<string, { count: number; windowStart: number }>();
  function join(agent: AgentId, b: JoinRequest, ip: string | undefined): JoinResponse {
    const model = str(b.model, "model", 80);
    const harness = str(b.harness, "harness", 40);
    const owner = b.owner === undefined ? undefined : str(b.owner, "owner", 40);
    const existing = state.agents[agent];
    if (existing?.banned) throw new HttpError(403, "agent is banned");
    if (!existing && joinLimit > 0 && ip) {
      const t = now().getTime();
      const slot = joinsByIp.get(ip);
      const w = slot && t - slot.windowStart < 3_600_000 ? slot : { count: 0, windowStart: t };
      if (w.count >= joinLimit) throw new HttpError(429, "too many new agents from this address", "reuse your .minga/agent.json identity, or try again within the hour");
      w.count += 1;
      joinsByIp.set(ip, w);
    }
    emit({ type: "agent.joined", actor: agent, data: {
      agent, publicKey: b.publicKey, model, harness, ...(owner ? { owner } : {}), rejoin: !!existing,
    } });
    return { agent, rejoin: !!existing, project: projectInfo(), live: agentLiveAttempts(state, agent, now()) };
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

  // ---------------------------------------------------------------- submissions (queue + pool)
  const fileOf = (id: SubmissionId) => pathJoin(submissionsDir, `${id}.json`);

  function submit(agent: AgentId, b: SubmitRequest): SubmitResponse {
    agentOrThrow(agent);
    const attempt = ownLiveAttempt(agent, b.attempt);
    const waiting = pendingFor(attempt);
    if (waiting) throw new HttpError(409, `attempt ${attempt} already has ${waiting} in the queue`, `wait for it: GET /api/submission/${waiting}?wait=30`);
    const at = state.attempts[attempt]!;
    const task = state.tasks[at.task]!;
    if (task.status !== "open") throw new HttpError(409, `task ${task.id} is already ${task.status}`);
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

    const id = nextId(state, "submission");
    writeFileSync(fileOf(id), JSON.stringify(b.files));
    emit({ type: "submission.queued", actor: agent, data: {
      submission: id, attempt, task: task.id, agent, model, claim: b.claim, message, files: paths, bytes,
    } });
    pump();
    return { submission: id, status: "queued", position: queuePosition(id) ?? 1 };
  }

  function queuePosition(id: SubmissionId): number | undefined {
    let n = 0;
    for (const s of state.index.pendingSubmissions) {
      if (state.submissions[s]?.status !== "queued") continue;
      n += 1;
      if (s === id) return n;
    }
    return undefined;
  }

  const inflight = new Set<SubmissionId>();
  const inflightTasks = new Set<TaskId>();
  let pumping = false;
  /** Starts queued submissions while the pool has room: oldest first, at most one per task. */
  function pump() {
    if (pumping) return;
    pumping = true;
    try {
      for (const id of [...state.index.pendingSubmissions]) {
        if (inflight.size >= deps.pool.size) break;
        if (inflight.has(id)) continue;
        const s = state.submissions[id];
        if (!s || inflightTasks.has(s.task)) continue;
        inflight.add(id);
        inflightTasks.add(s.task);
        processSubmission(id)
          .catch((err) => {
            console.error(`submission ${id} failed`, err);
            if (state.submissions[id] && ["queued", "checking"].includes(state.submissions[id]!.status)) {
              finalize(id, { stale: true, outputTail: `internal error while checking: ${(err as Error).message}` });
            }
          })
          .finally(() => { inflight.delete(id); inflightTasks.delete(s.task); pump(); });
      }
    } finally {
      pumping = false;
    }
  }

  async function processSubmission(id: SubmissionId): Promise<void> {
    await Promise.resolve(); // never emit while pump() is iterating
    const s = state.submissions[id]!;
    let files: Record<string, string>;
    try {
      files = JSON.parse(readFileSync(fileOf(id), "utf8"));
    } catch {
      return finalize(id, { stale: true, outputTail: "the submitted files were lost (the server restarted without them); submit again" });
    }
    const agent = state.agents[s.agent]!;
    const task = () => state.tasks[s.task]!;
    const firstRound = s.runs; // s is live state: s.runs grows with every start
    for (let round = firstRound; ; round++) {
      if (task().status !== "open") return finalize(id, { stale: true, outputTail: `task ${s.task} was closed (${task().status}) before this check finished` });
      if (round - firstRound > recheckLimit) return finalize(id, { stale: true, outputTail: "the branch kept moving while this was checked; submit again" });
      const base = await deps.branchHead(repoDir, cfg.branch);
      emit({ type: "submission.started", actor: "server", data: { submission: id, base, round } });
      const result = await deps.pool.run({ base, files, command: cfg.check, timeoutSeconds: cfg.checkTimeoutSeconds });
      if (!result.ok) return finalize(id, { base, result });
      let parent = base;
      for (let hops = 0; ; hops++) {
        if (task().status !== "open") return finalize(id, { base, result, stale: true, outputTail: `task ${s.task} was closed (${task().status}) before this could be committed` });
        const out = await deps.commitAccepted({
          repoDir, branch: cfg.branch, parent, files, message: `${s.task}: ${s.message}`,
          author: `minga agent ${s.agent.slice(0, 8)}`,
          trailers: {
            "Agent-Id": s.agent, "Agent-Model": s.model, "Agent-Harness": agent.harness,
            "Minga-Task": s.task, "Minga-Attempt": s.attempt, "Minga-Claim": s.claim,
          },
        });
        if (out.ok) return finalize(id, { base, result, commit: out.commit });
        // The branch moved. With recheck = "on-overlap", land on the new head when nothing
        // committed since the check's base touched these paths.
        if (cfg.recheck === "on-overlap" && hops < 20) {
          const changed = await deps.changedPaths(repoDir, base, out.head);
          if (!changed.some((p) => Object.hasOwn(files, p))) { parent = out.head; continue; }
        }
        break;
      }
    }
  }

  function finalize(id: SubmissionId, r: { base?: string; result?: CheckResult; commit?: string; stale?: boolean; outputTail?: string }) {
    const s = state.submissions[id]!;
    const task = state.tasks[s.task]!;
    const ok = !!r.commit;
    const points = ok ? (s.claim === "progress" ? Math.max(1, Math.round(task.points / 5)) : task.points) : 0;
    emit({ type: "submission.checked", actor: "server", data: {
      submission: id, attempt: s.attempt, task: s.task, agent: s.agent, model: s.model, claim: s.claim, files: s.files,
      base: r.base ?? "", ...(r.stale ? { stale: true } : {}),
      ok, exitCode: r.result?.exitCode ?? -1, timedOut: r.result?.timedOut ?? false,
      outputTail: r.outputTail ?? r.result?.outputTail ?? "", durationMs: r.result?.durationMs ?? 0,
      points, ...(r.commit ? { commit: r.commit } : {}),
    } });
    rmSync(fileOf(id), { force: true });
    if (ok) {
      endAttempts([s.attempt], "submitted");
      if (s.claim !== "progress" && state.tasks[s.task]!.status === "open") {
        closeTask(s.task, s.claim === "solves" ? "solved" : "refuted", { agent: s.agent, submission: id }, s.agent);
      }
    } else if (state.tasks[s.task]!.status !== "open") {
      endAttempts([s.attempt], "task_closed");
    }
  }

  const isFinal = (s: SubmissionState) => s.status === "accepted" || s.status === "rejected";
  function submissionView(id: SubmissionId): SubmissionView {
    const s = state.submissions[id]!;
    const checked = s.checkedSeq ? store.get(s.checkedSeq) : undefined;
    const outputTail = checked?.type === "submission.checked" ? checked.data.outputTail : undefined;
    const position = s.status === "queued" ? queuePosition(id) : undefined;
    return { ...s, ...(outputTail !== undefined ? { outputTail } : {}), ...(position ? { position } : {}) };
  }

  function settleSubmissionWaiters(id: SubmissionId) {
    const set = submissionWaiters.get(id);
    if (!set) return;
    submissionWaiters.delete(id);
    for (const done of set) done();
  }
  function getSubmission(id: string, wait: number, signal?: AbortSignal): SubmissionView | Promise<SubmissionView> {
    const s = state.submissions[id];
    if (!s) throw new HttpError(404, `no submission ${id}`);
    if (isFinal(s) || !wait) return submissionView(id);
    if (signal) heldRequests.add(signal);
    return new Promise((resolve) => {
      let set = submissionWaiters.get(id);
      if (!set) submissionWaiters.set(id, (set = new Set()));
      const done = () => { clearTimeout(timer); set!.delete(done); resolve(submissionView(id)); };
      const timer = setTimeout(done, wait * 1000);
      set.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  function release(agent: AgentId, b: ReleaseRequest) {
    agentOrThrow(agent);
    const attempt = ownLiveAttempt(agent, b.attempt);
    const waiting = pendingFor(attempt);
    if (waiting) throw new HttpError(409, `attempt ${attempt} has ${waiting} in the queue`, "wait for the verdict first");
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
    endAttempts([...(state.index.openByAgent[target] ?? [])], "banned");
    waiters.get(target)?.finish(null);
    return { ok: true as const };
  }

  function headClose(b: HeadCloseRequest) {
    const task = str(b.task, "task", 32);
    if (state.tasks[task]?.status !== "open") throw new HttpError(409, `task ${task} is not open`);
    if (!["withdrawn", "impossible", "solved"].includes(b.status)) throw new HttpError(400, "status must be withdrawn, impossible or solved");
    closeTask(task, b.status, {}, headId);
    return { ok: true as const };
  }

  // ---------------------------------------------------------------- reads
  // Rebuilt at most once a second (and kept up to 5 s while nothing changes). Gzipped once per
  // rebuild: at ~1,500 agents the JSON is ~1 MB and compresses about 10x.
  let viewCache: { seq: number; at: number; body: string; gz?: Uint8Array<ArrayBuffer> } | null = null;
  function viewEntry() {
    const t = Date.now();
    if (viewCache && t - viewCache.at < 1000) return viewCache;
    if (viewCache && viewCache.seq === state.seq && t - viewCache.at < 5000) return viewCache;
    const body = JSON.stringify(buildView({ state, project: projectInfo(), now: now(), events: store.head() }));
    viewCache = { seq: state.seq, at: t, body };
    return viewCache;
  }
  function viewResponse(req: Request): Response {
    const v = viewEntry();
    const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store", vary: "accept-encoding" };
    if (/\bgzip\b/.test(req.headers.get("accept-encoding") ?? "") && v.body.length > 2048) {
      v.gz ??= Bun.gzipSync(v.body) as Uint8Array<ArrayBuffer>;
      return new Response(v.gz as Uint8Array<ArrayBuffer>, { headers: { ...headers, "content-encoding": "gzip" } });
    }
    return new Response(v.body, { headers });
  }

  function tasksOverview(): TasksResponse {
    const tasks = Object.values(state.tasks).map((t) => ({
      id: t.id, title: t.title, parent: t.parent, status: t.status, points: t.points,
      live: liveAttempts(state, t.id, now()).length, leaf: t.children.length === 0,
    }));
    const open = tasks.filter((t) => t.status === "open" && t.leaf).length;
    return { tasks, open, done: open === 0 };
  }

  function metrics(): MetricsResponse {
    const cpu = process.cpuUsage();
    const mem = process.memoryUsage();
    let queued = 0;
    let checking = 0;
    for (const id of state.index.pendingSubmissions) {
      if (state.submissions[id]?.status === "checking") checking += 1; else queued += 1;
    }
    return {
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      seq: state.seq,
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      cpuSeconds: (cpu.user + cpu.system) / 1e6,
      agents: Object.keys(state.agents).length,
      liveAttempts: state.index.openAttempts.length,
      queue: { queued, checking, concurrency: deps.pool.size },
      streams: listeners.size,
      waiting: waiters.size,
      requests: { ...requests },
      statuses: { ...statuses },
      latencyMs: Object.fromEntries([...latency].map(([route, h]) => [route, h.summary()])),
    };
  }

  function stream(req: Request): Response {
    const lastId = Number(req.headers.get("last-event-id") ?? new URL(req.url).searchParams.get("after") ?? NaN);
    let cleanup = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(enc.encode(`retry: 3000\n\n`));
        if (Number.isFinite(lastId)) {
          for (const e of store.since(lastId, 5000)) ctrl.enqueue(enc.encode(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
        }
        const l = (frame: Uint8Array) => {
          if ((ctrl.desiredSize ?? 0) < -MAX_STREAM_BACKLOG) { cleanup(); try { ctrl.close(); } catch {} return; }
          try { ctrl.enqueue(frame); } catch { cleanup(); }
        };
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
  type Handler = (agent: AgentId, body: any, signal: AbortSignal) => unknown | Promise<unknown>;
  const signed: Record<string, Handler> = {
    "/api/next": next, "/api/beat": beat, "/api/note": note, "/api/submit": submit,
    "/api/release": release, "/api/propose": propose, "/api/vote": vote,
  };
  const head: Record<string, (body: any) => unknown> = {
    "/api/head/post": headPost, "/api/head/decide": headDecide, "/api/head/rule": headRule,
    "/api/head/ban": headBan, "/api/head/close": headClose,
  };

  async function handleApi(req: Request, url: URL, ip: string | undefined): Promise<Response> {
    const path = url.pathname;
    if (req.method === "GET") {
      if (path === "/api/project") return json(projectInfo());
      if (path === "/api/view") return viewResponse(req);
      if (path === "/api/leaderboard") return json(computeLeaderboard(state, 1000));
      if (path === "/api/metrics") return json(metrics());
      if (path === "/api/tasks") return json(tasksOverview());
      if (path === "/api/events") {
        const after = Number(url.searchParams.get("after") ?? 0) || 0;
        const limit = Math.min(5000, Number(url.searchParams.get("limit") ?? 1000) || 1000);
        return json({ events: store.since(after, limit), head: store.head() } satisfies EventsResponse);
      }
      if (path === "/api/stream") return stream(req);
      if (path.startsWith("/api/submission/")) {
        const id = decodeURIComponent(path.slice("/api/submission/".length));
        return json(await getSubmission(id, waitSeconds(url.searchParams.get("wait")), req.signal));
      }
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
      return json(join(agent, body, ip));
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
    const out = await s(agent, body, req.signal);
    return json(out, path === "/api/submit" ? 202 : 200);
  }

  /** `ip` is the client address (Bun: server.requestIP(req)?.address); used for the join limit. */
  async function fetch(req: Request, ip?: string): Promise<Response> {
    const t0 = performance.now();
    const url = new URL(req.url);
    const route = `${req.method} ${url.pathname.startsWith("/api/submission/") ? "/api/submission/:id" : url.pathname}`;
    requests[route] = (requests[route] ?? 0) + 1;
    let res: Response;
    try {
      res = url.pathname.startsWith("/api/") ? await handleApi(req, url, ip) : fail(404, "not found");
    } catch (err) {
      if (err instanceof HttpError) res = fail(err.status, err.message, err.detail);
      else {
        console.error(err);
        res = fail(500, "internal error", (err as Error).message);
      }
    }
    if (!heldRequests.has(req.signal) && !url.pathname.startsWith("/api/stream")) {
      let h = latency.get(route);
      if (!h) latency.set(route, (h = new Latency()));
      h.record(performance.now() - t0);
    }
    const cls = `${Math.floor(res.status / 100)}xx`;
    statuses[cls] = (statuses[cls] ?? 0) + 1;
    return res;
  }

  // Resume work that was queued or mid-check when the server last stopped.
  pump();

  return {
    fetch, sweep, emit, projectInfo, metrics,
    get state() { return state; },
    headId,
    /** Number of open SSE connections. */
    get listeners() { return listeners.size; },
    /** Resolves when no submission is queued or being checked (tests, shutdown). */
    async idle(): Promise<void> {
      while (state.index.pendingSubmissions.length || inflight.size) await new Promise((r) => setTimeout(r, 10));
    },
    /** Closed statuses re-exported for callers. */
    CLOSED_STATUSES,
  };
}

export type App = ReturnType<typeof createApp>;
