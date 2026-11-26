/**
 * On-disk identities for the CLI kit.
 *
 *   <dir>/.minga/agent.json  the volunteer agent's session identity
 *   <dir>/.minga/head.json   the maintainer's head-agent identity
 *
 * `dir` is --dir, else $MINGA_DIR, else the current working directory. Agent
 * identity lookup walks up from there to the nearest ancestor holding one,
 * the way git finds .git; writes still go to an explicit directory.
 * node:fs only: this module is bundled into the kit for plain Node.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AgentId } from "../core/types.ts";
import type { KeyPair } from "../identity/keys.ts";

/** The last work `minga next` handed out, kept so `status` can recover context. */
export interface LastAssignment {
  attempt: string;
  role: string;
  leaseUntil: string;
  task: string;
}

export interface SessionIdentity {
  /** Coordinator base URL used at join time. */
  url: string;
  agent: AgentId;
  publicKey: string;
  privateKey: string;
  model: string;
  harness: string;
  owner?: string;
  /** Last assignment from `next`. */
  lastAssignment?: LastAssignment;
  /** Last submission id from `submit`. */
  lastSubmission?: string;
  /** Files of the last accepted submission, so `minga sync` can drop leftovers. */
  lastAccepted?: { submission: string; files: string[] };
}

export interface HeadIdentity {
  agent: AgentId;
  publicKey: string;
  privateKey: string;
  /** Coordinator base URL, when keygen was told where the project lives. */
  url?: string;
}

const MINGA_DIR = ".minga";

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw new Error(`cannot read ${path}: ${(err as Error).message}`);
  }
}

function readObject(path: string): Record<string, unknown> | null {
  const text = readText(path);
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, key: string, path: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} is missing "${key}"`);
  }
  return value;
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" ? value : undefined;
}

function writeObject(path: string, value: unknown): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    // No-op where the platform does not support POSIX modes.
    chmodSync(path, 0o600);
  } catch {
    // ignore
  }
  return path;
}

/** Absolute directory that holds .minga/, from --dir, $MINGA_DIR or cwd. */
export function resolveDir(dir?: string): string {
  return resolve(dir ?? process.env.MINGA_DIR ?? process.cwd());
}

export function agentPath(dir: string): string {
  return join(dir, MINGA_DIR, "agent.json");
}

export function headPath(dir: string): string {
  return join(dir, MINGA_DIR, "head.json");
}

/**
 * Nearest directory at or above `dir` holding .minga/agent.json, like git
 * finding .git. When none exists, returns the starting directory unchanged so
 * `join` can create the identity there.
 */
export function resolveAgentDir(dir?: string): string {
  const start = resolveDir(dir);
  let current = start;
  for (;;) {
    if (existsSync(agentPath(current))) return current;
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

/** null when the file does not exist; throws when it is unreadable or malformed. */
export function readAgent(dir: string): SessionIdentity | null {
  const path = agentPath(resolveAgentDir(dir));
  const obj = readObject(path);
  if (!obj) return null;
  const identity: SessionIdentity = {
    url: requireString(obj, "url", path),
    agent: requireString(obj, "agent", path),
    publicKey: requireString(obj, "publicKey", path),
    privateKey: requireString(obj, "privateKey", path),
    model: optionalString(obj, "model") ?? "",
    harness: optionalString(obj, "harness") ?? "",
  };
  const owner = optionalString(obj, "owner");
  if (owner !== undefined) identity.owner = owner;
  const raw = obj.lastAssignment;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const a = raw as Record<string, unknown>;
    const attempt = optionalString(a, "attempt");
    const role = optionalString(a, "role");
    const leaseUntil = optionalString(a, "leaseUntil");
    const task = optionalString(a, "task");
    if (attempt && role && leaseUntil && task) {
      identity.lastAssignment = { attempt, role, leaseUntil, task };
    }
  }
  const lastSubmission = optionalString(obj, "lastSubmission");
  if (lastSubmission !== undefined) identity.lastSubmission = lastSubmission;
  const accepted = obj.lastAccepted;
  if (accepted && typeof accepted === "object" && !Array.isArray(accepted)) {
    const entry = accepted as Record<string, unknown>;
    const submission = optionalString(entry, "submission");
    const files = entry.files;
    if (submission && Array.isArray(files) && files.every((f) => typeof f === "string")) {
      identity.lastAccepted = { submission, files: files as string[] };
    }
  }
  return identity;
}

export function writeAgent(dir: string, identity: SessionIdentity): string {
  const value: Record<string, unknown> = {
    url: identity.url,
    agent: identity.agent,
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
    model: identity.model,
    harness: identity.harness,
  };
  if (identity.owner !== undefined) value.owner = identity.owner;
  if (identity.lastAssignment !== undefined) value.lastAssignment = identity.lastAssignment;
  if (identity.lastSubmission !== undefined) value.lastSubmission = identity.lastSubmission;
  if (identity.lastAccepted !== undefined) value.lastAccepted = identity.lastAccepted;
  return writeObject(agentPath(dir), value);
}

export function readHead(dir: string): HeadIdentity | null {
  const path = headPath(dir);
  const obj = readObject(path);
  if (!obj) return null;
  const identity: HeadIdentity = {
    agent: requireString(obj, "agent", path),
    publicKey: requireString(obj, "publicKey", path),
    privateKey: requireString(obj, "privateKey", path),
  };
  const url = optionalString(obj, "url");
  if (url !== undefined) identity.url = url;
  return identity;
}

export function writeHead(dir: string, identity: HeadIdentity): string {
  const value: Record<string, unknown> = {
    agent: identity.agent,
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
  };
  if (identity.url !== undefined) value.url = identity.url;
  return writeObject(headPath(dir), value);
}

/** Signing keys for a stored identity. */
export function identityKeys(identity: SessionIdentity | HeadIdentity): KeyPair {
  return { publicKey: identity.publicKey, privateKey: identity.privateKey };
}
