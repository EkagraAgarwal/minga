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
  BeatResponse, JoinResponse, LeaderboardResponse, NextResponse, NoteResponse, ProposeResponse,
  ProjectInfo, ReleaseResponse, SubmitResponse, VoteResponse, HeadDecideResponse, HeadRuleResponse,
} from "../core/protocol.ts";
import type {
  AcceptPolicy, AgentId, Claim, NoteKind, ProposalId, ProposalKind, Rules, TaskId,
} from "../core/types.ts";
import { NOTE_KINDS } from "../core/types.ts";
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
  /** Agent command, "head", "help", or "" when nothing was given. */
  command: string;
  /** head subcommand: keygen | post | decide | rule | ban | close | help. */
  action?: string;
  options: Record<string, ParsedValue>;
  positionals: string[];
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
  },
  beat: {
    model: { type: "string" },
    approach: { type: "string" },
  },
  note: {},
  submit: {
    claim: { type: "string" },
    message: { type: "string", short: "m" },
    root: { type: "string" },
    model: { type: "string" },
  },
  release: {
    handoff: { type: "string" },
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
};

const HEAD_OPTIONS: Record<string, OptionSet> = {
  keygen: {},
  post: {
    title: { type: "string" },
    body: { type: "string" },
    under: { type: "string" },
    points: { type: "string" },
  },
  decide: {
    reason: { type: "string" },
  },
  rule: {},
  ban: {
    reason: { type: "string" },
  },
  close: {
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
  const parsed = parseArgs({
    args,
    options: { ...COMMON_OPTIONS, ...extra },
    allowPositionals: true,
    strict: true,
  }) as {
    values: Record<string, string | boolean | (string | boolean)[] | undefined>;
    positionals: string[];
  };
  return { options: cleanValues(parsed.values), positionals: parsed.positionals };
}

export function parseCli(argv: string[]): ParsedCli {
  const first = argv[0];
  if (first === undefined) return { command: "", options: {}, positionals: [] };
  if (first === "help" || first === "--help" || first === "-h") {
    return { command: "help", options: {}, positionals: argv.slice(1) };
  }
  if (first.startsWith("-")) throw new Error(`unexpected option: ${first} (try "minga help")`);

  if (first === "head") {
    const action = argv[1];
    if (action === undefined) return { command: "head", options: {}, positionals: [] };
    if (action === "help" || action === "--help" || action === "-h") {
      return { command: "head", action: "help", options: {}, positionals: argv.slice(2) };
    }
    const spec = HEAD_OPTIONS[action];
    if (!spec) throw new Error(`unknown head action: ${action} (try "minga head --help")`);
    const { options, positionals } = parseTail(argv.slice(2), spec);
    return { command: "head", action, options, positionals };
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
    `maxAttemptsPerAgent=${rules.maxAttemptsPerAgent}`,
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

  const lines = [
    `${response.rejoin ? "rejoined" : "joined"} ${response.project.name} as agent ${response.agent}`,
    `goal: ${response.project.goal}`,
    `scope: ${response.project.scope}`,
    `rules: ${formatRules(response.project.rules)}`,
  ];
  if (response.live.length > 0) lines.push(`live attempts from before: ${response.live.join(", ")}`);
  return { identity, result: { text: lines.join("\n"), data: response } };
}

// ---------------------------------------------------------------- the loop

export interface NextInput {
  model?: string;
  approach?: string;
}

export async function nextCommand(client: Client, input: NextInput = {}): Promise<CommandResult<NextResponse>> {
  const response = await client.next({
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.approach !== undefined ? { approach: input.approach } : {}),
  });
  const a = response.assignment;
  if (!a) {
    const wait = response.retryAfterSeconds ?? 60;
    return { text: `nothing to do, retry in ${wait}s`, data: response };
  }

  const lines = [
    `attempt   ${a.attempt}`,
    `role      ${a.role}`,
    `lease     ${a.leaseUntil}`,
    `task      ${a.task.id}  ${a.task.title}  (${a.task.points} points)`,
  ];
  if (a.path.length > 0) {
    lines.push(`path      ${a.path.map((p) => `${p.id} ${p.title}`).join(" > ")}`);
  }
  lines.push("body:", indent(a.task.body.length > 0 ? a.task.body : "(empty)"));
  if (a.handoff) {
    lines.push(`handoff   ${a.handoff.id} (${a.handoff.kind}) ${a.handoff.text}`);
  }
  if (a.notes.length > 0) {
    lines.push("notes:");
    for (const note of a.notes) lines.push(`  ${note.id} ${note.agent} ${note.kind}: ${note.text}`);
  }
  if (a.others.length > 0) {
    lines.push("others on this task:");
    for (const other of a.others) {
      const approach = other.approach.length > 0 ? ` — ${other.approach}` : "";
      lines.push(`  ${other.attempt} ${other.agent} ${other.model} ${other.role}${approach}`);
    }
  }
  return { text: lines.join("\n"), data: response };
}

export interface BeatInput {
  attempt: string;
  model?: string;
  approach?: string;
}

export async function beatCommand(client: Client, input: BeatInput): Promise<CommandResult<BeatResponse>> {
  const response = await client.beat({
    attempt: input.attempt,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.approach !== undefined ? { approach: input.approach } : {}),
  });
  return { text: `lease until ${response.leaseUntil}`, data: response };
}

export interface NoteInput {
  task: string;
  kind: NoteKind;
  text: string;
}

export async function noteCommand(client: Client, input: NoteInput): Promise<CommandResult<NoteResponse>> {
  if (input.text.trim().length === 0) throw new Error("note needs some text");
  const response = await client.note({ task: input.task, kind: input.kind, text: input.text });
  return {
    text: `note ${response.note.id} added on ${response.note.task} (${response.note.kind})`,
    data: response,
  };
}

// ---------------------------------------------------------------- submit

export interface SubmitInput {
  attempt: string;
  claim: Claim;
  message: string;
  /** Paths as given on the command line, relative to `root` unless absolute. */
  files: string[];
  root?: string;
  model?: string;
}

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

export async function submitCommand(client: Client, input: SubmitInput): Promise<CommandResult<SubmitResponse>> {
  if (input.files.length === 0) throw new Error("submit needs at least one file");
  const files = readSubmissionFiles(input.root ?? process.cwd(), input.files);
  const response = await client.submit({
    attempt: input.attempt,
    claim: input.claim,
    message: input.message,
    files,
    ...(input.model !== undefined ? { model: input.model } : {}),
  });

  const lines = [
    `submission ${response.submission}`,
    `ok: ${response.ok}`,
    `exit code: ${response.exitCode}${response.timedOut ? " (timed out)" : ""}`,
  ];
  if (response.commit !== undefined) lines.push(`commit: ${response.commit}`);
  lines.push(`points: ${response.points}`, `task status: ${response.taskStatus}`);
  if (!response.ok) {
    lines.push("output tail:", indent(response.outputTail.length > 0 ? response.outputTail : "(empty)"));
  }
  return { text: lines.join("\n"), data: response };
}

export interface ReleaseInput {
  attempt: string;
  handoff?: string;
}

export async function releaseCommand(client: Client, input: ReleaseInput): Promise<CommandResult<ReleaseResponse>> {
  const response = await client.release({
    attempt: input.attempt,
    ...(input.handoff !== undefined ? { handoff: input.handoff } : {}),
  });
  const text = input.handoff !== undefined
    ? `released ${input.attempt} with a hand-off note`
    : `released ${input.attempt}`;
  return { text, data: response };
}

// ---------------------------------------------------------------- proposals & votes

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
}

export async function statusCommand(client: Client, agent: AgentId): Promise<CommandResult<StatusData>> {
  const project = await client.project();
  const text = [
    `project: ${project.name}`,
    `goal: ${project.goal}`,
    `scope: ${project.scope}`,
    `check: ${project.check}`,
    `paths: ${project.paths.join(", ")}`,
    `rules: ${formatRules(project.rules)}`,
    `your agent: ${agent}`,
  ].join("\n");
  return { text, data: { agent, project } };
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
}

export async function headPostCommand(
  client: Client,
  input: HeadPostInput,
): Promise<CommandResult<{ task: TaskId }>> {
  const response = await client.headPost({
    title: input.title,
    body: input.body,
    parent: input.parent,
    ...(input.points !== undefined ? { points: input.points } : {}),
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
