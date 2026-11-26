/**
 * project.toml parsing and validation.
 *
 * The file is the only project-level configuration: what the check command is,
 * which paths a submission may touch, who the head agent is, and the scheduling
 * rules. Everything is validated here so no other module has to trust it.
 */
import { join } from "node:path";
import type {
  LoadProject,
  ParseAcceptPolicy,
  ParseProject,
  PathAllowed,
} from "../core/contracts.ts";
import type { ProjectConfig, Role, Rules, SeedTask } from "../core/types.ts";
import { ROLES } from "../core/types.ts";
import { parseHeadKey } from "../identity/keys.ts";

const DEFAULT_TIMEOUT_SECONDS = 600;
const DEFAULT_BRANCH = "main";
const DEFAULT_ACCEPT = "head-or-votes:3";

const DEFAULT_ROLES: Record<Role, number> = {
  explore: 2,
  build: 5,
  attack: 2,
  distill: 1,
  plan: 0,
};

const TOP_LEVEL_KEYS = new Set([
  "name",
  "goal",
  "scope",
  "check",
  "paths",
  "head",
  "check_timeout_seconds",
  "branch",
  "check_concurrency",
  "check_keep",
  "recheck",
  "rules",
  "task",
]);

const RECHECK_VALUES = new Set(["always", "on-overlap"]);

const RULE_KEYS = new Set([
  "width",
  "lease_minutes",
  "max_attempts_per_agent",
  "accept",
  "default_points",
  "roles",
]);

const TASK_KEYS = new Set(["title", "body", "key", "under", "points"]);

function fail(message: string): never {
  throw new Error(`project.toml: ${message}`);
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(obj: Record<string, unknown>, key: string, label = key): string {
  const value = obj[key];
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label} is required and must be a non-empty string`);
  }
  return value;
}

function optionalString(obj: Record<string, unknown>, key: string, label: string, fallback: string): string {
  const value = obj[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string") fail(`${label} must be a string`);
  return value;
}

function integerField(
  obj: Record<string, unknown>,
  key: string,
  label: string,
  fallback: number,
  min: number,
): number {
  const value = obj[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    fail(`${label} must be an integer >= ${min}`);
  }
  return value;
}

/** Parses "head" | "votes:N" | "head-or-votes:N". Throws on anything else. */
export const parseAcceptPolicy: ParseAcceptPolicy = (text) => {
  const trimmed = text.trim();
  if (trimmed === "head") return { mode: "head" };

  const match = /^(head-or-votes|votes):(\d+)$/.exec(trimmed);
  if (!match) {
    fail(`rules.accept must be "head", "votes:N" or "head-or-votes:N" (got "${text}")`);
  }
  const mode = match[1] as "votes" | "head-or-votes";
  const votes = Number(match[2]);
  if (!Number.isSafeInteger(votes) || votes < 1) {
    fail(`rules.accept threshold must be an integer >= 1 (got "${text}")`);
  }
  return { mode, votes };
};

function parseRoles(value: unknown): Record<Role, number> {
  const roles: Record<Role, number> = { ...DEFAULT_ROLES };
  if (value === undefined) return roles;
  if (!isTable(value)) fail("rules.roles must be a table");

  for (const key of Object.keys(value)) {
    if (!(ROLES as readonly string[]).includes(key)) {
      fail(`rules.roles.${key} is not a known role`);
    }
    const weight = value[key];
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0) {
      fail(`rules.roles.${key} must be a number >= 0`);
    }
    roles[key as Role] = weight;
  }

  if (!ROLES.some((role) => roles[role] > 0)) {
    fail("rules.roles must have at least one weight > 0");
  }
  return roles;
}

function parseRules(value: unknown): Rules {
  if (value === undefined) {
    return {
      width: 3,
      leaseMinutes: 45,
      maxAttemptsPerAgent: 1,
      accept: parseAcceptPolicy(DEFAULT_ACCEPT),
      defaultPoints: 10,
      roles: { ...DEFAULT_ROLES },
    };
  }
  if (!isTable(value)) fail("rules must be a table");

  for (const key of Object.keys(value)) {
    if (!RULE_KEYS.has(key)) fail(`rules.${key} is not a known key`);
  }

  const acceptText = optionalString(value, "accept", "rules.accept", DEFAULT_ACCEPT);
  return {
    width: integerField(value, "width", "rules.width", 3, 1),
    leaseMinutes: integerField(value, "lease_minutes", "rules.lease_minutes", 45, 1),
    maxAttemptsPerAgent: integerField(
      value,
      "max_attempts_per_agent",
      "rules.max_attempts_per_agent",
      1,
      1,
    ),
    accept: parseAcceptPolicy(acceptText),
    defaultPoints: integerField(value, "default_points", "rules.default_points", 10, 0),
    roles: parseRoles(value.roles),
  };
}

function parsePaths(value: unknown): string[] {
  if (!Array.isArray(value)) fail("paths is required and must be an array of globs");
  const paths: string[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      fail(`paths[${index}] must be a non-empty string glob`);
    }
    try {
      new Bun.Glob(entry);
    } catch {
      fail(`paths[${index}] is not a valid glob (got "${entry}")`);
    }
    paths.push(entry);
  });
  return paths;
}

/** Repo-relative, non-glob paths preserved between checks (build caches). */
function parseCheckKeep(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("check_keep must be an array of repo-relative paths");

  const kept: string[] = [];
  value.forEach((entry, index) => {
    const label = `check_keep[${index}]`;
    if (typeof entry !== "string" || entry.trim() === "") fail(`${label} must be a non-empty string`);
    if (/[*?\[\]]/.test(entry)) fail(`${label} must not contain glob characters`);
    if (entry.startsWith("/")) fail(`${label} must not start with "/"`);
    if (entry.includes("\\")) fail(`${label} must not contain a backslash`);

    const segments = entry.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      fail(`${label} must be a normalized repo-relative POSIX path`);
    }
    if (segments[0] === ".git" || segments[0] === ".minga") {
      fail(`${label} must not be inside .git or .minga`);
    }
    kept.push(entry);
  });
  return kept;
}

/** "on-overlap" (default) or "always". */
function parseRecheck(value: unknown): "always" | "on-overlap" {
  if (value === undefined) return "on-overlap";
  if (typeof value !== "string" || !RECHECK_VALUES.has(value)) {
    fail(`recheck must be "always" or "on-overlap"`);
  }
  return value as "always" | "on-overlap";
}

function parseHead(value: unknown): string {
  const head = requiredString({ head: value }, "head");
  try {
    parseHeadKey(head);
  } catch (error) {
    fail(`head is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  return head;
}

function parseTasks(value: unknown): SeedTask[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("task must be an array of tables ([[task]])");

  const tasks: SeedTask[] = [];
  const keys = new Set<string>();

  value.forEach((raw, index) => {
    if (!isTable(raw)) fail(`task[${index}] must be a table`);

    for (const key of Object.keys(raw)) {
      if (!TASK_KEYS.has(key)) fail(`task[${index}] has unknown key "${key}"`);
    }

    const title = requiredString(raw, "title", `task[${index}].title`);
    const body = optionalString(raw, "body", `task[${index}].body`, "");

    let key: string | undefined;
    if (raw.key !== undefined) {
      if (typeof raw.key !== "string" || raw.key.trim() === "") {
        fail(`task[${index}].key must be a non-empty string`);
      }
      if (keys.has(raw.key)) fail(`task[${index}].key "${raw.key}" is not unique`);
      key = raw.key;
    }

    let under: string | undefined;
    if (raw.under !== undefined) {
      if (typeof raw.under !== "string" || raw.under.trim() === "") {
        fail(`task[${index}].under must be a non-empty string`);
      }
      if (!keys.has(raw.under)) {
        fail(`task[${index}].under references unknown or later key "${raw.under}"`);
      }
      under = raw.under;
    }

    let points: number | undefined;
    if (raw.points !== undefined) {
      if (typeof raw.points !== "number" || !Number.isInteger(raw.points) || raw.points < 0) {
        fail(`task[${index}].points must be an integer >= 0`);
      }
      points = raw.points;
    }

    const task: SeedTask = { title, body };
    if (key !== undefined) task.key = key;
    if (under !== undefined) task.under = under;
    if (points !== undefined) task.points = points;
    tasks.push(task);
    if (key !== undefined) keys.add(key);
  });

  return tasks;
}

/** Parses TOML text, applies defaults, validates. */
export const parseProject: ParseProject = (tomlText) => {
  let parsed: object;
  try {
    parsed = Bun.TOML.parse(tomlText);
  } catch (error) {
    throw new Error(
      `project.toml: invalid TOML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isTable(parsed)) fail("document must be a table");

  for (const key of Object.keys(parsed)) {
    if (!TOP_LEVEL_KEYS.has(key)) fail(`unknown top-level key "${key}"`);
  }

  const config: ProjectConfig = {
    name: requiredString(parsed, "name"),
    goal: requiredString(parsed, "goal"),
    scope: requiredString(parsed, "scope"),
    check: requiredString(parsed, "check"),
    checkTimeoutSeconds: integerField(
      parsed,
      "check_timeout_seconds",
      "check_timeout_seconds",
      DEFAULT_TIMEOUT_SECONDS,
      1,
    ),
    paths: parsePaths(parsed.paths),
    head: parseHead(parsed.head),
    branch: optionalString(parsed, "branch", "branch", DEFAULT_BRANCH),
    checkConcurrency: integerField(parsed, "check_concurrency", "check_concurrency", 0, 0),
    checkKeep: parseCheckKeep(parsed.check_keep),
    recheck: parseRecheck(parsed.recheck),
    rules: parseRules(parsed.rules),
    seedTasks: parseTasks(parsed.task),
  };

  if (config.branch.trim() === "") fail("branch must be a non-empty string");
  return config;
};

/** Reads `<dir>/project.toml`. */
export const loadProject: LoadProject = async (dir) => {
  const file = join(dir, "project.toml");
  let text: string;
  try {
    text = await Bun.file(file).text();
  } catch (error) {
    throw new Error(
      `project.toml: cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseProject(text);
};

/**
 * True when `path` is a repo-relative POSIX path that matches one of
 * `cfg.paths` and has no traversal, no absolute root, and no backslash.
 */
export const pathAllowed: PathAllowed = (cfg, path) => {
  if (path === "" || path.endsWith("/")) return false;
  if (path.startsWith("/")) return false;
  if (path.includes("\\")) return false;

  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return false;
  }
  if (segments[0] === ".git" || segments[0] === ".minga") return false;

  return cfg.paths.some((pattern) => new Bun.Glob(pattern).match(path));
};
