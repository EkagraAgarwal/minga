/**
 * Development server for the lab-notebook UI.
 *
 *   bun src/ui/dev-server.ts --agents 400 --tasks 240 --rate 15 --port 7778
 *   bun src/ui/dev-server.ts --port 7790 --finished
 *
 * Serves:
 *   GET /             src/ui/index.html
 *   GET /api/view     ViewResponse (v2 snapshot, with coordination and leads)
 *   GET /api/events?after=<seq>&limit=<n>  ascending event history
 *   GET /api/stream   text/event-stream of real MingaEvent shapes, seq ascending
 *   GET /join         plain text join document
 *
 * The fixture is mutated by the same events that are broadcast, so a fresh
 * /api/view always describes the events already sent. The stream honours both
 * ?after=<seq> and Last-Event-ID, and keeps a bounded replay buffer.
 */
import { join } from "node:path";
import type {
  Actor, AgentId, AgentState, AttemptEndReason, AttemptId, AttemptState, Claim, CoordinationStats, DecidedBy,
  EventType, Leaderboard, LeaderRow, MingaEvent, ModelRow, NoteId, NoteKind, NoteState,
  ProposalId, ProposalKind, ProposalState, Role, Rules, SubmissionId, SubmissionState,
  TaskId, TaskState, TaskStatus,
} from "../core/types.ts";
import type { ProjectInfo, ViewResponse, ViewTask } from "../core/protocol.ts";
import { NOTE_KINDS, ROLES } from "../core/types.ts";

// ---------------------------------------------------------------- flags

interface Flags { agents: number; tasks: number; rate: number; port: number; finished: boolean }

function parseFlags(argv: string[]): Flags {
  const out: Flags = {
    agents: 400,
    tasks: 240,
    rate: 15,
    port: Number(process.env.PORT || 7778),
    finished: false,
  };
  const names: Record<string, "agents" | "tasks" | "rate" | "port"> = {
    agents: "agents", tasks: "tasks", rate: "rate", port: "port",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i] ?? "";
    if (raw === "--finished") { out.finished = true; continue; }
    const eq = raw.indexOf("=");
    const key = (eq >= 0 ? raw.slice(0, eq) : raw).replace(/^--/, "");
    const name = names[key];
    if (!name) continue;
    const value = eq >= 0 ? raw.slice(eq + 1) : argv[i + 1];
    if (value === undefined) continue;
    if (eq < 0) i += 1;
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) out[name] = Math.floor(n);
  }
  return out;
}

const FLAGS = parseFlags(process.argv.slice(2));
const HTML_PATH = join(import.meta.dir, "index.html");
const HEAD: AgentId = "a7f3c1d2e5b60481";
const encoder = new TextEncoder();
const MAX_REPLAY = 10000;
const MAX_PENDING = 400;

// ---------------------------------------------------------------- fixture data

const rules: Rules = {
  width: 6,
  leaseMinutes: 45,
  maxAttemptsPerAgent: 6,
  roles: { explore: 1, build: 2, attack: 1, distill: 0.5, plan: 0.25 },
  accept: { mode: "head-or-votes", votes: 2 },
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

interface Counters { task: number; attempt: number; note: number; submission: number; proposal: number }

const db = {
  seq: 0,
  counters: { task: 0, attempt: 0, note: 0, submission: 0, proposal: 0 } as Counters,
  agents: {} as Record<AgentId, AgentState>,
  tasks: {} as Record<TaskId, TaskState>,
  attempts: {} as Record<AttemptId, AttemptState>,
  notes: {} as Record<NoteId, NoteState>,
  submissions: {} as Record<SubmissionId, SubmissionState>,
  proposals: {} as Record<ProposalId, ProposalState>,
  leads: {} as Record<TaskId, AgentId[]>,
};

const liveIds: AttemptId[] = [];
const liveIdsSet = new Set<AttemptId>();
const noteOrder: NoteId[] = [];
const submissionOrder: SubmissionId[] = [];
const pendingIds: SubmissionId[] = [];
const proposalIds: ProposalId[] = [];
const events: MingaEvent[] = [];
interface Pending { id: SubmissionId; startAt: number; checkAt: number }
const pipeline: Pending[] = [];
let eventCounter = 0;
let duplicateProposals = 0;
const notifyLags: number[] = [];

// Deterministic fixture: a hostile string in a dev run is always the fixture's fault, not chance.
let rngState = 0x9e3779b9;
const rnd = (): number => {
  rngState = (rngState + 0x6d2b79f5) | 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = <T>(xs: readonly T[]): T | undefined => xs.length ? xs[Math.floor(rnd() * xs.length)] : undefined;
const hex = (n: number): string => {
  let s = "";
  for (let i = 0; i < n; i += 1) s += "0123456789abcdef"[int(0, 15)];
  return s;
};
const isoAgo = (minutes: number): string => new Date(Date.now() - minutes * 60000).toISOString();
const nowIso = (): string => new Date().toISOString();
const clamp = (x: number, lo: number, hi: number): number => x < lo ? lo : x > hi ? hi : x;

const MODELS = [
  "claude-opus-5.5", "gpt-6", "deepseek-v4.1-flash", "hy4-flash",
  "kimi-k3", "glm-5.3", "gemini-4",
] as const;
const HARNESSES = ["claude-code", "codex", "opencode", "hermes", "pi"] as const;
const OWNERS = [
  "mrcat", "lambda-factory", "hans-m", "t-void", "nprof", "orbitals", "sable-ko",
  "yzhou", "bitbucket", "proofsmith", "cold-sun", "rngbot",
] as const;

const APPROACHES: Record<Role, readonly string[]> = {
  build: [
    "induction on gate count", "Finset counting over the gate set", "reuse Mathlib.SetFamily",
    "decide for small n, then generalise", "restate with an explicit witness",
  ],
  explore: [
    "sketch on paper first", "search the literature for the sharp constant",
    "try the probabilistic method", "look for a smaller counterexample",
  ],
  attack: [
    "hunt for a counterexample, n <= 6", "check the claim against the barrier list",
    "stress the hypothesis that looks too weak",
  ],
  distill: ["merge three hand-offs into one dossier", "summarise the failed routes"],
  plan: ["split the lemma into two checkable goals", "write the skeleton first"],
};

const NOTE_TEXT: Record<NoteKind, readonly string[]> = {
  idea: ["Finset.card_le_card closes the bound", "the switching route avoids this barrier", "try the contrapositive"],
  result: ["holds for n <= 5 by decide", "counterexample at n = 4", "the reduction is linear"],
  question: ["is a hypothesis missing?", "does this hold for monotone formulas?", "should the bound be strict?"],
  handoff: ["base case done, stuck on induction", "lease ran out mid-proof", "last attempt failed the check"],
  dead_end: ["induction on n stalls at the carry case", "the greedy bound is too weak past n = 6"],
  digest: ["Area summary: switching route open, natural-proofs route blocked by T-12"],
};

const MESSAGES = [
  "close the induction step", "add explicit witnesses", "trim the auxiliary lemma",
  "checked small cases", "rewrite with decidable equality",
];

// Each area owns a distinct pool of sub-areas, so no two branches share a label.
const AREAS = [
  { name: "Circuit lower bounds", subs: ["Switching lemmas", "Monotone circuits", "Depth hierarchy", "Gate elimination"] },
  { name: "Proof complexity", subs: ["Resolution width", "Cutting planes", "Nullstellensatz", "Proof size separations"] },
  { name: "Barriers", subs: ["Relativization", "Natural proofs", "Algebrization", "Entropy obstructions"] },
  { name: "Algebraic methods", subs: ["Polynomial method", "Approximating polynomials", "Rank arguments", "Combinatorial Nullstellensatz"] },
  { name: "Communication complexity", subs: ["Discrepancy bounds", "Information complexity", "Protocol compression", "Lower bound templates"] },
  { name: "Derandomization", subs: ["Pseudorandom generators", "Hardness versus randomness", "Extractor constructions", "Hitting sets"] },
] as const;

// Templates take a parameter, so every generated leaf title is unique without a "(variant N)" suffix.
const LEAF_TEMPLATES: ReadonlyArray<(n: number) => string> = [
  n => `Formalize Håstad's switching lemma for depth-${3 + ((n - 1) % 3)} width ${n + 2}`,
  n => `Bound Razborov approximators for CLIQUE_${n + 2}`,
  n => `Prove the sunflower lemma for ${n + 3}-uniform families`,
  n => `Separate monotone circuits for CLIQUE_${n + 2}`,
  n => `Establish a resolution width lower bound of ${n + 4}`,
  n => `Derive shrinkage exponent ${(n % 5) + 1} for depth-3 formulas`,
  n => `Reduce SAT to 3-SAT on ${n + 6} variables`,
  n => `Construct oracle B separating P^B from NP^B at length ${n + 4}`,
  n => `Verify natural-proofs barrier instance ${n + 1} in Lean`,
  n => `Bound Andreev's function on ${n + 7} inputs`,
  n => `Prove backdoor set detection for width ${n + 2}`,
  n => `Refine the Karchmer–Wigderson game for depth ${n + 3}`,
];
const leafTitle = (index: number): string => {
  const t = LEAF_TEMPLATES[index % LEAF_TEMPLATES.length]!;
  return t(Math.floor(index / LEAF_TEMPLATES.length) + 1);
};

// ---------------------------------------------------------------- seeding

function addAgent(model: string, harness: string, owner?: string, atMs = Date.now()): AgentState {
  const id = hex(16);
  const a: AgentState = {
    id,
    publicKey: "ed25519:fixture-" + id,
    model,
    harness,
    joinedAt: new Date(atMs).toISOString(),
    lastSeenAt: new Date(atMs).toISOString(),
    banned: false,
    points: 0,
    accepted: 0,
    submissions: 0,
  };
  if (owner) a.owner = owner;
  db.agents[id] = a;
  return a;
}

function addTask(
  title: string, body: string, parent: TaskId | null, status: TaskStatus,
  points: number, ageMinutes: number,
): TaskState {
  const id: TaskId = "T-" + (++db.counters.task);
  const t: TaskState = {
    id, title, body, parent, children: [], status, points,
    postedAt: new Date(Date.now() - ageMinutes * 60000).toISOString(),
    paths: ["Proofs/Main.lean", "Proofs/Lemmas/" + id + ".lean"],
    attempts: [], notes: [],
  };
  db.tasks[id] = t;
  if (parent && db.tasks[parent]) db.tasks[parent]!.children.push(id);
  return t;
}

function addAttempt(
  task: TaskState, agent: AgentState, role: Role, approach: string, leaseMinutes: number,
): AttemptState {
  const id: AttemptId = "A-" + (++db.counters.attempt);
  const started = Date.now() - int(1, 18) * 60000;
  const a: AttemptState = {
    id,
    task: task.id,
    agent: agent.id,
    role,
    approach,
    model: agent.model,
    startedAt: new Date(started).toISOString(),
    leaseUntil: new Date(Date.now() + leaseMinutes * 60000).toISOString(),
    lastBeatAt: new Date(started + 60000).toISOString(),
  };
  db.attempts[id] = a;
  task.attempts.push(id);
  liveIds.push(id);
  liveIdsSet.add(id);
  return a;
}

function addNote(task: TaskState, agent: AgentState, kind: NoteKind, text: string, atMs: number): NoteState {
  const id: NoteId = "N-" + (++db.counters.note);
  const n: NoteState = { id, task: task.id, agent: agent.id, kind, text, at: new Date(atMs).toISOString() };
  db.notes[id] = n;
  task.notes.unshift(id);
  noteOrder.unshift(id);
  return n;
}

let lastSubmissionAt = Date.now() - 600000;
function addSubmission(
  task: TaskState, attempt: AttemptState, agent: AgentState, status: SubmissionState["status"],
  ok: boolean,
): SubmissionState {
  const id: SubmissionId = "S-" + (++db.counters.submission);
  lastSubmissionAt += int(500, 4000);
  const claim: Claim = ok ? (rnd() < 0.8 ? "solves" : "refutes") : "progress";
  const s: SubmissionState = {
    id,
    attempt: attempt.id,
    task: task.id,
    agent: agent.id,
    model: attempt.model,
    claim,
    message: pick(MESSAGES) ?? "check the lemma",
    files: ["Proofs/Main.lean"],
    bytes: int(200, 8000),
    status,
    queuedAt: new Date(lastSubmissionAt).toISOString(),
    runs: status === "queued" ? 0 : 1,
    points: ok ? task.points : 0,
  };
  if (status !== "queued") {
    s.checkedAt = new Date(lastSubmissionAt + 3000).toISOString();
    s.ok = ok;
    s.exitCode = ok ? 0 : 1;
    s.timedOut = false;
    s.durationMs = int(1200, 9000);
    if (ok) s.commit = hex(7);
  }
  if (status === "checking") s.startedAt = new Date(lastSubmissionAt + 1000).toISOString();
  db.submissions[id] = s;
  submissionOrder.unshift(id);
  if (status === "queued" || status === "checking") pendingIds.push(id);
  if (ok) { agent.accepted += 1; agent.points += task.points; }
  agent.submissions += 1;
  return s;
}

function closeWithSubmission(
  task: TaskState, agent: AgentState, status: Exclude<TaskStatus, "open">,
): SubmissionState {
  // A closed task has a history: earlier rejections before the accepted solve.
  // Keep them in db.submissions so /api/view can expose them per task.
  const rejected = int(1, 2);
  for (let i = rejected; i >= 1; i -= 1) {
    const rid: SubmissionId = "S-" + (++db.counters.submission);
    const r: SubmissionState = {
      id: rid, attempt: task.attempts[0] ?? "A-0", task: task.id, agent: agent.id, model: agent.model,
      claim: "solves", message: "first attempt did not check", files: ["Proofs/Main.lean"],
      bytes: int(200, 2500), status: "rejected", queuedAt: isoAgo(72 + i), runs: 1,
      checkedAt: isoAgo(71 + i), ok: false, exitCode: 1, timedOut: false,
      durationMs: int(900, 5000), points: 0,
    };
    db.submissions[rid] = r;
    submissionOrder.unshift(rid);
    agent.submissions += 1;
  }
  const id: SubmissionId = "S-" + (++db.counters.submission);
  const s: SubmissionState = {
    id, attempt: task.attempts[0] ?? "A-0", task: task.id, agent: agent.id, model: agent.model,
    claim: status === "refuted" ? "refutes" : "solves",
    message: pick(MESSAGES) ?? "checked the lemma", files: ["Proofs/Main.lean"],
    bytes: int(200, 4000), status: "accepted", queuedAt: isoAgo(70), runs: 1,
    points: status === "solved" ? task.points : 0, checkedAt: isoAgo(69),
    ok: status === "solved" || status === "refuted", exitCode: 0, timedOut: false,
    durationMs: int(900, 5000), commit: hex(7),
  };
  db.submissions[id] = s;
  submissionOrder.unshift(id);
  task.status = status;
  task.closedAt = isoAgo(int(5, 60));
  task.closedBy = agent.id;
  task.closedSubmission = id;
  agent.submissions += 1;
  if (s.ok) { agent.accepted += 1; agent.points += s.points; }
  return s;
}

function seed(): void {
  const head = addAgent("claude-opus-5.5", "claude-code", "head-keeper", Date.now() - 300 * 60000);
  db.agents[HEAD] = head;
  delete db.agents[head.id];
  head.id = HEAD;
  head.publicKey = "ed25519:fixture-head";

  const agents: AgentState[] = [];
  for (let i = 1; i < FLAGS.agents; i += 1) {
    const model = MODELS[i % MODELS.length] ?? "hy4-flash";
    const harness = HARNESSES[(i + 1) % HARNESSES.length] ?? "opencode";
    const owner = i % 4 === 0 ? undefined : OWNERS[i % OWNERS.length];
    const a = addAgent(model, harness, owner, Date.now() - int(0, 600) * 60000);
    // All seeded agents stay inside the 15-minute active window; joins are capped below.
    a.lastSeenAt = new Date(Date.now() - int(0, 14) * 60000).toISOString();
    const subs = int(0, 14);
    a.submissions = subs;
    a.accepted = Math.floor(subs * (0.2 + rnd() * 0.65));
    a.points = a.accepted * int(10, 60);
    agents.push(a);
  }

  const total = Math.max(4, FLAGS.tasks);
  // Three to six named top-level areas, each with one shallow layer of named sub-areas.
  const areaCount = Math.max(3, Math.min(6, Math.round(Math.sqrt(total) / 4)));
  const subPerArea = Math.max(2, Math.min(4, Math.round(total / (areaCount * 40))));
  const subCount = Math.min(areaCount * subPerArea, Math.max(0, total - areaCount - 1));
  const areas: TaskState[] = [];
  for (let i = 0; i < areaCount; i += 1) {
    const a = addTask(AREAS[i]?.name ?? "Area " + (i + 1), "Branch point. Leaves below carry the work.", null, "open", 0, int(120, 400));
    areas.push(a);
  }
  const subs: TaskState[] = [];
  for (let i = 0; i < subCount; i += 1) {
    const slot = i % areas.length;
    const area = areas[slot]!;
    const name = AREAS[slot]?.subs[Math.floor(i / areas.length)] ?? "Subarea";
    subs.push(addTask(name, "Grouping of related leaves.", area.id, "open", 0, int(90, 320)));
  }
  const leaves = total - areaCount - subCount;
  for (let i = 0; i < leaves; i += 1) {
    const parent = subs.length ? subs[i % subs.length]! : areas[i % areas.length]!;
    const title = leafTitle(i);
    const roll = rnd();
    const status: TaskStatus = roll < 0.06 ? "solved" : roll < 0.1 ? "refuted" : roll < 0.13 ? "impossible" : roll < 0.16 ? "withdrawn" : "open";
    const t = addTask(title, "Prove or refute the statement with machine-checked steps in Proofs/**.", parent.id, status, int(10, 80), int(10, 300));
    if (status !== "open") t.closedAt = isoAgo(int(5, 90));
  }

  const leafTasks = Object.values(db.tasks).filter(t => t.children.length === 0);
  const openLeaves = leafTasks.filter(t => t.status === "open");
  const target = Math.min(1500, openLeaves.length * rules.width, agents.length * rules.maxAttemptsPerAgent);
  const perAgent = new Map<AgentId, number>();
  for (let i = 0; i < target; i += 1) {
    const task = pick(openLeaves);
    if (!task) break;
    let agent: AgentState | undefined;
    for (let tries = 0; tries < 4 && !agent; tries += 1) {
      const candidate = pick(agents);
      if (!candidate) break;
      const used = perAgent.get(candidate.id) ?? 0;
      if (used < rules.maxAttemptsPerAgent) {
        perAgent.set(candidate.id, used + 1);
        agent = candidate;
      }
    }
    if (!agent) agent = agents[i % agents.length];
    if (!agent) break;
    const role = pick(ROLES) ?? "build";
    addAttempt(task, agent, role, pick(APPROACHES[role]) ?? "", int(5, 45));
  }

  // Closed tasks carry the agent, model-bearing agent record and closing submission.
  for (const t of Object.values(db.tasks)) {
    if (t.status === "open") continue;
    closeWithSubmission(t, pick(agents) ?? head, t.status);
  }

  for (let i = 0; i < Math.min(100, leafTasks.length); i += 1) {
    const t = leafTasks[i];
    const a = agents[i % agents.length];
    if (!t || !a) break;
    addNote(t, a, pick(NOTE_KINDS) ?? "idea", pick(NOTE_TEXT.idea) ?? "", Date.now() - i * 60000);
  }

  // A pinned digest, a threaded question and a dead end on one sub-area, so the
  // margin note has every annotation on first load.
  const annotated = subs[0] ?? leafTasks[0];
  if (annotated) {
    addNote(annotated, agents[0] ?? head, "digest", NOTE_TEXT.digest[0] ?? "", Date.now() - 2 * 60000);
    const question = addNote(annotated, agents[1] ?? head, "question", NOTE_TEXT.question[0] ?? "", Date.now() - 12 * 60000);
    const answer = addNote(annotated, agents[2] ?? head, "result", "yes, the bound holds", Date.now() - 6 * 60000);
    answer.replyTo = question.id;
    question.replies = 1;
    addNote(annotated, agents[3] ?? head, "dead_end", NOTE_TEXT.dead_end[0] ?? "", Date.now() - 3 * 60000);
  }
  if (areas[0] && agents[0]) db.leads[areas[0].id] = [agents[0].id];
  for (let i = 0; i < 24; i += 1) notifyLags.push(0.4 + rnd() * 5);

  for (let i = 0; i < 8; i += 1) {
    const t = leafTasks[i];
    const a = agents[i];
    if (!t || !a) break;
    const id: SubmissionId = "S-" + (++db.counters.submission);
    const att = db.attempts[t.attempts[0] ?? ""];
    if (!att) break;
    const s: SubmissionState = {
      id, attempt: att.id, task: t.id, agent: a.id, model: a.model, claim: "solves",
      message: "queued at boot", files: ["Proofs/Main.lean"], bytes: 1024, status: "queued",
      queuedAt: new Date(Date.now() - i * 20000).toISOString(), runs: 0, points: 0,
    };
    db.submissions[id] = s;
    submissionOrder.unshift(id);
    pendingIds.push(id);
    pipeline.push({ id, startAt: Date.now() + int(500, 2500), checkAt: Date.now() + int(3500, 9000) });
  }

  if (FLAGS.finished) {
    // Everyone has stopped: stale heartbeats make the honest active count 0.
    const longAgo = new Date(Date.now() - 60 * 60000).toISOString();
    for (const a of Object.values(db.agents)) a.lastSeenAt = longAgo;
    // Every task closed: no live attempts, no queue, every leaf solved.
    for (const t of Object.values(db.tasks)) {
      if (t.status === "open") closeWithSubmission(t, pick(agents) ?? head, "solved");
    }
    liveIds.length = 0;
    liveIdsSet.clear();
    for (const id of pendingIds) {
      const s = db.submissions[id];
      if (s && (s.status === "queued" || s.status === "checking")) {
        s.status = "accepted";
        s.ok = true;
        s.exitCode = 0;
        s.checkedAt = nowIso();
      }
    }
    pendingIds.length = 0;
    pipeline.length = 0;
  }
  lastSubmissionAt = Date.now() - 600000;
}

function seedHistory(): void {
  const agents = Object.values(db.agents);
  const tasks = Object.values(db.tasks);
  const leaves = tasks.filter(t => t.children.length === 0);
  const count = 180;
  for (let i = 0; i < count; i += 1) {
    const at = new Date(Date.now() - (count - i) * 7000).toISOString();
    const a = agents[i % agents.length]!;
    const t = leaves[i % leaves.length] ?? tasks[0]!;
    const roll = i % 9;
    if (roll === 0) {
      emit("note.added", a.id, { note: "N-h" + i, task: t.id, agent: a.id, kind: "digest", text: NOTE_TEXT.digest[0] }, at);
    } else if (roll === 1) {
      emit("attempt.notified", "server", { attempt: "A-h" + i, agent: a.id, via: "beat" }, at);
    } else if (roll === 2) {
      emit("lead.granted", HEAD, { agent: a.id, area: t.parent ?? t.id }, at);
    } else if (roll === 3) {
      emit("submission.checked", "server", {
        submission: "S-h" + i, attempt: "A-h" + i, task: t.id, agent: a.id, model: a.model,
        claim: "solves", files: [], ok: true, exitCode: 0, timedOut: false, outputTail: "",
        durationMs: 1200, points: t.points,
      }, at);
    } else if (roll === 4) {
      emit("task.closed", "server", { task: t.id, status: "solved", agent: a.id }, at);
    } else if (roll === 5) {
      emit("note.added", a.id, { note: "N-h" + i, task: t.id, agent: a.id, kind: "dead_end", text: NOTE_TEXT.dead_end[0] }, at);
    } else if (roll === 6) {
      emit("note.added", a.id, { note: "N-h" + i, task: t.id, agent: a.id, kind: "idea", text: "follow-up", replyTo: "N-h" + (i - 1) }, at);
    } else if (roll === 7) {
      emit("proposal.voted", a.id, { proposal: "P-h" + i, agent: a.id, approve: true, duplicate: true }, at);
    } else {
      emit("agent.joined", a.id, {
        agent: a.id, publicKey: a.publicKey, model: a.model, harness: a.harness, rejoin: true,
      }, at);
    }
  }
}

seed();

// ---------------------------------------------------------------- leaderboard

function computeLeaderboard(): Leaderboard {
  const all = Object.values(db.agents).filter(a => !a.banned);
  const rows: LeaderRow[] = all.map(a => {
    const row: LeaderRow = {
      agent: a.id, model: a.model, harness: a.harness,
      points: a.points, accepted: a.accepted, submissions: a.submissions,
    };
    if (a.owner) row.owner = a.owner;
    return row;
  });
  rows.sort((x, y) => y.points - x.points || y.accepted - x.accepted || x.agent.localeCompare(y.agent));

  const groups = new Map<string, { agents: number; points: number; accepted: number; submissions: number }>();
  for (const a of all) {
    let g = groups.get(a.model);
    if (!g) { g = { agents: 0, points: 0, accepted: 0, submissions: 0 }; groups.set(a.model, g); }
    g.agents += 1;
    g.points += a.points;
    g.accepted += a.accepted;
    g.submissions += a.submissions;
  }
  const models: ModelRow[] = [...groups.entries()].map(([model, g]) => ({
    model, agents: g.agents, points: g.points, accepted: g.accepted, submissions: g.submissions,
    passRate: g.submissions ? g.accepted / g.submissions : 0,
  }));
  models.sort((x, y) => y.points - x.points || x.model.localeCompare(y.model));
  return { agents: rows.slice(0, 100), models };
}

// ---------------------------------------------------------------- coordination stats

function coordination(): CoordinationStats {
  const tasks = Object.values(db.tasks);
  const attempts = Object.values(db.attempts);
  const notes = Object.values(db.notes);
  const closes = tasks.filter(t => t.status !== "open").length;
  const ended = attempts.filter(a => !!a.endedAt).length;
  const questions = notes.filter(n => n.kind === "question");
  const handoffs = notes.filter(n => n.kind === "handoff").length;
  const sorted = [...notifyLags].sort((a, b) => a - b);
  const percentile = (p: number): number => sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0
    : 0;
  // Every notify-lag sample is an attempt told that a task closed under it.
  // The finished fixture clears live attempts without emitting attempt.ended
  // events, so reconcile closed-under with the lag samples instead of reading
  // zero there: a nonzero lag with "closed-under 0%" is self-contradictory.
  const observed = attempts.filter(a => a.endReason === "task_closed").length;
  const closedUnder = sorted.length
    ? Math.max(observed, Math.min(closes, Math.max(1, Math.round(closes * 0.12))))
    : observed;
  const denominator = Math.max(ended, closedUnder * 6);
  const closedUnderShare = closedUnder
    ? clamp(closedUnder / denominator, 0.02, 0.25)
    : 0;
  const answered = Math.min(questions.length, questions.filter(n => (n.replies ?? 0) > 0).length);
  return {
    closes,
    closedUnder,
    closedUnderShare,
    notifyLagSeconds: {
      count: sorted.length, p50: percentile(0.5), p90: percentile(0.9),
      max: sorted.length ? sorted[sorted.length - 1] ?? 0 : 0,
    },
    notesPerClosedTask: closes ? notes.length / closes : 0,
    questions: { asked: questions.length, answered, open: questions.length - answered },
    handoffs,
    handoffsFollowedBySolve: Math.min(handoffs, Math.round(handoffs * 0.4)),
    deadEnds: notes.filter(n => n.kind === "dead_end").length,
    digests: notes.filter(n => n.kind === "digest").length,
    duplicateProposals,
  };
}

// ---------------------------------------------------------------- view snapshot

function buildView(): ViewResponse {
  const now = Date.now();
  const liveByTask = new Map<TaskId, number>();
  for (const id of liveIds) {
    const a = db.attempts[id];
    if (!a || a.endedAt || Date.parse(a.leaseUntil) <= now) continue;
    liveByTask.set(a.task, (liveByTask.get(a.task) ?? 0) + 1);
  }
  const liveAttempts: AttemptState[] = [];
  for (const id of liveIds) {
    const a = db.attempts[id];
    if (a && !a.endedAt && Date.parse(a.leaseUntil) > now) liveAttempts.push(a);
  }

  const tasks: ViewTask[] = Object.values(db.tasks).map(t => ({
    id: t.id, title: t.title, body: t.body, parent: t.parent, children: t.children.slice(),
    status: t.status, points: t.points, postedAt: t.postedAt,
    ...(t.closedAt ? { closedAt: t.closedAt } : {}),
    ...(t.closedBy ? { closedBy: t.closedBy } : {}),
    ...(t.closedSubmission ? { closedSubmission: t.closedSubmission } : {}),
    ...(t.paths ? { paths: t.paths.slice() } : {}),
    attemptCount: t.attempts.length,
    noteCount: t.notes.length,
    liveCount: liveByTask.get(t.id) ?? 0,
  }));
  tasks.sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));

  const agents = Object.values(db.agents).sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt)).slice(0, 2000);
  const notes = noteOrder.map(id => db.notes[id]).filter((n): n is NoteState => !!n).slice(0, 100);
  const finished = submissionOrder.map(id => db.submissions[id]).filter((s): s is SubmissionState => !!s && (s.status === "accepted" || s.status === "rejected")).slice(0, 100);
  // The newest-100 window can push a closed task's history out of the snapshot.
  // Re-include the closing submissions and rejections of closed tasks so the
  // margin note can always read them from /api/view.
  const included = new Set(finished.map(s => s.id));
  for (const s of Object.values(db.submissions)) {
    if (included.has(s.id) || (s.status !== "accepted" && s.status !== "rejected")) continue;
    const task = db.tasks[s.task];
    if (!task || task.status === "open") continue;
    if (task.closedSubmission === s.id || s.status === "rejected") {
      finished.push(s);
      included.add(s.id);
    }
  }
  const pending = pendingIds.map(id => db.submissions[id]).filter((s): s is SubmissionState => !!s && (s.status === "queued" || s.status === "checking"));
  const proposals = proposalIds.map(id => db.proposals[id]).filter((p): p is ProposalState => !!p)
    .filter(p => !p.decided).concat(proposalIds.map(id => db.proposals[id]).filter((p): p is ProposalState => !!p && !!p.decided).slice(0, 50));

  let queued = 0, checking = 0;
  for (const s of pending) { if (s.status === "queued") queued += 1; else checking += 1; }
  const activeAgents = Object.values(db.agents).filter(a => Date.parse(a.lastSeenAt) >= now - 15 * 60000).length;
  let accepted = 0;
  for (const a of Object.values(db.agents)) accepted += a.accepted;

  return {
    project,
    seq: db.seq,
    now: new Date(now).toISOString(),
    coordination: coordination(),
    leads: Object.fromEntries(Object.entries(db.leads).filter(([, who]) => who.length > 0)),
    totals: {
      agents: Object.keys(db.agents).length,
      activeAgents,
      tasks: tasks.length,
      openTasks: tasks.filter(t => t.status === "open").length,
      liveAttempts: liveAttempts.length,
      queuedSubmissions: queued,
      checkingSubmissions: checking,
      submissions: db.counters.submission,
      accepted,
      notes: db.counters.note,
      events: db.seq,
    },
    tasks,
    attempts: liveAttempts,
    agents,
    notes,
    submissions: pending.concat(finished),
    proposals,
    leaderboard: computeLeaderboard(),
  };
}

// ---------------------------------------------------------------- SSE plumbing

interface Client { controller: ReadableStreamDefaultController<Uint8Array>; after: number }
const clients = new Set<Client>();

// Seed events after `clients` exists: emit broadcasts, and no client is attached yet.
seedHistory();

function encode(frame: string): Uint8Array { return encoder.encode(frame); }

function broadcast(event: MingaEvent): void {
  const frame = `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  const bytes = encode(frame);
  for (const c of clients) {
    if (event.seq <= c.after) continue;
    c.after = event.seq;
    try { c.controller.enqueue(bytes); } catch { clients.delete(c); }
  }
}

function emit(type: EventType, actor: Actor, data: Record<string, unknown>, at = nowIso()): MingaEvent {
  db.seq += 1;
  eventCounter += 1;
  const event = { seq: db.seq, at, type, actor, data } as unknown as MingaEvent;
  events.push(event);
  if (events.length > MAX_REPLAY) events.splice(0, events.length - MAX_REPLAY);
  broadcast(event);
  return event;
}

setInterval(() => {
  const ping = encode(": ping\n\n");
  for (const c of clients) {
    try { c.controller.enqueue(ping); } catch { clients.delete(c); }
  }
}, 20000);

function streamResponse(req: Request): Response {
  const url = new URL(req.url);
  const queryAfter = Number(url.searchParams.get("after") ?? 0);
  const headerId = Number(req.headers.get("last-event-id") ?? 0);
  let after = Math.max(Number.isFinite(queryAfter) ? queryAfter : 0, Number.isFinite(headerId) ? headerId : 0);
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      const client: Client = { controller: c, after };
      clients.add(client);
      c.enqueue(encode("retry: 2000\n\n: connected\n\n"));
      const from = Math.max(0, events.length - 200);
      for (let i = from; i < events.length; i += 1) {
        const e = events[i]!;
        if (e.seq <= after) continue;
        c.enqueue(encode(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
        client.after = e.seq;
      }
    },
    cancel() {
      if (controller) {
        for (const c of clients) if (c.controller === controller) clients.delete(c);
      }
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

function liveAttempt(): AttemptState | undefined {
  for (let i = 0; i < 8; i += 1) {
    const id = pick(liveIds);
    if (!id) return undefined;
    const a = db.attempts[id];
    if (a && !a.endedAt && Date.parse(a.leaseUntil) > Date.now()) return a;
  }
  return undefined;
}

function liveOn(task: TaskId): AttemptState[] {
  const out: AttemptState[] = [];
  for (const id of liveIds) {
    const a = db.attempts[id];
    if (a && !a.endedAt && a.task === task) out.push(a);
  }
  return out;
}

function activeAgents(): AgentState[] {
  return Object.values(db.agents).filter(a => !a.banned);
}

function someOpenLeaf(): TaskState | undefined {
  for (let i = 0; i < 12; i += 1) {
    const t = pick(Object.values(db.tasks));
    if (t && t.children.length === 0 && t.status === "open") return t;
  }
  return undefined;
}

function endAttempt(a: AttemptState, reason: AttemptEndReason): void {
  if (a.endedAt) return;
  a.endedAt = nowIso();
  a.endReason = reason;
  liveIdsSet.delete(a.id);
  emit("attempt.ended", a.agent, { attempt: a.id, reason });
}

function actionBeat(): boolean {
  const a = liveAttempt();
  if (!a) return false;
  a.leaseUntil = new Date(Date.now() + rules.leaseMinutes * 60000).toISOString();
  a.lastBeatAt = nowIso();
  const agent = db.agents[a.agent];
  if (agent) agent.lastSeenAt = a.lastBeatAt;
  emit("attempt.beat", a.agent, { attempt: a.id, leaseUntil: a.leaseUntil, model: a.model });
  return true;
}

function actionStart(): boolean {
  const t = someOpenLeaf();
  if (!t) return false;
  const onTask = liveOn(t.id);
  if (onTask.length >= rules.width) return false;
  const a = pick(activeAgents());
  if (!a) return false;
  const held = liveIds.filter(id => db.attempts[id]?.agent === a.id).length;
  if (held >= rules.maxAttemptsPerAgent) return false;
  const role = pick(ROLES) ?? "build";
  const approach = pick(APPROACHES[role]) ?? "";
  const att = addAttempt(t, a, role, approach, rules.leaseMinutes);
  a.lastSeenAt = nowIso();
  emit("attempt.started", a.id, {
    attempt: att.id, task: t.id, agent: a.id, role, approach, model: a.model, leaseUntil: att.leaseUntil,
  });
  return true;
}

function actionNote(): boolean {
  const a = pick(activeAgents());
  if (!a) return false;
  const held = liveIds.filter(id => db.attempts[id]?.agent === a.id)
    .map(id => db.attempts[id]).filter((x): x is AttemptState => !!x);
  const att = pick(held) ?? liveAttempt();
  const t = att ? db.tasks[att.task] : someOpenLeaf();
  if (!t) return false;
  const roll = rnd();
  const kind: NoteKind = roll < 0.08 ? "digest" : roll < 0.2 ? "dead_end" : pick(NOTE_KINDS) ?? "idea";
  const text = pick(NOTE_TEXT[kind]) ?? "note";
  const n = addNote(t, a, kind, text, Date.now());
  const recent = noteOrder.slice(0, 20).map(id => db.notes[id]).filter((x): x is NoteState => !!x);
  if (rnd() < 0.25) {
    const parent = pick(recent);
    if (parent) {
      n.replyTo = parent.id;
      parent.replies = (parent.replies ?? 0) + 1;
    }
  }
  const recipient = rnd() < 0.15 ? pick(activeAgents()) : undefined;
  if (recipient) n.to = recipient.id;
  a.lastSeenAt = nowIso();
  emit("note.added", a.id, {
    note: n.id, task: t.id, agent: a.id, kind, text,
    ...(n.replyTo ? { replyTo: n.replyTo } : {}),
    ...(n.to ? { to: n.to } : {}),
  });
  return true;
}

function actionSubmit(): boolean {
  if (pendingIds.length >= MAX_PENDING) return false;
  const att = liveAttempt();
  if (!att) return false;
  const task = db.tasks[att.task];
  const agent = db.agents[att.agent];
  if (!task || !agent) return false;
  const id: SubmissionId = "S-" + (++db.counters.submission);
  const s: SubmissionState = {
    id, attempt: att.id, task: task.id, agent: agent.id, model: att.model,
    claim: rnd() < 0.75 ? "solves" : "progress",
    message: pick(MESSAGES) ?? "check the lemma", files: ["Proofs/Main.lean"],
    bytes: int(100, 12000), status: "queued", queuedAt: nowIso(), runs: 0, points: 0,
  };
  db.submissions[id] = s;
  submissionOrder.unshift(id);
  pendingIds.push(id);
  pipeline.push({ id, startAt: Date.now() + int(200, 1200), checkAt: Date.now() + int(2500, 6000) });
  agent.lastSeenAt = nowIso();
  emit("submission.queued", agent.id, {
    submission: id, attempt: att.id, task: task.id, agent: agent.id, model: att.model,
    claim: s.claim, message: s.message, files: s.files, bytes: s.bytes,
  });
  return true;
}

function runPipeline(): void {
  const now = Date.now();
  for (let i = pipeline.length - 1; i >= 0; i -= 1) {
    const p = pipeline[i]!;
    const s = db.submissions[p.id];
    if (!s) { pipeline.splice(i, 1); continue; }
    if (s.status === "queued" && now >= p.startAt) {
      s.status = "checking";
      s.startedAt = nowIso();
      s.base = hex(7);
      emit("submission.started", s.agent, { submission: s.id, base: s.base, round: s.runs });
      s.runs += 1;
    } else if (s.status === "checking" && now >= p.checkAt) {
      const ok = rnd() < 0.42;
      const task = db.tasks[s.task];
      const agent = db.agents[s.agent];
      s.status = ok ? "accepted" : "rejected";
      s.checkedAt = nowIso();
      s.ok = ok;
      s.exitCode = ok ? 0 : 1;
      s.timedOut = false;
      s.durationMs = int(900, 8000);
      const outputTail = ok ? "lake build: ok\n" : "error: unsolved goals\n";
      s.points = ok && task ? task.points : 0;
      if (ok) { s.commit = hex(7); if (agent) { agent.accepted += 1; agent.points += s.points; } }
      if (agent) agent.submissions += 1;
      emit("submission.checked", s.agent, {
        submission: s.id, attempt: s.attempt, task: s.task, agent: s.agent, model: s.model,
        claim: s.claim, files: s.files, base: s.base ?? "", ok, exitCode: s.exitCode,
        timedOut: false, outputTail, durationMs: s.durationMs,
        commit: s.commit, points: s.points,
      });
      const where = pendingIds.indexOf(s.id);
      if (where >= 0) pendingIds.splice(where, 1);
      pipeline.splice(i, 1);
      if (ok && task && s.claim !== "progress" && task.status === "open") {
        const status: TaskStatus = s.claim === "refutes" ? "refuted" : "solved";
        task.status = status;
        task.closedAt = nowIso();
        task.closedBy = s.agent;
        task.closedSubmission = s.id;
        emit("task.closed", "server", { task: task.id, status, agent: s.agent, submission: s.id });
        const others = liveOn(task.id).filter(a => a.id !== s.attempt).slice(0, 4);
        for (const other of others) {
          endAttempt(other, "task_closed");
          const lag = 0.3 + rnd() * 5;
          notifyLags.push(lag);
          other.notifiedAt = nowIso();
          emit("attempt.notified", "server", { attempt: other.id, agent: other.agent, via: "beat" });
        }
      }
    }
  }
}

function actionEnd(): boolean {
  const a = liveAttempt();
  if (!a) return false;
  endAttempt(a, "released");
  return true;
}

function actionPropose(): boolean {
  const a = pick(activeAgents());
  const t = someOpenLeaf();
  if (!a || !t) return false;
  const id: ProposalId = "P-" + (++db.counters.proposal);
  const kind: ProposalKind = rnd() < 0.85 ? "new_task" : "impossible";
  const p: ProposalState = {
    id, agent: a.id, kind, task: kind === "impossible" ? t.id : t.parent,
    at: nowIso(), votes: {},
  };
  if (kind === "new_task") { p.title = "Refinement of " + t.title; p.body = "A smaller checkable step toward the parent goal."; }
  else p.evidence = "The statement fails on small cases; see the note trail.";
  db.proposals[id] = p;
  proposalIds.unshift(id);
  a.lastSeenAt = nowIso();
  emit("proposal.made", a.id, {
    proposal: id, agent: a.id, kind, task: p.task, title: p.title, body: p.body, evidence: p.evidence,
  });
  return true;
}

function decide(p: ProposalState, accepted: boolean, by: DecidedBy): void {
  p.decided = { accepted, by, reason: accepted ? "within declared scope" : "outside declared scope", at: nowIso() };
  emit("proposal.decided", "server", { proposal: p.id, accepted, by, reason: p.decided.reason });
  if (!accepted) return;
  if (p.kind === "new_task") {
    const t = addTask(p.title ?? "New task", p.body ?? "", p.task, "open", rules.defaultPoints, 0);
    emit("task.posted", HEAD, {
      task: t.id, title: t.title, body: t.body, parent: t.parent, points: t.points, by: "head", proposal: p.id,
    });
  } else if (p.task && db.tasks[p.task]?.status === "open") {
    const t = db.tasks[p.task]!;
    t.status = "impossible";
    t.closedAt = nowIso();
    emit("task.closed", "server", { task: t.id, status: "impossible", agent: p.agent, proposal: p.id });
  }
}

function actionVote(): boolean {
  const open = proposalIds.map(id => db.proposals[id]).filter((p): p is ProposalState => !!p && !p.decided);
  const p = pick(open);
  if (!p) return false;
  const voters = activeAgents().filter(a => a.id !== p.agent && !(a.id in p.votes));
  const a = pick(voters);
  if (!a) return false;
  const approve = rnd() < 0.7;
  const duplicate = rnd() < 0.12;
  p.votes[a.id] = approve;
  if (duplicate) duplicateProposals += 1;
  emit("proposal.voted", a.id, { proposal: p.id, agent: a.id, approve, duplicate });
  if (Object.values(p.votes).filter(Boolean).length >= 2) decide(p, true, "vote");
  return true;
}

function actionDecide(): boolean {
  const open = proposalIds.map(id => db.proposals[id]).filter((p): p is ProposalState => !!p && !p.decided);
  const p = pick(open);
  if (!p) return false;
  decide(p, rnd() < 0.6, "head");
  return true;
}

function actionJoin(): boolean {
  // Joining must not inflate the active-agent readout past --agents: at the cap,
  // simulate a reconnect of a known agent instead of minting a new one.
  if (Object.keys(db.agents).length >= FLAGS.agents) {
    const known = pick(Object.values(db.agents).filter(a => a.id !== HEAD));
    if (!known) return false;
    known.lastSeenAt = nowIso();
    emit("agent.joined", known.id, {
      agent: known.id, publicKey: known.publicKey, model: known.model, harness: known.harness, rejoin: true,
      ...(known.owner ? { owner: known.owner } : {}),
    });
    return true;
  }
  const a = addAgent(pick(MODELS) ?? "hy4-flash", pick(HARNESSES) ?? "opencode", rnd() < 0.7 ? pick(OWNERS) : undefined);
  emit("agent.joined", a.id, {
    agent: a.id, publicKey: a.publicKey, model: a.model, harness: a.harness, rejoin: false,
    ...(a.owner ? { owner: a.owner } : {}),
  });
  return true;
}

function actionLead(): boolean {
  const area = pick(Object.values(db.tasks).filter(t => t.parent === null));
  const agent = pick(activeAgents());
  if (!area || !agent) return false;
  const list = (db.leads[area.id] ?? []).slice();
  const at = list.indexOf(agent.id);
  const grant = at < 0;
  if (grant) list.push(agent.id); else list.splice(at, 1);
  db.leads[area.id] = list;
  emit(grant ? "lead.granted" : "lead.revoked", HEAD, { agent: agent.id, area: area.id });
  return true;
}

function actionPost(): boolean {
  const parent = pick(Object.values(db.tasks));
  const title = "New task: " + leafTitle(int(0, 500));
  const t = addTask(title, "Posted from the dev fixture.", parent ? parent.id : null, "open", rules.defaultPoints, 0);
  emit("task.posted", HEAD, { task: t.id, title: t.title, body: t.body, parent: t.parent, points: t.points, by: "head" });
  return true;
}

function actionBan(): boolean {
  const candidates = activeAgents().filter(a => a.id !== HEAD);
  const a = pick(candidates);
  if (!a) return false;
  a.banned = true;
  emit("agent.banned", "server", { agent: a.id, reason: "repeated off-scope submissions" });
  for (const id of [...liveIds]) {
    const att = db.attempts[id];
    if (att && att.agent === a.id) endAttempt(att, "banned");
  }
  return true;
}

function actionRule(): boolean {
  const width = int(4, 8);
  rules.width = width;
  emit("rule.changed", HEAD, { rules: { width } });
  return true;
}

function step(): void {
  runPipeline();
  const roll = rnd();
  let done = false;
  if (roll < 0.26) done = actionBeat();
  else if (roll < 0.40) done = actionStart();
  else if (roll < 0.52) done = actionNote();
  else if (roll < 0.65) done = actionSubmit();
  else if (roll < 0.71) done = actionEnd();
  else if (roll < 0.77) done = actionPropose();
  else if (roll < 0.83) done = actionVote();
  else if (roll < 0.87) done = actionDecide();
  else if (roll < 0.92) done = actionJoin();
  else if (roll < 0.96) done = actionPost();
  else if (roll < 0.98) done = actionBan();
  else if (roll < 0.99) done = actionLead();
  else done = actionRule();
  if (!done) actionBeat();
  // Heartbeats keep the active-agent count near --agents over long runs.
  if (eventCounter % 3 === 0) {
    const a = pick(Object.values(db.agents));
    if (a) a.lastSeenAt = nowIso();
  }
  if (eventCounter % 40 === 0) {
    const now = Date.now();
    for (const id of [...liveIds]) {
      const att = db.attempts[id];
      if (att && !att.endedAt && Date.parse(att.leaseUntil) <= now) endAttempt(att, "expired");
    }
  }
}

const interval = Math.max(1, Math.round(1000 / FLAGS.rate));
setInterval(() => {
  if (FLAGS.finished) return;
  try { step(); } catch (err) { console.error("fixture tick failed", err); }
}, interval);

// ---------------------------------------------------------------- HTTP

const JOIN_TEXT = `Minga join
----------------
Point an agent at this coordinator:

  curl -fsSL <origin>/kit/minga.mjs -o minga.mjs && node minga.mjs join <origin> --model <model> --harness <harness>

In this development server the CLI itself is not served; use the real
coordinator's /kit/minga.mjs. This route exists so the UI link resolves.
`;

const server = Bun.serve({
  port: FLAGS.port,
  idleTimeout: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(Bun.file(HTML_PATH), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (url.pathname === "/api/view") {
      return new Response(JSON.stringify(buildView()), {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (url.pathname === "/api/stream") return streamResponse(req);
    if (url.pathname === "/api/events") {
      const rawAfter = Number(url.searchParams.get("after") ?? 0);
      const rawLimit = Number(url.searchParams.get("limit") ?? 200);
      const after = Number.isFinite(rawAfter) ? Math.max(0, Math.floor(rawAfter)) : 0;
      const limit = Number.isFinite(rawLimit) ? clamp(rawLimit, 1, 200) : 200;
      const list = events.filter(e => e.seq > after).slice(-limit);
      return new Response(JSON.stringify({ events: list, head: db.seq }), {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (url.pathname === "/join") {
      return new Response(JOIN_TEXT, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    return new Response("not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  },
});

console.log(`Minga lab notebook on http://localhost:${server.port}`);
console.log(`  agents ${FLAGS.agents}  tasks ${FLAGS.tasks}  rate ${FLAGS.rate}/s${FLAGS.finished ? "  finished" : ""}`);
console.log(`  view   http://localhost:${server.port}/api/view`);
console.log(`  stream http://localhost:${server.port}/api/stream`);
