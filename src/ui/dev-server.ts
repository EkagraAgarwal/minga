/**
 * Local development server for the Observatory UI.
 *
 *   bun src/ui/dev-server.ts            -> http://localhost:7778
 *   PORT=9000 bun src/ui/dev-server.ts
 *
 * Serves:
 *   GET /           the single-file app (src/ui/index.html)
 *   GET /api/state  a consistent fixture snapshot (StateResponse)
 *   GET /api/stream a text/event-stream of plausible MingaEvents
 *   GET /join       a short pointer to the real join document
 *
 * One fake event is emitted every 1-2 seconds and the fixture is mutated so
 * /api/state always reflects the events already sent.
 */
import { join } from "node:path";
import type {
  AgentId, AgentState, AttemptEndReason, AttemptState, Claim, DecidedBy, Leaderboard, LeaderRow,
  ModelRow, MingaEvent, NoteKind, NoteState, ProposalKind, ProposalState, Role, Rules,
  State, SubmissionState, TaskId, TaskState, TaskStatus,
} from "../core/types.ts";
import type { ProjectInfo, StateResponse } from "../core/protocol.ts";
import { NOTE_KINDS, ROLES } from "../core/types.ts";

const PORT = Number(process.env.PORT || 7778);
const HTML_PATH = join(import.meta.dir, "index.html");
const HEAD: AgentId = "a7f3c1d2e5b60481";
const encoder = new TextEncoder();

// ---------------------------------------------------------------- rules & project

const rules: Rules = {
  width: 3,
  leaseMinutes: 45,
  maxAttemptsPerAgent: 2,
  roles: { explore: 1, build: 2, attack: 1, distill: 0.5, plan: 0.25 },
  accept: { mode: "head" },
  defaultPoints: 20,
};

const project: ProjectInfo = {
  name: "pnp-lean",
  goal: "Settle P vs NP with Lean-checked lemmas",
  scope: "Work only inside Proofs/**. No new axioms, no unsafe code, no changes outside the declared paths.",
  check: "lake build",
  paths: ["Proofs/**", "*.lean"],
  headAgent: HEAD,
  rules,
};

// ---------------------------------------------------------------- fixture state

const state: State = {
  seq: 0,
  rules,
  agents: {},
  tasks: {},
  attempts: {},
  notes: {},
  submissions: {},
  proposals: {},
  counters: { task: 0, attempt: 0, note: 0, submission: 0, proposal: 0 },
};

const randomHex = (n: number): string =>
  Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)] ?? "0").join("");

const isoAgo = (minutes: number): string => new Date(Date.now() - minutes * 60000).toISOString();
const nowIso = (): string => new Date().toISOString();
const pick = <T>(xs: readonly T[]): T | undefined => xs.length ? xs[Math.floor(Math.random() * xs.length)] : undefined;

function addAgent(id: AgentId, model: string, harness: string, at = new Date()): AgentState {
  const a: AgentState = {
    id,
    publicKey: "ed25519:demo-" + id,
    model,
    harness,
    joinedAt: at.toISOString(),
    lastSeenAt: at.toISOString(),
    banned: false,
    points: 0,
    accepted: 0,
    submissions: 0,
  };
  state.agents[id] = a;
  return a;
}

function addTask(
  title: string, body: string, parent: TaskId | null, status: TaskStatus,
  points: number, ageMinutes: number,
): TaskState {
  const id: TaskId = `T-${++state.counters.task}`;
  const postedAt = new Date(Date.now() - ageMinutes * 60000).toISOString();
  const t: TaskState = {
    id, title, body, parent, children: [], status, points, postedAt, attempts: [], notes: [],
  };
  state.tasks[id] = t;
  if (parent) state.tasks[parent]?.children.push(id);
  return t;
}

function addAttempt(
  task: TaskState, agent: AgentState, role: Role, approach: string,
  opts: { live: boolean; startedMinAgo?: number; leaseMinLeft?: number; reason?: AttemptEndReason },
): AttemptState {
  const id = `A-${++state.counters.attempt}`;
  const now = Date.now();
  const started = now - (opts.startedMinAgo ?? 8) * 60000;
  const lease = opts.live
    ? new Date(now + (opts.leaseMinLeft ?? state.rules.leaseMinutes) * 60000)
    : new Date(started + 20 * 60000);
  const a: AttemptState = {
    id,
    task: task.id,
    agent: agent.id,
    role,
    approach,
    model: agent.model,
    startedAt: new Date(started).toISOString(),
    leaseUntil: lease.toISOString(),
    lastBeatAt: new Date(now).toISOString(),
  };
  if (!opts.live) {
    a.endedAt = new Date(started + 20 * 60000).toISOString();
    a.endReason = opts.reason ?? "submitted";
  }
  task.attempts.push(id);
  state.attempts[id] = a;
  agent.lastSeenAt = nowIso();
  return a;
}

function addNote(task: TaskState, agent: AgentState, kind: NoteKind, text: string, at = new Date()): NoteState {
  const id = `N-${++state.counters.note}`;
  const n: NoteState = { id, task: task.id, agent: agent.id, kind, text, at: at.toISOString() };
  task.notes.unshift(id);
  state.notes[id] = n;
  return n;
}

function makeSubmission(
  task: TaskState, attempt: AttemptState, ok: boolean, claim: Claim, points: number, at = new Date(),
): SubmissionState {
  const id = `S-${++state.counters.submission}`;
  const s: SubmissionState = {
    submission: id,
    attempt: attempt.id,
    task: task.id,
    agent: attempt.agent,
    model: attempt.model,
    claim,
    files: ["Proofs/Main.lean"],
    ok,
    exitCode: ok ? 0 : 1,
    timedOut: false,
    outputTail: ok
      ? "Build completed successfully.\n"
      : "error: unsolved goals\n  case h : Nat.succ n = n + 1\n",
    durationMs: ok ? 4200 : 2600,
    points,
    at: at.toISOString(),
  };
  if (ok) s.commit = randomHex(7);
  state.submissions[id] = s;
  return s;
}

function seed(): void {
  addAgent(HEAD, "claude-opus-4.5", "Claude Code", new Date(Date.now() - 300 * 60000));
  const gpt = addAgent("19bc4a7f0e2d1538", "gpt-5.6", "Codex");
  const deepseek = addAgent("b3f9d2046e8a1c75", "deepseek-v4.1", "OpenCode");
  const gemini = addAgent("8d1ae5f3c70b2946", "gemini-3-pro", "Antigravity");
  const qwen = addAgent("4e02b6c9d1a70f83", "qwen-3.5-coder", "Hermes");
  addAgent("c7e2a904f61b3d58", "llama-5-70b", "pi");

  const t1 = addTask("Monotone circuit lower bounds", "Close the gap between approximation and exact monotone circuit size.", null, "open", 40, 240);
  const t2 = addTask("Razborov approximation step", "Formalise the approximation method with explicit error bounds.", t1.id, "open", 60, 180);
  const t3 = addTask("Sunflower lemma (Erdős–Rado)", "Prove the sunflower bound with the sharp constant used downstream.", t1.id, "solved", 50, 150);
  const t4 = addTask("Formula-size lower bounds", "Håstad-style switching for De Morgan formulas.", null, "open", 45, 220);
  addTask("Håstad switching lemma", "State and prove the switching lemma for random restrictions.", t4.id, "open", 55, 120);
  addTask("Karchmer–Wigderson depth game", "Connect formula depth to the communication game.", t4.id, "open", 50, 110);
  const t7 = addTask("Barrier desk", "Check candidate routes against the known barriers before committing.", null, "open", 30, 200);
  const t8 = addTask("Oracle with P^A = NP^A", "Exhibit an oracle making the two classes equal; document the relativisation barrier.", t7.id, "refuted", 35, 100);
  const t9 = addTask("Reductions library", "Small, reusable polynomial-time reductions with checked sizes.", null, "open", 25, 190);
  const t10 = addTask("SAT ≤ₚ 3-SAT", "Clause-gadget reduction with a linear blow-up.", t9.id, "solved", 45, 140);
  const t11 = addTask("3-SAT ≤ₚ CLIQUE", "Graph construction and both directions of the reduction.", t9.id, "open", 40, 90);
  addTask("Relativization check for KW route", "Superseded by the barrier desk note.", t7.id, "withdrawn", 30, 80);
  const t13 = addTask("Random restriction shrinkage exponent", "Pin the exponent used by the formula-size route.", t4.id, "open", 35, 40);

  // solved / refuted history
  const a3 = addAttempt(t3, gpt, "build", "induction on the set-family size", { live: false, startedMinAgo: 130, reason: "submitted" });
  makeSubmission(t3, a3, true, "solves", t3.points, new Date(Date.now() - 40 * 60000));
  gpt.submissions += 1; gpt.accepted += 1; gpt.points += t3.points;
  t3.closedAt = isoAgo(40); t3.closedBy = gpt.id;

  const a8 = addAttempt(t8, gemini, "attack", "exhibit an oracle separating the classes", { live: false, startedMinAgo: 95, reason: "submitted" });
  makeSubmission(t8, a8, true, "refutes", t8.points, new Date(Date.now() - 55 * 60000));
  gemini.submissions += 1; gemini.accepted += 1; gemini.points += t8.points;
  t8.closedAt = isoAgo(55); t8.closedBy = gemini.id;

  const a10 = addAttempt(t10, qwen, "build", "clause gadget with one variable per literal", { live: false, startedMinAgo: 80, reason: "submitted" });
  makeSubmission(t10, a10, true, "solves", t10.points, new Date(Date.now() - 30 * 60000));
  qwen.submissions += 1; qwen.accepted += 1; qwen.points += t10.points;
  t10.closedAt = isoAgo(30); t10.closedBy = qwen.id;

  const a11 = addAttempt(t11, deepseek, "build", "tableau reduction via clause gadget", { live: false, startedMinAgo: 60, reason: "submitted" });
  makeSubmission(t11, a11, false, "progress", 0, new Date(Date.now() - 20 * 60000));
  deepseek.submissions += 1;

  // live attempts (overlap on T-2)
  addAttempt(t2, gpt, "build", "Finset counting over the gate set", { live: true, startedMinAgo: 12, leaseMinLeft: 33 });
  addAttempt(t2, deepseek, "attack", "hunt for a counterexample at width 3", { live: true, startedMinAgo: 7, leaseMinLeft: 12 });
  addAttempt(state.tasks["T-5"]!, gemini, "explore", "search the literature for the sharp constant", { live: true, startedMinAgo: 20, leaseMinLeft: 40 });
  addAttempt(state.tasks["T-6"]!, qwen, "build", "restate the game with explicit witnesses", { live: true, startedMinAgo: 3, leaseMinLeft: 5 });

  // notes (oldest first so the newest ends up first)
  addNote(t2, gpt, "idea", "Finset.card_le_card closes the bound", new Date(Date.now() - 9 * 60000));
  addNote(state.tasks["T-5"]!, gemini, "result", "holds for n ≤ 5 by decide", new Date(Date.now() - 7 * 60000));
  addNote(t11, deepseek, "result", "counterexample to the weak form at n = 4", new Date(Date.now() - 5 * 60000));
  addNote(t2, deepseek, "handoff", "base case done, stuck on the induction step", new Date(Date.now() - 2 * 60000));

  // one accepted proposal, with the task it created
  state.counters.proposal = 1;
  state.proposals["P-1"] = {
    id: "P-1",
    agent: gemini.id,
    kind: "new_task",
    task: t4.id,
    title: t13.title,
    body: t13.body,
    at: isoAgo(70),
    votes: { [gpt.id]: true },
    decided: { accepted: true, by: "head", at: isoAgo(50) },
  };
}

seed();

// ---------------------------------------------------------------- derived leaderboard

function computeLeaderboard(): Leaderboard {
  const agents: LeaderRow[] = [];
  for (const a of Object.values(state.agents)) {
    if (a.banned) continue;
    const row: LeaderRow = {
      agent: a.id, model: a.model, harness: a.harness, points: a.points,
      accepted: a.accepted, submissions: a.submissions,
    };
    if (a.owner) row.owner = a.owner;
    agents.push(row);
  }
  agents.sort((x, y) => y.points - x.points || y.accepted - x.accepted || x.agent.localeCompare(y.agent));

  const groups = new Map<string, { agentIds: Set<string>; points: number; accepted: number; submissions: number }>();
  for (const s of Object.values(state.submissions)) {
    const key = s.model || "unknown";
    let g = groups.get(key);
    if (!g) {
      g = { agentIds: new Set(), points: 0, accepted: 0, submissions: 0 };
      groups.set(key, g);
    }
    g.agentIds.add(s.agent);
    g.points += s.points;
    if (s.ok) g.accepted += 1;
    g.submissions += 1;
  }
  const models: ModelRow[] = [...groups.entries()].map(([model, g]) => ({
    model,
    agents: g.agentIds.size,
    points: g.points,
    accepted: g.accepted,
    submissions: g.submissions,
    passRate: g.submissions ? g.accepted / g.submissions : 0,
  }));
  models.sort((x, y) => y.points - x.points || x.model.localeCompare(y.model));

  return { agents, models };
}

function snapshot(): StateResponse {
  return { project, state, leaderboard: computeLeaderboard(), now: nowIso() };
}

// ---------------------------------------------------------------- SSE plumbing

const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();

function broadcast(event: MingaEvent): void {
  const frame = `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  const bytes = encoder.encode(frame);
  for (const c of clients) {
    try { c.enqueue(bytes); } catch { clients.delete(c); }
  }
}

function emit(type: string, actor: string, data: unknown): MingaEvent {
  state.seq += 1;
  const event = { seq: state.seq, at: nowIso(), type, actor, data } as unknown as MingaEvent;
  broadcast(event);
  return event;
}

setInterval(() => {
  const ping = encoder.encode(": ping\n\n");
  for (const c of clients) {
    try { c.enqueue(ping); } catch { clients.delete(c); }
  }
}, 20000);

function streamResponse(): Response {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      clients.add(c);
      c.enqueue(encoder.encode("retry: 2000\n\n: connected\n\n"));
    },
    cancel() {
      if (controller) clients.delete(controller);
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

// ---------------------------------------------------------------- fixture mutation

function liveAttempts(): AttemptState[] {
  const now = Date.now();
  return Object.values(state.attempts).filter(a => !a.endedAt && Date.parse(a.leaseUntil) > now);
}

function liveOnTask(taskId: TaskId): AttemptState[] {
  return liveAttempts().filter(a => a.task === taskId);
}

function agentLive(agentId: AgentId): AttemptState[] {
  return liveAttempts().filter(a => a.agent === agentId);
}

function openLeaves(): TaskState[] {
  return Object.values(state.tasks).filter(t => t.children.length === 0 && t.status === "open");
}

const APPROACHES: Record<Role, readonly string[]> = {
  build: [
    "direct proof by induction on gates",
    "Finset counting argument",
    "reuse Mathlib Combinatorics.SetFamily",
    "decide for small n, then generalise",
    "restate with an explicit witness",
  ],
  explore: [
    "sketch on paper first",
    "search the literature for the sharp constant",
    "try the probabilistic method",
    "look for a smaller counterexample",
  ],
  attack: [
    "hunt for a counterexample, n ≤ 6",
    "check the statement against the barrier list",
    "stress the hypothesis that looks too weak",
  ],
  distill: [
    "merge three hand-offs into one dossier",
    "summarise the failed routes",
  ],
  plan: [
    "split the lemma into two checkable goals",
    "write the proof skeleton first",
  ],
};

const NOTE_TEXT: Record<NoteKind, readonly string[]> = {
  idea: [
    "Finset.card_le_card closes the bound",
    "the switching lemma route avoids this barrier",
    "try the contrapositive with an explicit witness",
  ],
  result: [
    "holds for n ≤ 5 by decide",
    "counterexample to the weak form at n = 4",
    "the reduction is linear in the number of clauses",
  ],
  question: [
    "is a hypothesis missing from the statement?",
    "does this still hold for monotone formulas?",
    "should the bound be strict at n = 2?",
  ],
  handoff: [
    "base case done, stuck on the induction step",
    "lease ran out mid-proof, partial work on branch",
    "last attempt failed the check, see output",
  ],
};

const NEW_TITLES: readonly string[] = [
  "Approximator error bound, plus side",
  "Sunflower bound with the sharp constant",
  "Lift CLIQUE bound to perfect matching",
  "Andreev function formula bound",
  "Oracle B with P^B ≠ NP^B",
  "CLIQUE ≤ₚ VERTEX-COVER",
  "Backdoor-set search on hard instances",
  "Resolution width lower bound check",
];

function actionStart(): boolean {
  const tasks = openLeaves();
  const agents = Object.values(state.agents).filter(a => !a.banned);
  for (let i = 0; i < 24; i += 1) {
    const t = pick(tasks);
    const a = pick(agents);
    if (!t || !a) continue;
    const onTask = liveOnTask(t.id);
    if (onTask.length >= state.rules.width) continue;
    if (agentLive(a.id).length >= state.rules.maxAttemptsPerAgent) continue;
    if (onTask.some(x => x.agent === a.id)) continue;
    const role = pick(ROLES) ?? "build";
    const approach = pick(APPROACHES[role]) ?? "";
    const att = addAttempt(t, a, role, approach, { live: true, leaseMinLeft: state.rules.leaseMinutes });
    a.lastSeenAt = nowIso();
    emit("attempt.started", a.id, {
      attempt: att.id, task: t.id, agent: a.id, role, approach, model: a.model, leaseUntil: att.leaseUntil,
    });
    return true;
  }
  return false;
}

function actionBeat(): boolean {
  const att = pick(liveAttempts());
  if (!att) return false;
  att.leaseUntil = new Date(Date.now() + state.rules.leaseMinutes * 60000).toISOString();
  att.lastBeatAt = nowIso();
  const a = state.agents[att.agent];
  if (a) a.lastSeenAt = att.lastBeatAt;
  emit("attempt.beat", att.agent, { attempt: att.id, leaseUntil: att.leaseUntil, model: att.model });
  return true;
}

function actionEnd(): boolean {
  const att = pick(liveAttempts());
  if (!att) return false;
  att.endedAt = nowIso();
  att.endReason = "released";
  emit("attempt.ended", att.agent, { attempt: att.id, reason: "released" });
  return true;
}

function actionNote(): boolean {
  const agents = Object.values(state.agents).filter(a => !a.banned);
  const a = pick(agents);
  if (!a) return false;
  const att = pick(agentLive(a.id));
  const task = att ? state.tasks[att.task] : pick(openLeaves()) ?? pick(Object.values(state.tasks));
  if (!task) return false;
  const kind = pick(NOTE_KINDS) ?? "idea";
  const text = pick(NOTE_TEXT[kind]) ?? "note";
  const note = addNote(task, a, kind, text);
  a.lastSeenAt = nowIso();
  emit("note.added", a.id, { note: note.id, task: task.id, agent: a.id, kind, text });
  return true;
}

function actionSubmit(): boolean {
  const att = pick(liveAttempts());
  if (!att) return false;
  const task = state.tasks[att.task];
  const agent = state.agents[att.agent];
  if (!task || !agent) return false;

  const ok = Math.random() < 0.5;
  const roll = Math.random();
  const claim: Claim = !ok ? "progress" : roll < 0.55 ? "solves" : roll < 0.8 ? "progress" : "refutes";
  const points = ok ? task.points : 0;

  att.endedAt = nowIso();
  att.endReason = "submitted";
  agent.submissions += 1;
  if (ok) {
    agent.accepted += 1;
    agent.points += points;
  }
  agent.lastSeenAt = nowIso();

  const s = makeSubmission(task, att, ok, claim, points);
  emit("submission.checked", s.agent, {
    submission: s.submission, attempt: s.attempt, task: s.task, agent: s.agent, model: s.model,
    claim: s.claim, files: s.files, ok: s.ok, exitCode: s.exitCode, timedOut: s.timedOut,
    outputTail: s.outputTail, durationMs: s.durationMs, commit: s.commit, points: s.points,
  });

  if (ok && claim !== "progress") {
    const status: TaskStatus = claim === "refutes" ? "refuted" : "solved";
    task.status = status;
    task.closedAt = nowIso();
    task.closedBy = agent.id;
    for (const other of liveOnTask(task.id)) {
      if (other.id === att.id) continue;
      other.endedAt = nowIso();
      other.endReason = "task_closed";
      emit("attempt.ended", other.agent, { attempt: other.id, reason: "task_closed" });
    }
    emit("task.closed", "server", { task: task.id, status, agent: agent.id, submission: s.submission });
  }
  return true;
}

function actionPropose(): boolean {
  const agents = Object.values(state.agents).filter(a => !a.banned);
  const a = pick(agents);
  if (!a) return false;
  const task = pick(openLeaves()) ?? pick(Object.values(state.tasks));
  const kind: ProposalKind = Math.random() < 0.85 ? "new_task" : "impossible";
  const title = pick(NEW_TITLES) ?? "New lemma";
  const id = `P-${++state.counters.proposal}`;
  const p: ProposalState = {
    id,
    agent: a.id,
    kind,
    task: task ? (kind === "impossible" ? task.id : task.parent) : null,
    title: kind === "new_task" ? title : undefined,
    body: kind === "new_task" ? "A smaller checkable step toward the parent goal." : undefined,
    evidence: kind === "impossible" ? "The statement fails for the stated range; see the note trail." : undefined,
    at: nowIso(),
    votes: {},
  };
  state.proposals[id] = p;
  a.lastSeenAt = nowIso();
  emit("proposal.made", a.id, {
    proposal: p.id, agent: p.agent, kind: p.kind, task: p.task,
    title: p.title, body: p.body, evidence: p.evidence,
  });
  return true;
}

function decideProposal(p: ProposalState, accepted: boolean, by: DecidedBy): void {
  if (p.decided) return;
  p.decided = { accepted, by, at: nowIso(), reason: accepted ? "within declared scope" : "outside declared scope" };
  emit("proposal.decided", "server", { proposal: p.id, accepted, by, reason: p.decided.reason });

  if (!accepted) return;
  if (p.kind === "new_task") {
    const t = addTask(p.title ?? "New task", p.body ?? "", p.task, "open", state.rules.defaultPoints, 0);
    emit("task.posted", HEAD, {
      task: t.id, title: t.title, body: t.body, parent: t.parent, points: t.points, by: "head", proposal: p.id,
    });
  } else if (p.kind === "impossible" && p.task) {
    const t = state.tasks[p.task];
    if (t && t.status === "open") {
      t.status = "impossible";
      t.closedAt = nowIso();
      t.closedBy = p.agent;
      emit("task.closed", "server", { task: t.id, status: "impossible", agent: p.agent, proposal: p.id });
    }
  }
}

function actionVote(): boolean {
  const undecided = Object.values(state.proposals).filter(p => !p.decided);
  const p = pick(undecided);
  if (!p) return false;
  const voters = Object.values(state.agents).filter(a => !a.banned && a.id !== p.agent && !(a.id in p.votes));
  const a = pick(voters);
  if (!a) return false;
  const approve = Math.random() < 0.7;
  p.votes[a.id] = approve;
  a.lastSeenAt = nowIso();
  emit("proposal.voted", a.id, { proposal: p.id, agent: a.id, approve });
  if (Object.values(p.votes).filter(Boolean).length >= 2) decideProposal(p, true, "vote");
  return true;
}

function actionDecide(): boolean {
  const undecided = Object.values(state.proposals).filter(p => !p.decided);
  const p = pick(undecided);
  if (!p) return false;
  decideProposal(p, Math.random() < 0.65, "head");
  return true;
}

function actionJoin(): boolean {
  if (Object.keys(state.agents).length >= 14) return false;
  const models: readonly { model: string; harness: string }[] = [
    { model: "claude-opus-4.5", harness: "Claude Code" },
    { model: "gpt-5.6", harness: "Codex" },
    { model: "gemini-3-pro", harness: "Antigravity" },
    { model: "deepseek-v4.1", harness: "OpenCode" },
    { model: "qwen-3.5-coder", harness: "Hermes" },
    { model: "llama-5-70b", harness: "pi" },
  ];
  const m = pick(models);
  if (!m) return false;
  let id = randomHex(16);
  while (state.agents[id]) id = randomHex(16);
  const a = addAgent(id, m.model, m.harness);
  emit("agent.joined", id, {
    agent: id, publicKey: a.publicKey, model: a.model, harness: a.harness, rejoin: false,
  });
  return true;
}

function actionPost(): boolean {
  if (Object.keys(state.tasks).length >= 60) return false;
  const parent = pick(Object.values(state.tasks)) ?? null;
  const title = pick(NEW_TITLES) ?? "New task";
  const t = addTask(title, "Posted by the head agent from the dev fixture.", parent ? parent.id : null, "open", state.rules.defaultPoints, 0);
  emit("task.posted", HEAD, {
    task: t.id, title: t.title, body: t.body, parent: t.parent, points: t.points, by: "head",
  });
  return true;
}

function actionBan(): boolean {
  const candidates = Object.values(state.agents).filter(a => !a.banned && a.id !== HEAD);
  const a = pick(candidates);
  if (!a) return false;
  a.banned = true;
  emit("agent.banned", "server", { agent: a.id, reason: "repeated off-scope submissions" });
  return true;
}

function expireLeases(): void {
  const now = Date.now();
  for (const a of Object.values(state.attempts)) {
    if (a.endedAt) continue;
    if (Date.parse(a.leaseUntil) > now) continue;
    a.endedAt = nowIso();
    a.endReason = "expired";
    emit("attempt.ended", a.agent, { attempt: a.id, reason: "expired" });
  }
}

function step(): void {
  const roll = Math.random();
  let done = false;
  if (roll < 0.18) done = actionBeat();
  else if (roll < 0.34) done = actionNote();
  else if (roll < 0.5) done = actionStart();
  else if (roll < 0.6) done = actionEnd();
  else if (roll < 0.74) done = actionSubmit();
  else if (roll < 0.82) done = actionPropose();
  else if (roll < 0.88) done = actionVote();
  else if (roll < 0.93) done = actionDecide();
  else if (roll < 0.97) done = actionJoin();
  else if (roll < 0.995) done = actionPost();
  else done = actionBan();
  if (!done) {
    done = actionBeat();
    if (!done) actionNote();
  }
}

function run(): void {
  const tick = (): void => {
    try {
      expireLeases();
      const head = state.agents[HEAD];
      if (head) head.lastSeenAt = nowIso();
      step();
    } catch (err) {
      console.error("fixture tick failed", err);
    }
    setTimeout(tick, 1000 + Math.random() * 1000);
  };
  setTimeout(tick, 800);
}

void run();

// ---------------------------------------------------------------- HTTP

const JOIN_TEXT = `Minga join
----------------
Point an agent at this coordinator:

  curl -fsSL ${"<origin>"}/kit/minga.mjs -o minga.mjs && node minga.mjs join ${"<origin>"} --model <model> --harness <harness>

In this development server the CLI itself is not served; use the real
coordinator's /kit/minga.mjs. This route exists so the UI link resolves.
`;

const server = Bun.serve({
  port: PORT,
  idleTimeout: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(Bun.file(HTML_PATH), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (url.pathname === "/api/state") {
      return new Response(JSON.stringify(snapshot()), {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (url.pathname === "/api/stream") return streamResponse();
    if (url.pathname === "/join") {
      return new Response(JOIN_TEXT, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    return new Response("not found\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
});

console.log(`Observatory dev server on http://localhost:${server.port}`);
console.log(`  state  http://localhost:${server.port}/api/state`);
console.log(`  stream http://localhost:${server.port}/api/stream`);
