/**
 * Module contracts. Each worker implements exactly the exports listed for its
 * module, with these names and signatures, so modules written in parallel fit
 * together. The server (src/server) is the only place that wires them.
 *
 * Workers must not edit this file. If a contract is wrong, say so in your
 * final report instead of working around it.
 */
import type {
  AgentId, AttemptId, Leaderboard, MingaEvent, NewEvent, ProjectConfig, ProposalId,
  Role, Rules, State, TaskId,
} from "./types.ts";

// ======================================================================
// src/log/store.ts — append-only event log on bun:sqlite
// ======================================================================
export interface EventStore {
  /** Stamps seq (last+1) and at (now, or `at` if given), persists, notifies subscribers, returns the stored event. */
  append(event: NewEvent, at?: Date): MingaEvent;
  /** Events with seq > `after`, ascending, at most `limit` (default: all). */
  since(after: number, limit?: number): MingaEvent[];
  /** Seq of the newest event, 0 when empty. */
  head(): number;
  /** Called synchronously after each append. Returns an unsubscribe function. */
  subscribe(listener: (event: MingaEvent) => void): () => void;
  close(): void;
}
/** `path` may be ":memory:". Creates the schema if missing. WAL mode for files. */
export type OpenEventStore = (path: string) => EventStore;

// ======================================================================
// src/log/reducer.ts — state is a fold over events (pure, no I/O)
// ======================================================================
export type InitialState = (rules: Rules) => State;
/** Applies one event. Mutates `state` in place and returns it. Must tolerate events in seq order only; throws on seq gaps. */
export type Reduce = (state: State, event: MingaEvent) => State;
/** initialState(rules) folded over all events. */
export type Replay = (rules: Rules, events: Iterable<MingaEvent>) => State;
/** Next free id for a prefix, e.g. nextId(state, "task") -> "T-13". Does not mutate. */
export type NextId = (state: State, kind: "task" | "attempt" | "note" | "submission" | "proposal") => string;
/** An attempt is live when it has not ended and leaseUntil > now. */
export type IsLive = (state: State, attempt: AttemptId, now: Date) => boolean;
/** Live attempt ids on a task. */
export type LiveAttempts = (state: State, task: TaskId, now: Date) => AttemptId[];
export type ComputeLeaderboard = (state: State) => Leaderboard;

// ======================================================================
// src/project/config.ts — project.toml
// ======================================================================
/** Parses TOML text (Bun.TOML.parse), applies defaults, validates. Throws Error with a readable message naming the bad key. */
export type ParseProject = (tomlText: string) => ProjectConfig;
/** Reads `<dir>/project.toml`. */
export type LoadProject = (dir: string) => Promise<ProjectConfig>;
/** True when a repo-relative POSIX path matches one of cfg.paths and contains no "..", no leading "/", no backslash. */
export type PathAllowed = (cfg: ProjectConfig, path: string) => boolean;
/** Parses "head" | "votes:N" | "head-or-votes:N". Throws on anything else. */
export type ParseAcceptPolicy = (text: string) => Rules["accept"];

// ======================================================================
// src/sched/scheduler.ts — pure decisions, no I/O
// ======================================================================
export interface PickInput {
  state: State;
  agent: AgentId;
  now: Date;
  /** Uniform [0,1). Defaults to Math.random. Tests pass a seeded one. */
  rng?: () => number;
}
export interface Pick { task: TaskId; role: Role }
/**
 * Chooses a task and role for `agent`, or null when nothing is available.
 * Candidates: status "open", no children (leaf), live attempts < rules.width,
 * agent holds no live attempt on it, agent not banned, agent below rules.maxAttemptsPerAgent.
 * Prefer, in order: tasks with no live attempt from the same model family
 * (family = model string up to its first "-", "/" or ":", lowercased), tasks with
 * zero live attempts, tasks the agent has not failed before, older tasks. Small
 * randomness (via rng) breaks ties. Role: weighted random over rules.roles.
 */
export type PickTask = (input: PickInput) => Pick | null;
/** Model family as defined above. */
export type ModelFamily = (model: string) => string;
/** Attempts that have not ended and whose leaseUntil <= now. */
export type ExpiredAttempts = (state: State, now: Date) => AttemptId[];
/**
 * Applies rules.accept to an undecided proposal using its votes.
 * Only votes from agents with accepted >= 1 and not banned count, and never the proposer's own vote.
 * mode "head": always null (only the head decides).
 * mode "votes" / "head-or-votes": accepted when approvals >= N; rejected when rejections >= N; else null.
 */
export type DecideByVotes = (state: State, proposal: ProposalId) => { accepted: boolean } | null;

// ======================================================================
// src/verify/runner.ts and src/verify/gitops.ts — the only code that touches git
// ======================================================================
export interface CheckInput {
  /** The maintainer's repository (contains project.toml). Its working tree must never be modified. */
  repoDir: string;
  branch: string;
  /** Repo-relative POSIX path -> full new file content (UTF-8). Already validated with PathAllowed. */
  files: Record<string, string>;
  /** cfg.check. "{files}" is replaced with the shell-quoted, space-separated paths. */
  command: string;
  timeoutSeconds: number;
  /** Bytes of combined output to keep from the end. Default 8000. */
  maxOutput?: number;
}
export interface CheckResult {
  ok: boolean;
  exitCode: number;
  timedOut: boolean;
  outputTail: string;
  durationMs: number;
}
/** Checks out `branch` HEAD into a fresh temp worktree, writes `files`, runs `command` there (shell), always removes the worktree. */
export type RunCheck = (input: CheckInput) => Promise<CheckResult>;

export interface CommitInput {
  repoDir: string;
  branch: string;
  files: Record<string, string>;
  /** First line of the commit message. */
  message: string;
  /** Appended as git trailers, e.g. { "Agent-Id": "...", "Agent-Model": "...", "Minga-Task": "T-3" }. */
  trailers: Record<string, string>;
  /** Commit author/committer name. */
  author: string;
}
/**
 * Commits `files` on top of `branch` using plumbing only (temp GIT_INDEX_FILE,
 * hash-object, update-index, write-tree, commit-tree, update-ref with the old
 * sha for compare-and-swap). Never touches the working tree or the real index.
 * Retries the CAS a few times if the branch moved. Returns the new commit sha.
 */
export type CommitAccepted = (input: CommitInput) => Promise<string>;
