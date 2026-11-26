/**
 * Command implementations and argument parsing for the CLI kit.
 *
 * Everything here is a pure function of a client plus already-parsed arguments
 * (the only I/O is reading submitted files and process.cwd()), so the commands
 * can be unit tested without a server or a shell.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import type {
  Assignment, AttemptView, BeatNews, BeatResponse, HeadLeadRequest, HeadLeadResponse, JoinResponse,
  LeaderboardResponse, NextResponse, NoteResponse, Notice, ProposeResponse, ProjectInfo, ReleaseResponse,
  SubmitResponse, SubmissionView, VoteResponse, HeadDecideResponse, HeadNoteResponse, HeadRuleResponse,
  HeadPostResponse, TasksResponse,
} from "../core/protocol.ts";
import type {
  AcceptPolicy, AgentId, Claim, NoteKind, ProposalId, ProposalKind, ReleaseReason, Rules, TaskId,
} from "../core/types.ts";
import { NOTE_KINDS, RELEASE_REASONS } from "../core/types.ts";
import type { Role } from "../core/types.ts";

/** What each role asks of an agent. Any role may submit --claim solves. */
export const ROLE_HINTS: Record<Role, string> = {
  build: "write the most direct working solution",
  explore: "try a different approach from the others on this task; note what you learn",
  attack: "hunt for edge cases, wrong specs or counterexamples; refute with evidence, or solve it robustly",
  distill: "read the notes and existing attempts, then submit the simplest correct version",
  plan: "split the task into smaller ones with minga propose task --under <task>",
};
import type { KeyPair } from "../identity/keys.ts";
import { agentIdFromPublicKey, formatHeadKey, generateKeyPair } from "../identity/keys.ts";
import type { Client } from "./client.ts";
import type { HeadIdentity, SessionIdentity } from "./store.ts";

// ---------------------------------------------------------------- parsing

type OptionSpec =
  | { type: "string"; short?: string; multiple?: boolean }
  | { type: "boolean"; short?: string; multiple?: boolean };
type OptionSet = Record<string, OptionSpec>;

export type ParsedValue = string | boolean;

export interface ParsedCli {
  /** Agent command, "head", "lead", "help", or "" when nothing was given. */
  command: string;
  /** head/lead subcommand: keygen | post | decide | rule | ban | close | note | lead | help. */
  action?: string;
  options: Record<string, ParsedValue>;
  positionals: string[];
  /** Verbatim arguments for `serve`, forwarded to the Bun server. */
  raw?: string[];
}

const COMMON_OPTIONS: OptionSet = {
  json: { type: "boolean" },
  dir: { type: "string" },
  url: { type: "string" },
  help: { type: "boolean", short: "h" },
};

const COMMAND_OPTIONS: Record<string, OptionSet> = {
  join: {
    model: { type: "string" },
    harness: { type: "string" },
    owner: { type: "string" },
  },
  next: {
    model: { type: "string" },
    approach: { type: "string" },
    wait: { type: "string" },
  },
  beat: {
    model: { type: "string" },
    approach: { type: "string" },
    paths: { type: "string" },
  },
  note: {
    reply: { type: "string" },
    to: { type: "string" },
  },
  submit: {
    claim: { type: "string" },
    message: { type: "string", short: "m" },
    root: { type: "string" },
    model: { type: "string" },
    // `--no-wait` sets this to false; the default is true.
    wait: { type: "boolean" },
  },
  result: {
    wait: { type: "boolean" },
  },
  release: {
    handoff: { type: "string" },
    reason: { type: "string" },
  },
  propose: {
    under: { type: "string" },
    title: { type: "string" },
    body: { type: "string" },
    evidence: { type: "string" },
  },
  vote: {},
  status: {},
  board: {},
  tasks: {
    open: { type: "boolean" },
  },
  init: {
    name: { type: "string" },
    goal: { type: "string" },
    scope: { type: "string" },
    check: { type: "string" },
    paths: { type: "string" },
    branch: { type: "string" },
    force: { type: "boolean" },
  },
  doctor: {
    repo: { type: "string" },
  },
  sync: {
    discard: { type: "boolean" },
  },
  check: {},
  mcp: {},
};

const HEAD_OPTIONS: Record<string, OptionSet> = {
  keygen: {},
  post: {
    title: { type: "string" },
    body: { type: "string" },
    under: { type: "string" },
    points: { type: "string" },
    paths: { type: "string" },
  },
  decide: {
    reason: { type: "string" },
  },
  lead: {
    revoke: { type: "boolean" },
  },
  rule: {},
  ban: {
    reason: { type: "string" },
  },
  note: {
    kind: { type: "string" },
  },
  close: {
    reason: { type: "string" },
  },
};

/** Area leads post tasks and decide proposals inside the areas they lead. */
const LEAD_OPTIONS: Record<string, OptionSet> = {
  post: {
    title: { type: "string" },
    body: { type: "string" },
    under: { type: "string" },
    points: { type: "string" },
    paths: { type: "string" },
  },
  decide: {
    reason: { type: "string" },
  },
};

function cleanValues(
  values: Record<string, string | boolean | (string | boolean)[] | undefined>,
): Record<string, ParsedValue> {
  const out: Record<string, ParsedValue> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      const last = value[value.length - 1];
      if (last !== undefined) out[key] = last;
      continue;
    }
    out[key] = value;
  }
  return out;
}

function parseTail(args: string[], extra: OptionSet): { options: Record<string, ParsedValue>; positionals: string[] } {
  // Bun's parseArgs does not treat --no-wait as the negation of --wait, so
  // normalise it to an explicit flag and fold it back afterwards.
  const parsed = parseArgs({
    args: args.map((arg) => arg === "--no-wait" ? "--nowait" : arg),
    options: { ...COMMON_OPTIONS, ...extra, nowait: { type: "boolean" } },
    allowPositionals: true,
    strict: true,
  }) as {
    values: Record<string, string | boolean | (string | boolean)[] | undefined>;
    positionals: string[];
  };
  const options = cleanValues(parsed.values);
  if (options.nowait === true) {
    options.wait = false;
    delete options.nowait;
  }
  return { options, positionals: parsed.positionals };
}

export function parseCli(argv: string[]): ParsedCli {
  const first = argv[0];
  if (first === undefined) return { command: "", options: {}, positionals: [] };
  if (first === "help" || first === "--help" || first === "-h") {
    return { command: "help", options: {}, positionals: argv.slice(1) };
  }
  if (first.startsWith("-")) throw new Error(`unexpected option: ${first} (try "minga help")`);

  // `serve` forwards its flags to the Bun server verbatim, so it is parsed
  // separately: only this CLI's own --json/--dir/--help are stripped later.
  if (first === "serve") {
    return { command: "serve", options: {}, positionals: [], raw: argv.slice(1) };
  }

  if (first === "head" || first === "lead") {
    const table = first === "head" ? HEAD_OPTIONS : LEAD_OPTIONS;
    const action = argv[1];
    if (action === undefined) return { command: first, options: {}, positionals: [] };
    if (action === "help" || action === "--help" || action === "-h") {
      return { command: first, action: "help", options: {}, positionals: argv.slice(2) };
    }
    const spec = table[action];
    if (!spec) throw new Error(`unknown ${first} action: ${action} (try "minga ${first} --help")`);
    const { options, positionals } = parseTail(argv.slice(2), spec);
    return { command: first, action, options, positionals };
  }

  const spec = COMMAND_OPTIONS[first];
  if (!spec) throw new Error(`unknown command: ${first} (try "minga help")`);
  const { options, positionals } = parseTail(argv.slice(1), spec);
  return { command: first, options, positionals };
}

// ---------------------------------------------------------------- result shape

export interface CommandResult<T = unknown> {
  /** Human-readable output, without a trailing newline. */
  text: string;
  /** Raw response for --json. */
  data: T;
}

// ---------------------------------------------------------------- formatting helpers

export function formatAcceptPolicy(policy: AcceptPolicy): string {
  switch (policy.mode) {
    case "head":
      return "head";
    case "votes":
      return `votes:${policy.votes}`;
    case "head-or-votes":
      return `head-or-votes:${policy.votes}`;
  }
}

export function formatRules(rules: Rules): string {
  return [
    `width=${rules.width}`,
    `leaseMinutes=${rules.leaseMinutes}`,
    `maxLiveAttemptsPerAgent=${rules.maxAttemptsPerAgent}`,
    `defaultPoints=${rules.defaultPoints}`,
    `accept=${formatAcceptPolicy(rules.accept)}`,
  ].join(" ");
}

function indent(text: string, prefix = "  "): string {
  return text.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function positiveInt(key: string, value: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${key} must be a whole number, got "${value}"`);
  const n = Number(value);
  if (n < 1) throw new Error(`${key} must be at least 1, got "${value}"`);
  return n;
}

function nonNegativeInt(key: string, value: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${key} must be a whole number, got "${value}"`);
  return Number(value);
}

/** "head" | "votes:N" | "head-or-votes:N" -> Rules["accept"]. */
export function parseAcceptPolicy(text: string): AcceptPolicy {
  if (text === "head") return { mode: "head" };
  const votes = /^votes:(\d+)$/.exec(text);
  if (votes?.[1] !== undefined) return { mode: "votes", votes: positiveInt("votes", votes[1]) };
  const hybrid = /^head-or-votes:(\d+)$/.exec(text);
  if (hybrid?.[1] !== undefined) return { mode: "head-or-votes", votes: positiveInt("votes", hybrid[1]) };
  throw new Error(`accept must be "head", "votes:N" or "head-or-votes:N", got "${text}"`);
}

/** `width=3 leaseMinutes=10 accept=head` -> a partial Rules update. */
export function parseRuleArgs(pairs: string[]): Partial<Rules> {
  if (pairs.length === 0) {
    throw new Error("head rule needs at least one key=value (width, leaseMinutes, maxAttemptsPerAgent, defaultPoints, accept)");
  }
  const rules: Partial<Rules> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new Error(`expected key=value, got "${pair}"`);
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    switch (key) {
      case "width":
        rules.width = positiveInt(key, value);
        break;
      case "leaseMinutes":
        rules.leaseMinutes = positiveInt(key, value);
        break;
      case "maxAttemptsPerAgent":
        rules.maxAttemptsPerAgent = positiveInt(key, value);
        break;
      case "defaultPoints":
        rules.defaultPoints = nonNegativeInt(key, value);
        break;
      case "accept":
        rules.accept = parseAcceptPolicy(value);
        break;
      default:
        throw new Error(
          `unknown rule "${key}" (width, leaseMinutes, maxAttemptsPerAgent, defaultPoints, accept)`,
        );
    }
  }
  return rules;
}

export function parseClaim(text: string): Claim {
  if (text === "solves" || text === "refutes" || text === "progress") return text;
  throw new Error(`claim must be solves, refutes or progress, got "${text}"`);
}

export function parseNoteKind(text: string): NoteKind {
  if ((NOTE_KINDS as readonly string[]).includes(text)) return text as NoteKind;
  throw new Error(`note kind must be one of ${NOTE_KINDS.join(", ")}, got "${text}"`);
}

export function parseReleaseReason(text: string): ReleaseReason {
  if ((RELEASE_REASONS as readonly string[]).includes(text)) return text as ReleaseReason;
  throw new Error(`release reason must be one of ${RELEASE_REASONS.join(", ")}, got "${text}"`);
}

/** "a.ts,b/, c.ts" -> ["a.ts", "b/", "c.ts"]; an absent option stays absent. */
export function parsePaths(text: string): string[] {
  return text.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
}

/**
 * Notices are news the server attaches once to a signed response. They are
 * always agent-written, hence the explicit label.
 */
export function formatNotice(notice: Notice): string {
  if (notice.kind === "attempt_ended") {
    const by = notice.closedBy;
    const who = by
      ? ` by ${by.submission ?? "a decision"} from ${by.agent}${by.model ? ` (${by.model})` : ""}`
      : "";
    const what = notice.reason === "task_closed"
      ? `${notice.task} was ${notice.taskStatus}${who}`
      : `ended (${notice.reason})`;
    return `notice: ${notice.attempt} ended: ${what}; run minga sync, then minga next --wait 600`;
  }
  const note = notice.note;
  const reply = note.replyTo ? ` (reply to ${note.replyTo})` : "";
  return `notice: note ${note.id} from ${note.agent} on ${note.task}${reply}: [agent note] ${note.text}`;
}

/** Safe extraction for commands whose data is not guaranteed to carry notices. */
export function noticeLines(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const notices = (data as { notices?: unknown }).notices;
  if (!Array.isArray(notices)) return [];
  return notices.filter((n): n is Notice => !!n && typeof n === "object").map(formatNotice);
}

// ---------------------------------------------------------------- join

export interface JoinInput {
  url: string;
  keys: KeyPair;
  model: string;
  harness: string;
  owner?: string;
}

export interface JoinOutput {
  identity: SessionIdentity;
  result: CommandResult<JoinResponse>;
}

export async function joinCommand(client: Client, input: JoinInput): Promise<JoinOutput> {
  const response = await client.join({
    publicKey: input.keys.publicKey,
    model: input.model,
    harness: input.harness,
    ...(input.owner !== undefined ? { owner: input.owner } : {}),
  });
  const identity: SessionIdentity = {
    url: input.url,
    agent: response.agent,
    publicKey: input.keys.publicKey,
    privateKey: input.keys.privateKey,
    model: input.model,
    harness: input.harness,
  };
  if (input.owner !== undefined) identity.owner = input.owner;
  if (typeof response.project.check === "string") identity.check = response.project.check;

  const lines = [
    `${response.rejoin ? "rejoined" : "joined"} ${response.project.name} as agent ${response.agent}`,
    `goal: ${response.project.goal}`,
    `scope: ${response.project.scope}`,
    `rules: ${formatRules(response.project.rules)}`,
    "",
    `get the code: git clone -b ${response.project.branch ?? "main"} ${input.url.replace(/\/+$/, "")}/repo.git work && cd work`,
    "run minga from inside that checkout; submit reads files relative to cwd",
  ];
  if (response.live.length > 0) lines.push(`live attempts from before: ${response.live.join(", ")}`);
  return { identity, result: { text: lines.join("\n"), data: response } };
}

// ---------------------------------------------------------------- the loop

export interface NextInput {
  model?: string;
  approach?: string;
  /** Total seconds to keep asking. 0 means a single request. */
  wait?: number;
  onProgress?: (line: string) => void;
}

/** `headAgent` marks maintainer notes so agents can tell them from peer notes. */
function formatAssignment(a: Assignment, headAgent?: AgentId): string {
  const headMark = (agent: AgentId): string =>
    headAgent !== undefined && agent === headAgent ? "head: " : "";
  const lines = [
    `attempt   ${a.attempt}`,
    `role      ${a.role} (${ROLE_HINTS[a.role]})`,
    `lease     ${a.leaseUntil}`,
    ...(a.head ? [`head ${a.head.slice(0, 7)} (minga sync if your checkout is older)`] : []),
    `task      ${a.task.id}  ${a.task.title}  (${a.task.points} points)`,
  ];
  if (a.path.length > 0) {
    lines.push(`path      ${a.path.map((p) => `${p.id} ${p.title}`).join(" > ")}`);
  }
  if (a.paths && a.paths.length > 0) lines.push(`paths     ${a.paths.join(", ")}`);
  lines.push("body:", indent(a.task.body.length > 0 ? a.task.body : "(empty)"));
  if (a.handoff) {
    lines.push(`handoff   ${a.handoff.id} ${headMark(a.handoff.agent)}(${a.handoff.kind}) ${a.handoff.text}`);
  }
  for (const digest of a.digests ?? []) {
    lines.push(`digest (agent-written) ${digest.id} by ${headMark(digest.agent)}${digest.agent}:`);
    lines.push(indent(digest.text));
  }
  if (a.notes.length > 0) {
    lines.push("notes:");
    for (const note of a.notes) {
      lines.push(`  ${note.id} ${headMark(note.agent)}${note.agent} ${note.kind}: ${note.text}`);
    }
  }
  if (a.questions && a.questions.length > 0) {
    lines.push("questions:");
    for (const q of a.questions) lines.push(`  ${q.id} ${headMark(q.agent)}${q.agent}: ${q.text}`);
  }
  if (a.deadEnds && a.deadEnds.length > 0) {
    lines.push("dead ends:");
    for (const d of a.deadEnds) lines.push(`  ${d.id} ${headMark(d.agent)}${d.agent}: ${d.text}`);
  }
  if (a.others.length > 0) {
    lines.push(`others on this task (the first accepted solve closes it for everyone; submit as soon as minga check passes):`);
    for (const other of a.others) {
      const approach = other.approach.length > 0 ? ` — ${other.approach}` : "";
      const paths = other.paths && other.paths.length > 0 ? ` [paths: ${other.paths.join(", ")}]` : "";
      lines.push(`  ${other.attempt} ${other.agent} ${other.model} ${other.role}${approach}${paths}`);
    }
  }
  for (const conflict of a.conflicts ?? []) {
    lines.push(`conflict: ${conflict.path} also declared by ${conflict.attempt} on ${conflict.task}`);
  }
  return lines.join("\n");
}

/**
 * POST /api/next with `wait` seconds, repeated until an assignment arrives or
 * the total budget is used up. Each individual request waits at most 30 s.
 */
export async function nextCommand(client: Client, input: NextInput = {}): Promise<CommandResult<NextResponse>> {
  const total = Math.max(0, Math.floor(input.wait ?? 0));
  const started = Date.now();
  let last: NextResponse | undefined;

  for (;;) {
    const remaining = total - (Date.now() - started) / 1000;
    const chunk = total === 0 ? 0 : Math.min(30, remaining);
    if (total > 0 && chunk <= 0) break;

    const t0 = Date.now();
    const response = await client.next({
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.approach !== undefined ? { approach: input.approach } : {}),
      ...(chunk > 0 ? { wait: chunk } : {}),
    });
    // done is a terminal answer: no open leaf task remains, so stop asking.
    if (response.done === true) {
      return { text: "the project has no open tasks left. Stop here.", data: response };
    }
    if (response.assignment) {
      let headAgent: AgentId | undefined;
      if (response.assignment.notes.length > 0 || response.assignment.handoff
        || (response.assignment.digests?.length ?? 0) > 0
        || (response.assignment.questions?.length ?? 0) > 0
        || (response.assignment.deadEnds?.length ?? 0) > 0) {
        try {
          headAgent = (await client.project()).headAgent;
        } catch {
          // An unavailable project endpoint must not hide the assignment.
        }
      }
      return { text: formatAssignment(response.assignment, headAgent), data: response };
    }
    last = response;
    if (chunk > 0) {
      const left = Math.max(0, Math.ceil(total - (Date.now() - started) / 1000));
      input.onProgress?.(`no free task yet; waiting (${left}s left)`);
    }

    if (total === 0 || chunk <= 0) break;
    // A server that ignores `wait` must not spin the CPU in a tight loop.
    if (Date.now() - t0 < 50) {
      const rest = total - (Date.now() - started) / 1000;
      if (rest <= 0) break;
      await new Promise<void>((done) => setTimeout(done, Math.min(100, rest * 1000)));
    }
  }

  const wait = last?.retryAfterSeconds ?? 60;
  return {
    // Without --wait an agent should be told the one command that will block.
    text: total === 0
      ? 'nothing to do right now; run "minga next --wait 600" to wait for a task'
      : `nothing to do, retry in ${wait}s`,
    data: last ?? { assignment: null, retryAfterSeconds: wait },
  };
}

// ---------------------------------------------------------------- submit / result

/** The server keeps only the first line, max 200 chars; fit it before sending. */
export const SUBMIT_MESSAGE_MAX = 200;

export function fitSubmitMessage(message: string): { message: string; notice?: string } {
  if (message.length <= SUBMIT_MESSAGE_MAX) return { message };
  const first = message.split("\n")[0] ?? "";
  const fitted = first.length > SUBMIT_MESSAGE_MAX
    ? `${first.slice(0, SUBMIT_MESSAGE_MAX - 3)}...`
    : first;
  return { message: fitted, notice: `submit message over ${SUBMIT_MESSAGE_MAX} chars; using "${fitted}"` };
}

export interface SubmitInput {
  attempt: string;
  claim: Claim;
  message: string;
  /** Paths as given on the command line, relative to `root` unless absolute. */
  files: string[];
  root?: string;
  model?: string;
  /** Default true: poll for the verdict. `--no-wait` sets this to false. */
  wait?: boolean;
  onProgress?: (line: string) => void;
}

/** `data` for --json is the queued acknowledgement or the final submission view. */
export type SubmitView = SubmissionView | SubmitResponse;

/** Reads `files` and maps them to repo-relative POSIX paths (protocol SubmitRequest.files). */
export function readSubmissionFiles(root: string, files: string[]): Record<string, string> {
  const resolvedRoot = resolve(root);
  const out: Record<string, string> = {};
  for (const file of files) {
    const absolute = isAbsolute(file) ? file : resolve(resolvedRoot, file);
    const rel = relative(resolvedRoot, absolute);
    if (rel.length === 0 || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`file is outside the repo root: ${file}`);
    }
    if (rel.split(sep)[0] === ".minga") throw new Error(`refusing to submit ${file}: .minga/ holds your private key`);
    out[rel.split(sep).join("/")] = readFileSync(absolute, "utf8");
  }
  return out;
}

function isFinal(status: string): boolean {
  return status === "accepted" || status === "rejected";
}

/** Poll GET /api/submission/<id>?wait=30 until a final status is returned. */
export async function waitForSubmission(
  client: Client,
  id: string,
  onProgress?: (line: string) => void,
  initialStatus = "queued",
): Promise<SubmissionView> {
  let lastStatus = initialStatus;
  let lastRuns = 0;
  // Each poll holds the connection for up to 30 s; 1000 polls is > 8 hours.
  for (let i = 0; i < 1000; i++) {
    const view = await client.submission(id, 30);
    const changed = view.status !== lastStatus || view.runs !== lastRuns;
    lastStatus = view.status;
    lastRuns = view.runs;
    if (view.status === "checking" && changed) {
      onProgress?.(`checking ${id} (run ${view.runs})`);
    }
    // The final block below is the only place that reports the verdict.
    if (isFinal(view.status)) return view;
    // A server that answers at once without news must not turn this into a busy loop.
    if (!changed) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`submission ${id} has no verdict yet; check it with "minga result ${id}"`);
}

/** Why a check was discarded without a verdict, read from the server's outputTail. */
function staleReason(view: SubmitView): string | undefined {
  if (!("stale" in view) || view.stale !== true) return undefined;
  const tail = view.outputTail ?? "";
  if (/branch kept moving/i.test(tail)) return "the branch kept moving";
  if (/\bclosed\b/i.test(tail)) return "the task closed first";
  return "unknown reason";
}

/** The exact text printed for a submission, shared by submit and result. */
export function renderSubmission(view: SubmitView): string {
  // The ack uses `submission`; the view returned by GET uses `id`.
  const id = "submission" in view ? view.submission : view.id;
  if (view.status === "queued") {
    const position = "position" in view ? ` #${view.position}` : "";
    return `submission ${id}: queued${position}`;
  }
  const lines: string[] = [];
  if (view.status === "checking") {
    lines.push(`submission ${id}: checking`);
    return lines.join("\n");
  }
  const attempt = "attempt" in view ? view.attempt : id;
  const exitCode = view.exitCode ?? 0;
  lines.push(`verdict: ${view.status}`, `submission ${id}`);
  lines.push(`exit code: ${exitCode}${view.timedOut ? " (timed out)" : ""}`);
  if (view.status === "rejected") {
    const reason = staleReason(view);
    if (reason !== undefined) lines.push(`stale: ${reason}`);
  }
  if (view.outputTail && view.outputTail.length > 0) {
    lines.push("output tail:", indent(view.outputTail));
  } else if (view.status === "rejected") {
    lines.push(`output: (the check printed nothing; exit code ${exitCode})`);
  }
  if (view.commit !== undefined) lines.push(`commit: ${view.commit}`);
  lines.push(`points: ${view.points}`);
  if (view.status === "accepted") {
    lines.push("next: minga sync && minga next --wait 600");
  } else if (view.status === "rejected") {
    lines.push(`next: fix and run "minga submit ${attempt} ..." again, or ` +
      `"minga release ${attempt} --handoff \\"...\\""`);
  }
  return lines.join("\n");
}

/** 0 while pending or accepted, 2 when the project's check rejected the work. */
export function submissionExitCode(view: { status?: string }): number {
  return view.status === "rejected" ? 2 : 0;
}

export async function submitCommand(client: Client, input: SubmitInput): Promise<CommandResult<SubmitView>> {
  if (input.files.length === 0) throw new Error("submit needs at least one file");
  const files = readSubmissionFiles(input.root ?? process.cwd(), input.files);
  const queued = await client.submit({
    attempt: input.attempt,
    claim: input.claim,
    message: input.message,
    files,
    ...(input.model !== undefined ? { model: input.model } : {}),
  });

  const progress = `queued ${queued.submission} (#${queued.position} in line)`;
  input.onProgress?.(progress);
  if (input.wait === false) return { text: renderSubmission(queued), data: queued };

  const final = await waitForSubmission(client, queued.submission, input.onProgress);
  return { text: renderSubmission(final), data: final };
}

export interface ResultInput {
  submission: string;
  wait?: boolean;
  onProgress?: (line: string) => void;
}

export async function resultCommand(client: Client, input: ResultInput): Promise<CommandResult<SubmissionView>> {
  const id = input.submission;
  if (!/^S-\d+$/.test(id)) throw new Error(`result needs a submission id like S-1, got "${id}"`);
  const view = input.wait === true
    ? await waitForSubmission(client, id, input.onProgress)
    : await client.submission(id, 0);
  return { text: renderSubmission(view), data: view };
}

// ---------------------------------------------------------------- other verbs

export interface BeatInput {
  attempt: string;
  model?: string;
  approach?: string;
  /** Replace the attempt's declared paths (a pivot) when non-empty. */
  paths?: string[];
}

/** News since the previous beat, kept compact so it fits in a terminal. */
export function renderBeatNews(news: BeatNews): string {
  const lines: string[] = [];
  if (news.taskStatus !== "open") lines.push(`task status: ${news.taskStatus}`);
  for (const note of news.notes) {
    lines.push(`note ${note.id} (agent-written) ${note.kind}: ${note.text}`);
  }
  for (const other of news.others) {
    const approach = other.approach.length > 0 ? ` — ${other.approach}` : "";
    const paths = other.paths && other.paths.length > 0 ? ` [paths: ${other.paths.join(", ")}]` : "";
    lines.push(`other ${other.attempt} ${other.agent} ${other.role}${approach}${paths}`);
  }
  for (const c of news.conflicts) {
    lines.push(`conflict: ${c.path} also declared by ${c.attempt} on ${c.task}`);
  }
  return lines.join("\n");
}

export async function beatCommand(client: Client, input: BeatInput): Promise<CommandResult<BeatResponse>> {
  const response = await client.beat({
    attempt: input.attempt,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.approach !== undefined ? { approach: input.approach } : {}),
    ...(input.paths !== undefined && input.paths.length > 0 ? { paths: input.paths } : {}),
  });
  const lines = [`lease until ${response.leaseUntil}`];
  if (response.news) lines.push(renderBeatNews(response.news));
  return { text: lines.join("\n"), data: response };
}

export interface NoteInput {
  task: string;
  kind: NoteKind;
  text: string;
  replyTo?: string;
  to?: string;
}

export async function noteCommand(client: Client, input: NoteInput): Promise<CommandResult<NoteResponse>> {
  if (input.text.trim().length === 0) throw new Error("note needs some text");
  const response = await client.note({
    task: input.task,
    kind: input.kind,
    text: input.text,
    ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
    ...(input.to !== undefined ? { to: input.to } : {}),
  });
  const where = [
    `on ${response.note.task}`,
    ...(response.note.replyTo !== undefined ? [`reply to ${response.note.replyTo}`] : []),
    ...(response.note.to !== undefined ? [`to ${response.note.to}`] : []),
  ].join(", ");
  return {
    text: `note ${response.note.id} added ${where} (${response.note.kind})`,
    data: response,
  };
}

export interface ReleaseInput {
  attempt: string;
  handoff?: string;
  reason?: ReleaseReason;
}

export async function releaseCommand(client: Client, input: ReleaseInput): Promise<CommandResult<ReleaseResponse>> {
  const response = await client.release({
    attempt: input.attempt,
    ...(input.handoff !== undefined ? { handoff: input.handoff } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  });
  const text = [
    input.handoff !== undefined ? `released ${input.attempt} with a hand-off note` : `released ${input.attempt}`,
    ...(input.reason !== undefined ? [`reason: ${input.reason}`] : []),
  ].join("\n");
  return { text, data: response };
}

export interface ProposeInput {
  kind: ProposalKind;
  task: TaskId | null;
  title?: string;
  body?: string;
  evidence?: string;
}

export async function proposeCommand(client: Client, input: ProposeInput): Promise<CommandResult<ProposeResponse>> {
  if (input.kind === "new_task" && (!input.title || input.title.trim().length === 0)) {
    throw new Error("propose task needs --title");
  }
  if (input.kind === "impossible") {
    if (!input.task) throw new Error("propose impossible needs a task id");
    if (!input.evidence || input.evidence.trim().length === 0) {
      throw new Error("propose impossible needs --evidence");
    }
  }
  const response = await client.propose({
    kind: input.kind,
    task: input.task,
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
  });
  const where = input.kind === "new_task"
    ? `new task under ${input.task ?? "root"}`
    : `impossible ${input.task ?? ""}`.trimEnd();
  const lines = [`proposal ${response.proposal} (${where})`];
  if (response.duplicateOf) {
    const duplicate = response.duplicateOf.proposal
      ? `duplicate of ${response.duplicateOf.proposal} (your vote was recorded)`
      : response.duplicateOf.task
        ? `duplicate of open task ${response.duplicateOf.task}`
        : "duplicate";
    lines.push(duplicate);
  }
  if (response.decided) {
    lines.push(`decided: ${response.decided.accepted ? "accepted" : "rejected"} by ${response.decided.by}`);
  }
  return { text: lines.join("\n"), data: response };
}

export interface VoteInput {
  proposal: ProposalId;
  approve: boolean;
}

export async function voteCommand(client: Client, input: VoteInput): Promise<CommandResult<VoteResponse>> {
  const response = await client.vote({ proposal: input.proposal, approve: input.approve });
  const lines = [`voted ${input.approve ? "yes" : "no"} on ${response.proposal}`];
  if (response.decided) {
    lines.push(`decided: ${response.decided.accepted ? "accepted" : "rejected"} by ${response.decided.by}`);
  }
  return { text: lines.join("\n"), data: response };
}

// ---------------------------------------------------------------- reads

export interface StatusData {
  agent: AgentId;
  project: ProjectInfo;
  /** Last assignment from `next`, persisted in .minga/agent.json. */
  assignment?: SessionIdentity["lastAssignment"];
  /** Last submission from `submit`, checked live on `status`. */
  submission?: SubmissionView;
  /** Where the last attempt stands on the server (GET /api/attempt). */
  attempt?: AttemptView;
}

/** Minutes left on a lease, for an agent that lost context. */
function leaseText(leaseUntil: string): string {
  const ms = Date.parse(leaseUntil) - Date.now();
  if (!Number.isFinite(ms)) return leaseUntil;
  return ms > 0 ? `${Math.ceil(ms / 60_000)}m left` : "expired";
}

export async function statusCommand(client: Client, identity: SessionIdentity): Promise<CommandResult<StatusData>> {
  const project = await client.project();
  const data: StatusData = { agent: identity.agent, project };
  const lines = [
    `project: ${project.name}`,
    `goal: ${project.goal}`,
    `scope: ${project.scope}`,
    `check: ${project.check}`,
    `paths: ${project.paths.join(", ")}`,
    `rules: ${formatRules(project.rules)}`,
    `your agent: ${identity.agent}`,
  ];

  const assignment = identity.lastAssignment;
  if (assignment) {
    data.assignment = assignment;
    let view: AttemptView | undefined;
    try { view = await client.attempt(assignment.attempt); } catch { view = undefined; }
    const head = `attempt: ${assignment.attempt} (${assignment.role}) on ${assignment.task}`;
    if (view === undefined) {
      lines.push(`${head} — lease ${leaseText(assignment.leaseUntil)} (server state unavailable)`);
    } else {
      data.attempt = view;
      lines.push(`${head} — ${attemptText(view)}`);
    }
  }

  if (identity.lastSubmission) {
    try {
      const view = await client.submission(identity.lastSubmission, 0);
      const position = view.status === "queued" && view.position !== undefined ? ` #${view.position}` : "";
      lines.push(`submission: ${view.id} ${view.status}${position}`);
      data.submission = view;
    } catch {
      lines.push(`submission: ${identity.lastSubmission} (unavailable)`);
    }
  }

  return { text: lines.join("\n"), data };
}

/** One line on where an attempt stands, from GET /api/attempt. */
export function attemptText(view: AttemptView): string {
  if (view.state === "live") return `live, lease ${leaseText(view.leaseUntil)}`;
  if (view.state === "expired") return "lease expired; run minga next --wait 600 for a new assignment";
  const by = view.closedBy;
  if (view.endReason === "task_closed") {
    const who = by ? ` by ${by.submission ?? "a decision"} from ${by.agent}${by.model ? ` (${by.model})` : ""}` : "";
    return `ended: ${view.task} was ${view.taskStatus}${who}; run minga sync, then minga next --wait 600`;
  }
  return `ended (${view.endReason ?? "closed"}); run minga sync, then minga next --wait 600`;
}

export async function boardCommand(client: Client): Promise<CommandResult<LeaderboardResponse>> {
  const leaderboard = await client.leaderboard();
  const rows = leaderboard.agents.slice(0, 10);
  const header = ["#", "agent", "model", "harness", "points", "accepted"];
  const cells = rows.map((row, index) => [
    String(index + 1),
    row.agent,
    row.model,
    row.harness,
    String(row.points),
    `${row.accepted}/${row.submissions}`,
  ]);
  const widths = header.map((name, column) =>
    Math.max(name.length, ...cells.map((row) => (row[column] ?? "").length)),
  );
  const render = (row: string[]): string =>
    row.map((cell, column) => cell.padEnd(widths[column] ?? cell.length)).join("  ").trimEnd();
  const text = rows.length === 0
    ? "no agents on the leaderboard yet"
    : [render(header), ...cells.map(render)].join("\n");
  return { text, data: leaderboard };
}

// ---------------------------------------------------------------- tasks overview

export interface TasksInput {
  /** Show only open tasks (areas included); the footer always reports open leaves. */
  openOnly?: boolean;
}

/** Render a compact tree: status, live attempts, points and title, indented by parent. */
export function tasksCommand(client: Client, input: TasksInput = {}): Promise<CommandResult<TasksResponse>> {
  return client.tasks().then((overview) => ({ text: renderTasks(overview, input), data: overview }));
}

/** One task line: status first, `N live` only when the task is actually open. */
export function renderTaskLine(
  task: TasksResponse["tasks"][number],
  depth = 0,
  area = false,
): string {
  const status = task.status === "open" && task.live > 0
    ? `open · ${task.live} live`
    : task.status;
  const line = `${task.id}  ${status.padEnd(10)}  ${task.points} pts  ${task.title}${area ? " [area]" : ""}`;
  return `${"  ".repeat(depth)}${line}`;
}

export function renderTasks(overview: TasksResponse, input: TasksInput = {}): string {
  const byId = new Map(overview.tasks.map((t) => [t.id, t]));
  const children = new Map<string | null, typeof overview.tasks>();
  for (const t of overview.tasks) {
    const parent = t.parent && byId.has(t.parent) ? t.parent : null;
    const list = children.get(parent) ?? [];
    list.push(t);
    children.set(parent, list);
  }

  const lines: string[] = [];
  const seen = new Set<string>();
  const visit = (parent: string | null, depth: number): void => {
    for (const t of children.get(parent) ?? []) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      if (!input.openOnly || t.status === "open") {
        lines.push(renderTaskLine(t, depth, byId.get(t.id)?.leaf === false));
      }
      visit(t.id, depth + 1);
    }
  };
  visit(null, 0);
  // Orphans of a cycle still deserve a line.
  for (const t of overview.tasks) {
    if (!seen.has(t.id)) {
      seen.add(t.id);
      if (!input.openOnly || t.status === "open") {
        lines.push(renderTaskLine(t, 0, !t.leaf));
      }
    }
  }

  const footer = overview.done ? "project finished" : `open leaf tasks: ${overview.open}`;
  return lines.length > 0 ? [...lines, "", footer].join("\n") : footer;
}

// ---------------------------------------------------------------- head

export interface HeadKeygenOutput {
  identity: HeadIdentity;
  result: CommandResult<{ agent: AgentId; head: string }>;
}

/** Reuses `existing` when present so keygen is idempotent. */
export function headKeygenCommand(existing: HeadIdentity | null, url?: string): HeadKeygenOutput {
  const keys = existing
    ? { publicKey: existing.publicKey, privateKey: existing.privateKey }
    : generateKeyPair();
  const identity: HeadIdentity = {
    agent: existing?.agent ?? agentIdFromPublicKey(keys.publicKey),
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
  };
  const resolvedUrl = url ?? existing?.url;
  if (resolvedUrl !== undefined) identity.url = resolvedUrl;

  const head = formatHeadKey(identity.publicKey);
  const text = [
    `${existing ? "using the existing" : "created a new"} head key (agent ${identity.agent})`,
    "",
    "Add this line to project.toml:",
    `head = "${head}"`,
  ].join("\n");
  return { identity, result: { text, data: { agent: identity.agent, head } } };
}

export interface HeadPostInput {
  title: string;
  body: string;
  parent: TaskId | null;
  points?: number;
  paths?: string[];
}

export async function headPostCommand(
  client: Client,
  input: HeadPostInput,
): Promise<CommandResult<HeadPostResponse>> {
  const response = await client.headPost({
    title: input.title,
    body: input.body,
    parent: input.parent,
    ...(input.points !== undefined ? { points: input.points } : {}),
    ...(input.paths !== undefined && input.paths.length > 0 ? { paths: input.paths } : {}),
  });
  return { text: `posted task ${response.task}`, data: response };
}

export interface HeadDecideInput {
  proposal: ProposalId;
  accept: boolean;
  reason?: string;
}

export async function headDecideCommand(
  client: Client,
  input: HeadDecideInput,
): Promise<CommandResult<HeadDecideResponse>> {
  const response = await client.headDecide({
    proposal: input.proposal,
    accept: input.accept,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  });
  const lines = [`${input.proposal} ${input.accept ? "accepted" : "rejected"}`];
  if (response.task !== undefined) lines.push(`task: ${response.task}`);
  return { text: lines.join("\n"), data: response };
}

export async function headRuleCommand(
  client: Client,
  rules: Partial<Rules>,
): Promise<CommandResult<HeadRuleResponse>> {
  const response = await client.headRule({ rules });
  return { text: formatRules(response.rules), data: response };
}

export interface HeadBanInput {
  agent: AgentId;
  reason: string;
}

export async function headBanCommand(
  client: Client,
  input: HeadBanInput,
): Promise<CommandResult<{ ok: true }>> {
  if (input.reason.trim().length === 0) throw new Error("head ban needs --reason");
  const response = await client.headBan({ agent: input.agent, reason: input.reason });
  return { text: `banned ${input.agent}`, data: response };
}

export interface HeadNoteInput {
  task: TaskId;
  text: string;
  kind?: NoteKind;
}

/** Leaves a note as the head; defaults to the server's `result` kind. */
export async function headNoteCommand(
  client: Client,
  input: HeadNoteInput,
): Promise<CommandResult<HeadNoteResponse>> {
  const response = await client.headNote({
    task: input.task,
    text: input.text,
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
  });
  return {
    text: `note ${response.note.id} on ${input.task} (${response.note.kind})`,
    data: response,
  };
}

export interface HeadCloseInput {
  task: TaskId;
  status: "withdrawn" | "impossible" | "solved";
  reason?: string;
}

export async function headCloseCommand(
  client: Client,
  input: HeadCloseInput,
): Promise<CommandResult<{ ok: true }>> {
  const response = await client.headClose({
    task: input.task,
    status: input.status,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  });
  return { text: `closed ${input.task} as ${input.status}`, data: response };
}

export interface HeadLeadInput extends HeadLeadRequest {}

/** Grant or revoke an area lead (head only). */
export async function headLeadCommand(
  client: Client,
  input: HeadLeadInput,
): Promise<CommandResult<HeadLeadResponse>> {
  const response = await client.headLead(input);
  return {
    text: `${input.grant ? "granted" : "revoked"} lead of ${input.area} to ${input.agent}`,
    data: response,
  };
}

/** Area leads post tasks under an area they lead (same body shape as head post). */
export interface LeadPostInput extends HeadPostInput {}

export async function leadPostCommand(
  client: Client,
  input: LeadPostInput,
): Promise<CommandResult<HeadPostResponse>> {
  const response = await client.leadPost({
    title: input.title,
    body: input.body,
    parent: input.parent,
    ...(input.points !== undefined ? { points: input.points } : {}),
    ...(input.paths !== undefined && input.paths.length > 0 ? { paths: input.paths } : {}),
  });
  return { text: `posted task ${response.task}`, data: response };
}

export interface LeadDecideInput {
  proposal: ProposalId;
  accept: boolean;
  reason?: string;
}

export async function leadDecideCommand(
  client: Client,
  input: LeadDecideInput,
): Promise<CommandResult<HeadDecideResponse>> {
  const response = await client.leadDecide({
    proposal: input.proposal,
    accept: input.accept,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  });
  const lines = [`${input.proposal} ${input.accept ? "accepted" : "rejected"}`];
  if (response.task !== undefined) lines.push(`task: ${response.task}`);
  return { text: lines.join("\n"), data: response };
}
