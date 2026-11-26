import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { HEADER } from "../src/core/protocol.ts";
import type { ProjectInfo, SubmissionView, TasksResponse } from "../src/core/protocol.ts";
import { agentIdFromPublicKey, canonicalRequest, generateKeyPair, verifyMessage } from "../src/identity/keys.ts";
import type { FetchLike } from "../src/cli/client.ts";
import { createClient } from "../src/cli/client.ts";
import {
  fitSubmitMessage, formatRules, headKeygenCommand, headNoteCommand, joinCommand, nextCommand,
  parseAcceptPolicy, parseCli, parseRuleArgs, readSubmissionFiles, renderSubmission, statusCommand,
  submitCommand, tasksCommand,
} from "../src/cli/commands.ts";
import { dispatch } from "../src/cli/dispatch.ts";
import { doctorCommand } from "../src/cli/doctor.ts";
import { initCommand, renderProjectToml, tomlBasicString } from "../src/cli/init.ts";
import { renderJoinDoc } from "../src/cli/join-doc.ts";
import { findPackageRoot, serveCommand, type RunResult } from "../src/cli/runtime.ts";
import { parseProject } from "../src/project/config.ts";
import type { GitRunner } from "../src/cli/sync.ts";
import { syncCommand } from "../src/cli/sync.ts";
import { checkCommand } from "../src/cli/check.ts";
import type { SessionIdentity } from "../src/cli/store.ts";
import { agentPath, readAgent, readHead, resolveAgentDir, writeAgent, writeHead } from "../src/cli/store.ts";

const project: ProjectInfo = {
  name: "Minga",
  goal: "Make a self-hosted coordinator for volunteer AI agents.",
  scope: "You may edit src/** and docs/** only. Never touch the network config.",
  check: "bun test {files}",
  paths: ["src/**", "docs/**"],
  headAgent: "0123456789abcdef",
  rules: {
    width: 2,
    leaseMinutes: 10,
    maxAttemptsPerAgent: 2,
    roles: { explore: 1, build: 2, attack: 1, distill: 1, plan: 1 },
    accept: { mode: "head-or-votes", votes: 2 },
    defaultPoints: 10,
  },
};

const assignment = {
  attempt: "A-5",
  role: "build",
  leaseUntil: "2026-01-01T00:10:00.000Z",
  task: { id: "T-4", title: "Wire the parser", body: "Two lines\nof body", parent: "T-1", points: 10 },
  path: [{ id: "T-1", title: "Root" }, { id: "T-4", title: "Wire the parser" }],
  handoff: {
    id: "N-2", task: "T-4", agent: "0123456789abcdef", kind: "handoff",
    text: "start at parse", at: "2026-01-01T00:00:00.000Z",
  },
  notes: [],
  others: [{ attempt: "A-6", agent: "fedcba9876543210", model: "claude-y", role: "attack", approach: "fuzz it" }],
};

// ---------------------------------------------------------------- helpers

interface Call { url: string; init: RequestInit }

function mockFetch(reply: (call: Call) => Response): { fn: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fn: FetchLike = async (url, init) => {
    const call: Call = { url, init: init ?? {} };
    calls.push(call);
    return reply(call);
  };
  return { fn, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function withTempDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "minga-cli-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

interface FakeServerOptions {
  verdict?: "accepted" | "rejected";
  finalDelayMs?: number;
  assignment?: unknown | null;
  /** When true, /api/next answers done:true immediately (project finished). */
  done?: boolean;
  tasks?: TasksResponse;
  nextDelayMs?: number;
  outputTail?: string;
  stale?: boolean;
}

/** In-process v2 server: async submit + GET /api/submission/<id>?wait + next wait. */
function startFakeServer(options: FakeServerOptions = {}) {
  const verdict = options.verdict ?? "accepted";
  const finalDelay = options.finalDelayMs ?? 150;
  const nextDelay = options.nextDelayMs ?? 1000;
  const submissions = new Map<string, Record<string, unknown>>();
  let seq = 1;

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/api/project") return json(project);
      if (req.method === "GET" && url.pathname === "/api/leaderboard") {
        return json({ agents: [], models: [] });
      }
      if (req.method === "GET" && url.pathname === "/api/tasks") {
        return json(options.tasks ?? { tasks: [], open: 0, done: true });
      }
      if (req.method === "POST" && url.pathname === "/api/join") {
        const body = await req.json() as { publicKey: string };
        return json({ agent: agentIdFromPublicKey(body.publicKey), rejoin: false, project, live: [] });
      }
      if (req.method === "POST" && url.pathname === "/api/next") {
        const body = await req.json() as { wait?: number };
        if (options.done) return json({ assignment: null, done: true });
        const chosen = options.assignment === undefined ? null : options.assignment;
        if (chosen === null && (body.wait ?? 0) > 0) await sleep(Math.min(nextDelay, body.wait! * 1000));
        return json(chosen === null ? { assignment: null, retryAfterSeconds: 5 } : { assignment: chosen });
      }
      if (req.method === "POST" && url.pathname === "/api/submit") {
        const body = await req.json() as { attempt: string; claim: string; message: string; files: Record<string, string> };
        const id = `S-${seq++}`;
        const entry: Record<string, unknown> = {
          id, status: "queued", position: 1, attempt: body.attempt, task: "T-4",
          agent: "0123456789abcdef", model: "test-model", claim: body.claim, message: body.message,
          files: Object.keys(body.files), bytes: 10, queuedAt: new Date().toISOString(), runs: 0,
          points: verdict === "accepted" ? 10 : 0,
        };
        submissions.set(id, entry);
        setTimeout(() => { entry.status = "checking"; entry.runs = 1; }, Math.floor(finalDelay / 2));
        setTimeout(() => {
          entry.status = verdict;
          entry.ok = verdict === "accepted";
          entry.exitCode = verdict === "accepted" ? 0 : 1;
          entry.outputTail = options.outputTail ?? (verdict === "accepted" ? "" : "AssertionError: nope\n  at a.ts:1");
          if (options.stale !== undefined) entry.stale = options.stale;
          entry.commit = verdict === "accepted" ? "deadbeef" : undefined;
          entry.checkedAt = new Date().toISOString();
        }, finalDelay);
        return json({ submission: id, status: "queued", position: 1 });
      }
      const match = /^\/api\/submission\/(S-\d+)$/.exec(url.pathname);
      if (req.method === "GET" && match) {
        const entry = submissions.get(match[1]!);
        if (!entry) return json({ error: `no submission ${match[1]}` }, 404);
        const wait = Number(url.searchParams.get("wait") ?? 0);
        if (wait > 0) {
          // Like the real server: hold until the status changes, so the client
          // sees the queued -> checking -> verdict progression.
          const deadline = Date.now() + wait * 1000;
          const seen = entry.status;
          while (entry.status === seen && !["accepted", "rejected"].includes(String(entry.status)) && Date.now() < deadline) await sleep(10);
        }
        return json(entry);
      }
      return json({ error: "not found" }, 404);
    },
  });

  return {
    server,
    url: `http://127.0.0.1:${server.port}`,
    submissions,
  };
}

function withIdentity(dir: string, url: string): void {
  mkdirSync(join(dir, ".minga"), { recursive: true });
  const keys = generateKeyPair();
  writeFileSync(join(dir, ".minga", "agent.json"), JSON.stringify({
    url,
    agent: agentIdFromPublicKey(keys.publicKey),
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    model: "test-model",
    harness: "test-harness",
  }));
}

// ---------------------------------------------------------------- parsing

describe("argument parsing", () => {
  const cases: Array<{ name: string; argv: string[]; command: string; action?: string; positionals: string[]; options: Record<string, string | boolean> }> = [
    {
      name: "join",
      argv: ["join", "https://m.example", "--model", "claude-x", "--harness", "claude-code", "--owner", "octo"],
      command: "join", positionals: ["https://m.example"],
      options: { model: "claude-x", harness: "claude-code", owner: "octo" },
    },
    {
      name: "next --wait",
      argv: ["next", "--model", "claude-x", "--wait", "600"],
      command: "next", positionals: [], options: { model: "claude-x", wait: "600" },
    },
    {
      name: "submit --no-wait",
      argv: ["submit", "A-4", "--claim", "solves", "-m", "fix it", "src/a.ts", "--no-wait"],
      command: "submit", positionals: ["A-4", "src/a.ts"],
      options: { claim: "solves", message: "fix it", wait: false },
    },
    {
      name: "result --wait",
      argv: ["result", "S-1", "--wait"],
      command: "result", positionals: ["S-1"], options: { wait: true },
    },
    {
      name: "beat",
      argv: ["beat", "A-3", "--approach", "still on it"],
      command: "beat", positionals: ["A-3"], options: { approach: "still on it" },
    },
    {
      name: "note",
      argv: ["note", "T-2", "idea", "try", "the", "parser"],
      command: "note", positionals: ["T-2", "idea", "try", "the", "parser"], options: {},
    },
    {
      name: "release",
      argv: ["release", "A-4", "--handoff", "half done"],
      command: "release", positionals: ["A-4"], options: { handoff: "half done" },
    },
    {
      name: "init",
      argv: ["init", "repo", "--name", "n", "--goal", "g", "--scope", "s", "--check", "bun test {files}", "--paths", "src/**,docs/**", "--branch", "main", "--force"],
      command: "init", positionals: ["repo"],
      options: { name: "n", goal: "g", scope: "s", check: "bun test {files}", paths: "src/**,docs/**", branch: "main", force: true },
    },
    {
      name: "doctor",
      argv: ["doctor", "--repo", "repo", "--json"],
      command: "doctor", positionals: [], options: { repo: "repo", json: true },
    },
    { name: "mcp", argv: ["mcp", "--dir", "work"], command: "mcp", positionals: [], options: { dir: "work" } },
    { name: "vote", argv: ["vote", "P-2", "yes"], command: "vote", positionals: ["P-2", "yes"], options: {} },
    { name: "status", argv: ["status", "--json"], command: "status", positionals: [], options: { json: true } },
    { name: "tasks --open", argv: ["tasks", "--open"], command: "tasks", positionals: [], options: { open: true } },
    {
      name: "head keygen",
      argv: ["head", "keygen", "--url", "https://m.example"],
      command: "head", action: "keygen", positionals: [], options: { url: "https://m.example" },
    },
    {
      name: "head note",
      argv: ["head", "note", "T-2", "fixed", "the", "test", "--kind", "result"],
      command: "head", action: "note", positionals: ["T-2", "fixed", "the", "test"],
      options: { kind: "result" },
    },
  ];

  for (const c of cases) {
    test(`parses ${c.name}`, () => {
      const cli = parseCli(c.argv);
      expect(cli.command).toBe(c.command);
      expect(cli.action).toBe(c.action);
      expect(cli.positionals).toEqual(c.positionals);
      for (const [key, value] of Object.entries(c.options)) expect(cli.options[key]).toBe(value);
    });
  }

  test("serve keeps its arguments verbatim for the server", () => {
    const cli = parseCli(["serve", "--repo", "x", "--port", "8000", "--db", "d.db", "--json"]);
    expect(cli.command).toBe("serve");
    expect(cli.raw).toEqual(["--repo", "x", "--port", "8000", "--db", "d.db", "--json"]);
  });

  test("help variants and unknown commands", () => {
    expect(parseCli([]).command).toBe("");
    expect(parseCli(["help"]).command).toBe("help");
    expect(parseCli(["--help"]).command).toBe("help");
    expect(parseCli(["head"]).command).toBe("head");
    expect(parseCli(["head", "--help"]).action).toBe("help");
    expect(parseCli(["submit", "--help"]).options.help).toBe(true);
    expect(parseCli(["next", "-h"]).options.help).toBe(true);
    expect(() => parseCli(["frobnicate"])).toThrow(/unknown command/);
    expect(() => parseCli(["head", "frobnicate"])).toThrow(/unknown head action/);
  });
});

// ---------------------------------------------------------------- client

describe("client", () => {
  test("signs every POST route over the exact body, with a fresh nonce", async () => {
    const keys = generateKeyPair();
    const mock = mockFetch(() => json({}));
    const client = createClient("https://minga.test/", keys, mock.fn);

    await client.join({ publicKey: keys.publicKey, model: "m", harness: "h" });
    await client.next({});
    await client.beat({ attempt: "A-1" });
    await client.note({ task: "T-1", kind: "idea", text: "x" });
    await client.submit({ attempt: "A-1", claim: "progress", message: "m", files: { "src/a.ts": "x" } });
    await client.release({ attempt: "A-1" });
    await client.propose({ kind: "new_task", task: null, title: "t" });
    await client.vote({ proposal: "P-1", approve: true });
    await client.headPost({ title: "t", body: "b", parent: null });
    await client.headDecide({ proposal: "P-1", accept: false });
    await client.headRule({ rules: { width: 3 } });
    await client.headBan({ agent: "0123456789abcdef", reason: "r" });
    await client.headClose({ task: "T-1", status: "withdrawn" });

    const paths = [
      "/api/join", "/api/next", "/api/beat", "/api/note", "/api/submit", "/api/release",
      "/api/propose", "/api/vote", "/api/head/post", "/api/head/decide", "/api/head/rule",
      "/api/head/ban", "/api/head/close",
    ];
    expect(mock.calls.length).toBe(paths.length);
    const nonces = new Set<string>();
    for (const [index, path] of paths.entries()) {
      const call = mock.calls[index]!;
      expect(new URL(call.url).pathname).toBe(path);
      expect(call.init.method).toBe("POST");
      const headers = call.init.headers as Record<string, string>;
      const body = call.init.body as string;
      expect(typeof body).toBe("string");
      const ts = headers[HEADER.ts]!;
      const nonce = headers[HEADER.nonce]!;
      nonces.add(nonce);
      expect(verifyMessage(keys.publicKey, canonicalRequest("POST", path, ts, nonce, body), headers[HEADER.sig]!)).toBe(true);
      expect(verifyMessage(keys.publicKey, canonicalRequest("POST", path, ts, nonce, `${body} `), headers[HEADER.sig]!)).toBe(false);
    }
    expect(nonces.size).toBe(paths.length);
  });

  test("GET reads are unsigned; submission GET carries a capped wait", async () => {
    const mock = mockFetch(() => json({}));
    const client = createClient("https://minga.test", generateKeyPair(), mock.fn);
    await client.project();
    await client.state();
    await client.events(7, 5);
    await client.leaderboard();
    await client.submission("S-12", 45);
    await client.submission("S-12");
    expect(mock.calls.map((call) => call.url)).toEqual([
      "https://minga.test/api/project",
      "https://minga.test/api/state",
      "https://minga.test/api/events?after=7&limit=5",
      "https://minga.test/api/leaderboard",
      "https://minga.test/api/submission/S-12?wait=30",
      "https://minga.test/api/submission/S-12",
    ]);
    for (const call of mock.calls) {
      expect(call.init.method).toBe("GET");
      expect(call.init.headers).toEqual({});
      expect(call.init.body).toBeUndefined();
    }
  });

  test("maps non-2xx responses to `<status>: <error>`", async () => {
    const keys = generateKeyPair();
    const failing = mockFetch(() => json({ error: "lease expired", detail: "beat first" }, 409));
    await expect(createClient("https://minga.test", keys, failing.fn).next()).rejects.toThrow("409: lease expired\nnext: beat first");
    const plain = mockFetch(() => new Response("boom", { status: 500 }));
    await expect(createClient("https://minga.test", keys, plain.fn).project()).rejects.toThrow("500: boom");
  });
});

// ---------------------------------------------------------------- join / store / head

describe("attempt state and local check", () => {
  test("status says who closed the task when the attempt ended under the agent", async () => {
    await withTempDir(async (dir) => {
      const keys = generateKeyPair();
      const identity = {
        url: "https://minga.test", agent: agentIdFromPublicKey(keys.publicKey),
        publicKey: keys.publicKey, privateKey: keys.privateKey, model: "m", harness: "h",
        lastAssignment: { attempt: "A-8", role: "build" as const, leaseUntil: new Date(Date.now() + 40 * 60_000).toISOString(), task: "T-1" },
      };
      writeAgent(dir, identity);
      const mock = mockFetch((call) => {
        if (call.url.endsWith("/api/project")) return json(project);
        return json({
          id: "A-8", task: "T-1", agent: identity.agent, role: "build", state: "ended", endReason: "task_closed",
          leaseUntil: identity.lastAssignment.leaseUntil, endedAt: "", taskStatus: "solved",
          closedBy: { agent: "4bec7c19de4503f8", model: "hy4", submission: "S-6" },
        });
      });
      const result = await statusCommand(createClient("https://minga.test", keys, mock.fn), readAgent(dir)!);
      expect(result.text).toContain("attempt: A-8 (build) on T-1 — ended: T-1 was solved by S-6 from 4bec7c19de4503f8 (hy4); run minga sync");
      expect(result.text).not.toContain("left");
      expect(result.data.attempt?.state).toBe("ended");
    });
  });

  test("check fills {files} and MINGA_FILES and maps the exit code", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "a.ts"), "x");
      const seen: { cmd: string; args: string[]; env: string | undefined }[] = [];
      const ok = checkCommand({
        dir, command: "bun test {files}", files: ["./a.ts"],
        spawn: (cmd, args, opts) => { seen.push({ cmd, args, env: opts.env.MINGA_FILES }); return { status: 0, output: "1 pass\n" }; },
      });
      expect(seen[0]).toEqual({ cmd: "bun", args: ["exec", "bun test 'a.ts'"], env: "a.ts" });
      expect(ok.code).toBe(0);
      expect(ok.text).toContain("check passed");
      const bad = checkCommand({
        dir, command: "bun check.ts", files: ["a.ts"],
        spawn: (cmd) => cmd === "bun" ? { status: null, error: new Error("ENOENT"), output: "" } : { status: 1, output: "boom\n" },
      });
      expect(bad.data.runner).toBe("shell");
      expect(bad.code).toBe(2);
      expect(bad.text).toContain("boom");
      expect(() => checkCommand({ dir, command: "x", files: ["missing.ts"] })).toThrow(/no such file/);
    });
  });
});

describe("join, store and head", () => {
  test("reuses the stored key on a second join", async () => {
    await withTempDir(async (dir) => {
      const mock = mockFetch((call) => {
        const body = JSON.parse(call.init.body as string) as { publicKey: string };
        return json({ agent: agentIdFromPublicKey(body.publicKey), rejoin: false, project, live: [] });
      });
      const keys = generateKeyPair();
      const first = await joinCommand(createClient("https://minga.test", keys, mock.fn), {
        url: "https://minga.test", keys, model: "claude-x", harness: "claude-code",
      });
      writeAgent(dir, first.identity);
      expect(readAgent(dir)!.publicKey).toBe(keys.publicKey);
      expect(agentPath(dir)).toBe(join(dir, ".minga", "agent.json"));

      const stored = readAgent(dir)!;
      await joinCommand(
        createClient("https://minga.test", { publicKey: stored.publicKey, privateKey: stored.privateKey }, mock.fn),
        { url: "https://minga.test", keys: stored, model: "claude-x", harness: "claude-code" },
      );
      expect((mock.calls[1]!.init.headers as Record<string, string>)[HEADER.agent]).toBe(first.identity.agent);
    });
  });

  test("identity lookup walks up to the nearest ancestor holding agent.json", () => {
    withTempDir((dir) => {
      const outer = join(dir, "work");
      const inner = join(outer, "src", "deep");
      mkdirSync(inner, { recursive: true });
      const outerKeys = generateKeyPair();
      const outerIdentity: SessionIdentity = {
        url: "https://minga.test", agent: agentIdFromPublicKey(outerKeys.publicKey),
        publicKey: outerKeys.publicKey, privateKey: outerKeys.privateKey, model: "m", harness: "h",
      };
      writeAgent(dir, outerIdentity);
      expect(resolveAgentDir(inner)).toBe(dir);
      expect(readAgent(inner)!.agent).toBe(outerIdentity.agent);

      // A nearer identity wins, just like the nearest .git directory.
      const innerKeys = generateKeyPair();
      const innerIdentity: SessionIdentity = { ...outerIdentity,
        agent: agentIdFromPublicKey(innerKeys.publicKey),
        publicKey: innerKeys.publicKey, privateKey: innerKeys.privateKey };
      writeAgent(outer, innerIdentity);
      expect(resolveAgentDir(inner)).toBe(outer);
      expect(readAgent(inner)!.agent).toBe(innerIdentity.agent);
      expect(agentPath(resolveAgentDir(inner))).toBe(agentPath(outer));
    });
  });

  test("join writes to cwd, reusing an ancestor identity only for the same URL", async () => {
    await withTempDir(async (dir) => {
      const parent = join(dir, "parent");
      const child = join(parent, "work");
      mkdirSync(child, { recursive: true });
      const ancestorKeys = generateKeyPair();
      const url = "https://minga.test";
      writeAgent(parent, {
        url, agent: agentIdFromPublicKey(ancestorKeys.publicKey),
        publicKey: ancestorKeys.publicKey, privateKey: ancestorKeys.privateKey,
        model: "m", harness: "h",
      });
      const mock = mockFetch((call) => {
        const body = JSON.parse(call.init.body as string) as { publicKey: string };
        return json({ agent: agentIdFromPublicKey(body.publicKey), rejoin: false, project, live: [] });
      });
      const deps = { dir: child, fetchImpl: mock.fn };
      const joined = await dispatch({
        command: "join", options: { model: "m", harness: "h" }, positionals: [url],
      }, deps);
      expect(joined.code).toBe(0);
      expect(existsSync(agentPath(child))).toBe(false);
      expect(readAgent(child)!.publicKey).toBe(ancestorKeys.publicKey);

      const before = readAgent(parent)!;
      await dispatch({
        command: "join", options: { model: "m", harness: "h" }, positionals: ["https://other.test"],
      }, deps);
      expect(existsSync(agentPath(child))).toBe(true);
      expect(readAgent(child)!.url).toBe("https://other.test");
      expect(readAgent(parent)!.publicKey).toBe(before.publicKey);
    });
  });

  test("join output names the agent, goal, scope and rules", async () => {
    const keys = generateKeyPair();
    const mock = mockFetch(() => json({ agent: agentIdFromPublicKey(keys.publicKey), rejoin: true, project, live: ["A-2"] }));
    const { result } = await joinCommand(createClient("https://minga.test", keys, mock.fn), {
      url: "https://minga.test", keys, model: "m", harness: "h",
    });
    expect(result.text).toContain(project.goal);
    expect(result.text).toContain("width=2");
    expect(result.text).toContain("accept=head-or-votes:2");
    expect(result.text).toContain("A-2");
    expect(result.text).toContain("git clone -b main https://minga.test/repo.git work && cd work");
    expect(result.text).toContain("submit reads files relative to cwd");
  });

  test("the join clone command does not double a trailing slash", async () => {
    const keys = generateKeyPair();
    const mock = mockFetch(() => json({ agent: agentIdFromPublicKey(keys.publicKey), rejoin: false, project, live: [] }));
    const { result } = await joinCommand(createClient("https://minga.test/", keys, mock.fn), {
      url: "https://minga.test/", keys, model: "m", harness: "h",
    });
    expect(result.text).toContain("git clone -b main https://minga.test/repo.git work && cd work");
    expect(result.text).not.toContain("minga.test//repo.git");
  });

  test("missing identity is null and keygen is idempotent", async () => {
    await withTempDir((dir) => {
      expect(readAgent(dir)).toBeNull();
      expect(readHead(dir)).toBeNull();
      const first = headKeygenCommand(null, "https://minga.test");
      expect(first.identity.publicKey).toHaveLength(43);
      expect(first.result.data.head).toBe(`ed25519:${first.identity.publicKey}`);
      writeHead(dir, first.identity);
      const second = headKeygenCommand(readHead(dir));
      expect(second.identity.publicKey).toBe(first.identity.publicKey);
      expect(second.identity.url).toBe("https://minga.test");
    });
  });

  test("parses rules and accept policies", () => {
    expect(parseRuleArgs(["width=3", "leaseMinutes=15", "maxAttemptsPerAgent=4", "defaultPoints=0", "accept=head"])).toEqual({
      width: 3, leaseMinutes: 15, maxAttemptsPerAgent: 4, defaultPoints: 0, accept: { mode: "head" },
    });
    expect(parseAcceptPolicy("votes:2")).toEqual({ mode: "votes", votes: 2 });
    expect(() => parseAcceptPolicy("votes:0")).toThrow(/at least 1/);
    expect(() => parseRuleArgs(["bogus=1"])).toThrow(/unknown rule/);
    expect(formatRules(project.rules)).toBe(
      "width=2 leaseMinutes=10 maxLiveAttemptsPerAgent=2 defaultPoints=10 accept=head-or-votes:2",
    );
  });

  test("head note posts a signed /api/head/note body and defaults to result", async () => {
    const keys = generateKeyPair();
    const note = {
      id: "N-9", task: "T-2", agent: agentIdFromPublicKey(keys.publicKey),
      kind: "result" as const, text: "fixed the test", at: "2026-01-01T00:00:00.000Z",
    };
    const mock = mockFetch(() => json({ note }));
    const client = createClient("https://minga.test", keys, mock.fn);
    const result = await headNoteCommand(client, { task: "T-2", text: "fixed the test" });
    expect(new URL(mock.calls[0]!.url).pathname).toBe("/api/head/note");
    expect(JSON.parse(mock.calls[0]!.init.body as string)).toEqual({
      task: "T-2", text: "fixed the test",
    });
    expect((mock.calls[0]!.init.headers as Record<string, string>)[HEADER.agent]).toBe(note.agent);
    expect(result.text).toBe("note N-9 on T-2 (result)");
    expect(result.data.note).toEqual(note);

    await headNoteCommand(client, { task: "T-2", text: "an idea", kind: "idea" });
    expect(JSON.parse(mock.calls[1]!.init.body as string)).toEqual({
      task: "T-2", text: "an idea", kind: "idea",
    });
  });

  test("head note through the dispatcher uses the head identity", async () => {
    await withTempDir(async (dir) => {
      const keys = generateKeyPair();
      writeHead(dir, {
        agent: agentIdFromPublicKey(keys.publicKey),
        publicKey: keys.publicKey, privateKey: keys.privateKey, url: "https://minga.test",
      });
      const mock = mockFetch(() => json({
        note: {
          id: "N-10", task: "T-3", agent: agentIdFromPublicKey(keys.publicKey),
          kind: "handoff", text: "handled", at: "2026-01-01T00:00:00.000Z",
        },
      }));
      const outcome = await dispatch(parseCli([
        "head", "note", "T-3", "handled", "--kind", "handoff", "--dir", dir,
      ]), { dir, fetchImpl: mock.fn });
      expect(outcome.code).toBe(0);
      expect(outcome.result.text).toBe("note N-10 on T-3 (handoff)");
      expect(JSON.parse(mock.calls[0]!.init.body as string)).toEqual({
        task: "T-3", text: "handled", kind: "handoff",
      });
      expect((mock.calls[0]!.init.headers as Record<string, string>)[HEADER.agent]).toBe(
        agentIdFromPublicKey(keys.publicKey),
      );
    });
  });
});

// ---------------------------------------------------------------- submit / result / next logic

describe("submit and result logic", () => {
  test("over-long messages are fitted to the server's 200-char first line", () => {
    const long = `${"x".repeat(220)}\nsecond line`;
    const fitted = fitSubmitMessage(long);
    expect(fitted.message).toBe(`${"x".repeat(197)}...`);
    expect(fitted.message).toHaveLength(200);
    expect(fitted.notice).toContain("over 200 chars");
    expect(fitSubmitMessage("short")).toEqual({ message: "short" });
    // A short first line is kept as-is even when later lines exceed the limit.
    expect(fitSubmitMessage(`first\n${"y".repeat(220)}`).message).toBe("first");
  });

  test("reads files, queues and waits for a verdict", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
      const progress: string[] = [];
      const mock = mockFetch((call) => {
        if (call.url.endsWith("/api/submit")) {
          return json({ submission: "S-7", status: "queued", position: 2 });
        }
        return json({
          id: "S-7", status: "accepted", exitCode: 0, commit: "abc1234", points: 10,
          outputTail: "", attempt: "A-1", task: "T-1", agent: "a", model: "m", claim: "solves",
          message: "m", files: ["a.ts"], bytes: 20, queuedAt: "", runs: 1,
        });
      });
      const result = await submitCommand(createClient("https://minga.test", generateKeyPair(), mock.fn), {
        attempt: "A-1", claim: "solves", message: "do it", files: ["a.ts"], root: dir,
        onProgress: (line) => progress.push(line),
      });
      expect(mock.calls.map((c) => new URL(c.url).pathname)).toEqual(["/api/submit", "/api/submission/S-7"]);
      expect(new URL(mock.calls[1]!.url).searchParams.get("wait")).toBe("30");
      expect(JSON.parse(mock.calls[0]!.init.body as string).files).toEqual({ "a.ts": "export const a = 1;\n" });
      expect(progress).toEqual(["queued S-7 (#2 in line)"]);
      expect(progress.join("\n")).not.toContain("verdict");
      expect(result.text).toContain("verdict: accepted");
      expect(result.text).toContain("exit code: 0");
      expect(result.text).toContain("commit: abc1234");
      expect(result.text).toContain("points: 10");
      expect(result.text).toContain("next: minga sync && minga next --wait 600");
    });
  });

  test("progress is only queued/checking; the verdict is in the final block", async () => {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "a.ts"), "x");
      let polls = 0;
      const view = {
        id: "S-3", attempt: "A-1", task: "T-1", agent: "a", model: "m", claim: "solves",
        message: "m", files: ["a.ts"], bytes: 1, queuedAt: "", runs: 1, points: 10,
      };
      const mock = mockFetch((call) => {
        if (call.url.endsWith("/api/submit")) return json({ submission: "S-3", status: "queued", position: 1 });
        polls++;
        return json(polls === 1
          ? { ...view, status: "checking" }
          : { ...view, status: "accepted", exitCode: 0, commit: "abc1234" });
      });
      const progress: string[] = [];
      const result = await submitCommand(createClient("https://minga.test", generateKeyPair(), mock.fn), {
        attempt: "A-1", claim: "solves", message: "m", files: ["a.ts"], root: dir,
        onProgress: (line) => progress.push(line),
      });
      expect(progress).toEqual(["queued S-3 (#1 in line)", "checking S-3 (run 1)"]);
      expect(result.text).toContain("verdict: accepted");
      expect(progress.join("\n")).not.toContain("verdict");
    });
  });

  test("rejected verdict and --no-wait", async () => {
    const accepted = renderSubmission({
      id: "S-1", status: "rejected", exitCode: 1, outputTail: "AssertionError: nope",
      points: 0, attempt: "A-1", task: "T-1", agent: "a", model: "m", claim: "progress",
      message: "m", files: [], bytes: 0, queuedAt: "", runs: 1,
    });
    expect(accepted).toContain("verdict: rejected");
    expect(accepted).toContain("AssertionError: nope");
    expect(accepted).not.toContain("commit:");

    await withTempDir(async (dir) => {
      writeFileSync(join(dir, "a.ts"), "x");
      const mock = mockFetch(() => json({ submission: "S-9", status: "queued", position: 1 }));
      const result = await submitCommand(createClient("https://minga.test", generateKeyPair(), mock.fn), {
        attempt: "A-1", claim: "progress", message: "m", files: ["a.ts"], root: dir, wait: false,
      });
      expect(result.text).toBe("submission S-9: queued #1");
      expect(mock.calls).toHaveLength(1);
    });
  });

  test("empty check output and stale rejections explain what happened", () => {
    const base: SubmissionView = {
      id: "S-2", status: "rejected", exitCode: 1, points: 0, attempt: "A-1", task: "T-1",
      agent: "a", model: "m", claim: "solves", message: "m", files: [], bytes: 0,
      queuedAt: "", runs: 1,
    };
    const empty = renderSubmission({ ...base, outputTail: "" });
    expect(empty).toContain("output: (the check printed nothing; exit code 1)");
    expect(empty).not.toContain("output tail:");
    expect(empty).toContain('next: fix and run "minga submit A-1 ..." again');
    expect(empty).toContain('"minga release A-1 --handoff');

    const closed = renderSubmission({
      ...base, stale: true, outputTail: "task T-1 was closed (solved) before this check finished",
    });
    expect(closed).toContain("stale: the task closed first");
    const moving = renderSubmission({
      ...base, stale: true, outputTail: "the branch kept moving while this was checked; submit again",
    });
    expect(moving).toContain("stale: the branch kept moving");

    const normal = renderSubmission({ ...base, outputTail: "AssertionError: nope" });
    expect(normal).toContain("output tail:");
    expect(normal).not.toContain("stale:");
  });

  test("files outside the root and .minga/ are refused", async () => {
    await withTempDir((dir) => {
      expect(() => readSubmissionFiles(dir, [join("..", "escape.ts")])).toThrow(/outside the repo root/);
      mkdirSync(join(dir, ".minga"));
      writeFileSync(join(dir, ".minga", "key"), "secret");
      expect(() => readSubmissionFiles(dir, [".minga/key"])).toThrow(/holds your private key/);
    });
  });
});

describe("next with wait", () => {
  test("a single call when wait is 0", async () => {
    const mock = mockFetch(() => json({ assignment: null, retryAfterSeconds: 42 }));
    const result = await nextCommand(createClient("https://minga.test", generateKeyPair(), mock.fn));
    expect(result.text).toBe('nothing to do right now; run "minga next --wait 600" to wait for a task');
    expect(mock.calls).toHaveLength(1);
    expect(JSON.parse(mock.calls[0]!.init.body as string).wait).toBeUndefined();
  });

  test("repeats with capped long-poll until an assignment arrives", async () => {
    let calls = 0;
    const mock = mockFetch((call) => {
      if (call.url.endsWith("/api/project")) return json(project);
      calls++;
      return json(calls < 3 ? { assignment: null, retryAfterSeconds: 5 } : { assignment });
    });
    const result = await nextCommand(createClient("https://minga.test", generateKeyPair(), mock.fn), { wait: 60 });
    expect(calls).toBe(3);
    expect(mock.calls).toHaveLength(4); // the final assignment also looks up its notes' author
    expect(result.text).toContain("attempt   A-5");
    expect(result.text).toContain("role      build");
    expect(result.text).toContain("T-4  Wire the parser");
    expect(result.text).toContain("T-1 Root > T-4 Wire the parser");
    expect(result.text).toContain("start at parse");
    expect(result.text).toContain("A-6 fedcba9876543210 claude-y attack — fuzz it");
    expect(result.text).not.toContain("git pull if your checkout is older");
    const waits = mock.calls.filter((c) => c.init.method === "POST")
      .map((c) => JSON.parse(c.init.body as string).wait as number);
    expect(waits[0]).toBe(30);
    expect(Math.max(...waits)).toBeLessThanOrEqual(30);
  });

  test("shows the assigned branch head with a pull hint", async () => {
    const mock = mockFetch(() => json({ assignment: { ...assignment, head: "0123456789abcdef0123" } }));
    const result = await nextCommand(createClient("https://minga.test", generateKeyPair(), mock.fn));
    expect(result.text).toContain("head 0123456 (minga sync if your checkout is older)");
    expect(result.data.assignment?.head).toBe("0123456789abcdef0123");
  });

  test("marks notes from the head agent with a head: prefix", async () => {
    const headNotes = {
      ...assignment,
      notes: [
        { id: "N-8", task: "T-4", agent: project.headAgent, kind: "result",
          text: "the check was fixed", at: "2026-01-01T00:00:00.000Z" },
        { id: "N-9", task: "T-4", agent: "fedcba9876543210", kind: "idea",
          text: "try another way", at: "2026-01-01T00:00:00.000Z" },
      ],
    };
    const mock = mockFetch((call) => call.url.endsWith("/api/project")
      ? json(project)
      : json({ assignment: headNotes }));
    const result = await nextCommand(createClient("https://minga.test", generateKeyPair(), mock.fn));
    expect(result.text).toContain("N-8 head: 0123456789abcdef result: the check was fixed");
    expect(result.text).toContain("N-9 fedcba9876543210 idea: try another way");
    expect(result.text).toContain("handoff   N-2 head: (handoff) start at parse");
  });

  test("prints one remaining-time progress line per empty poll", async () => {
    const progress: string[] = [];
    let calls = 0;
    const mock = mockFetch(() => {
      calls++;
      return json(calls < 3 ? { assignment: null, retryAfterSeconds: 0 } : { assignment });
    });
    await nextCommand(createClient("https://minga.test", generateKeyPair(), mock.fn), {
      wait: 60,
      onProgress: (line) => progress.push(line),
    });
    expect(progress).toHaveLength(2);
    for (const line of progress) {
      const match = /^no free task yet; waiting \((\d+)s left\)$/.exec(line);
      expect(match).not.toBeNull();
      expect(Number(match![1])).toBeGreaterThan(0);
    }
  });

  test("stops immediately with the done message when the server says done", async () => {
    const progress: string[] = [];
    const mock = mockFetch(() => json({ assignment: null, done: true }));
    const result = await nextCommand(createClient("https://minga.test", generateKeyPair(), mock.fn), {
      wait: 600,
      onProgress: (line) => progress.push(line),
    });
    expect(mock.calls).toHaveLength(1);
    expect(result.text).toBe("the project has no open tasks left. Stop here.");
    expect(result.data).toEqual({ assignment: null, done: true });
    expect(progress).toEqual([]);
  });
});

describe("tasks overview", () => {
  const overview: TasksResponse = {
    tasks: [
      { id: "T-1", title: "Root", parent: null, status: "solved", points: 0, live: 0, leaf: false },
      { id: "T-2", title: "An area", parent: "T-1", status: "open", points: 0, live: 1, leaf: false },
      { id: "T-3", title: "isPrime", parent: "T-2", status: "open", points: 20, live: 2, leaf: true },
      { id: "T-4", title: "closed leaf", parent: "T-2", status: "solved", points: 5, live: 0, leaf: true },
    ],
    open: 1,
    done: false,
  };

  test("renders an indented tree with areas and an open-leaf footer", async () => {
    const mock = mockFetch(() => json(overview));
    const result = await tasksCommand(createClient("https://minga.test", generateKeyPair(), mock.fn));
    expect(new URL(mock.calls[0]!.url).pathname).toBe("/api/tasks");
    expect(result.data).toEqual(overview);
    expect(result.text).toContain("T-1  solved      0 pts  Root [area]");
    expect(result.text).toContain("  T-2  open · 1 live  0 pts  An area [area]");
    expect(result.text).toContain("    T-3  open · 2 live  20 pts  isPrime");
    expect(result.text).toContain("    T-4  solved      5 pts  closed leaf");
    expect(result.text).not.toContain("0 live");
    expect(result.text).toContain("open leaf tasks: 1");
    expect(result.text).not.toContain("project finished");
  });

  test("--open keeps only open tasks but preserves their depth", async () => {
    const mock = mockFetch(() => json(overview));
    const result = await tasksCommand(createClient("https://minga.test", generateKeyPair(), mock.fn), {
      openOnly: true,
    });
    expect(result.text).toContain("  T-2  open · 1 live  0 pts  An area [area]");
    expect(result.text).toContain("    T-3  open · 2 live  20 pts  isPrime");
    expect(result.text).not.toContain("T-1  solved");
    expect(result.text).not.toContain("closed leaf");
  });

  test("a finished project has a done footer", async () => {
    const mock = mockFetch(() => json({ tasks: [], open: 0, done: true }));
    const result = await tasksCommand(createClient("https://minga.test", generateKeyPair(), mock.fn));
    expect(result.text).toBe("project finished");
    expect(result.data.done).toBe(true);
  });
});

// ---------------------------------------------------------------- sync

describe("minga sync", () => {
  function fakeGit(options: {
    status: string;
    head?: Record<string, string>;
    ref?: string | null;
    calls: string[];
  }): GitRunner {
    return (args) => {
      options.calls.push(args.join(" "));
      switch (args[0]) {
        case "fetch": return "";
        case "symbolic-ref":
          if (options.ref === null) throw new Error("no origin/HEAD");
          return `${options.ref ?? "refs/remotes/origin/main"}\n`;
        case "status": return options.status;
        case "show": {
          const path = args[1]!.slice(args[1]!.indexOf(":") + 1);
          const content = options.head?.[path];
          if (content === undefined) throw new Error(`no ${path} in head`);
          return content;
        }
        case "reset":
        case "clean": return "";
        default: throw new Error(`unexpected git ${args.join(" ")}`);
      }
    };
  }

  function withKeys(dir: string, accepted?: string[]): void {
    const keys = generateKeyPair();
    writeAgent(dir, {
      url: "https://minga.test", agent: agentIdFromPublicKey(keys.publicKey),
      publicKey: keys.publicKey, privateKey: keys.privateKey, model: "m", harness: "h",
      ...(accepted !== undefined ? { lastAccepted: { submission: "S-1", files: accepted } } : {}),
    });
  }

  test("drops untracked leftovers identical to the fetched branch head", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "a.ts"), "same\n");
      withKeys(dir);
      const calls: string[] = [];
      const result = syncCommand({ dir, runner: fakeGit({
        status: "?? a.ts\n", head: { "a.ts": "same\n" }, calls,
      }) });
      expect(result.data.synced).toBe(true);
      expect(result.data.discarded).toEqual(["a.ts"]);
      expect(result.data.conflicting).toEqual([]);
      expect(calls).toContain("fetch origin");
      expect(calls).toContain("reset --hard origin/main");
      expect(calls).toContain("clean -fd -- a.ts");
      expect(result.text).toContain("synced to origin/main");
    });
  });

  test("drops a file from the last accepted submission even when head lacks it", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "new.ts"), "leftover\n");
      withKeys(dir, ["new.ts"]);
      const calls: string[] = [];
      const result = syncCommand({ dir, runner: fakeGit({
        status: "?? new.ts\n", head: {}, calls,
      }) });
      expect(result.data.synced).toBe(true);
      expect(calls).toContain("clean -fd -- new.ts");
    });
  });

  test("refuses unrelated changes, honours --discard and falls back to main", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "other.ts"), "local\n");
      withKeys(dir);
      const calls: string[] = [];
      const refused = syncCommand({ dir, runner: fakeGit({
        status: " M other.ts\n", head: { "other.ts": "remote\n" }, ref: null, calls,
      }) });
      expect(refused.data.synced).toBe(false);
      expect(refused.data.refused).toBe(true);
      expect(refused.data.conflicting).toEqual(["other.ts"]);
      expect(refused.text).toContain("refusing to sync");
      expect(refused.text).toContain("other.ts");
      expect(calls).not.toContain("reset --hard origin/main");
      expect(calls).toContain("fetch origin");

      calls.length = 0;
      const forced = syncCommand({ dir, discard: true, runner: fakeGit({
        status: " M other.ts\n", head: { "other.ts": "remote\n" }, ref: null, calls,
      }) });
      expect(forced.data.synced).toBe(true);
      expect(forced.data.refused).toBe(false);
      expect(forced.data.conflicting).toEqual(["other.ts"]);
      expect(calls).toContain("reset --hard origin/main");
      expect(forced.text).toContain("(--discard)");
    });
  });

  test("a clean worktree needs no destructive git commands", () => {
    withTempDir((dir) => {
      const calls: string[] = [];
      const result = syncCommand({ dir, runner: fakeGit({ status: "", calls }) });
      expect(result.data.changed).toEqual([]);
      expect(result.data.synced).toBe(false);
      expect(result.text).toContain("no local changes to sync");
      expect(calls).toEqual(["fetch origin", "rev-parse --abbrev-ref --symbolic-full-name @{u}", "symbolic-ref --quiet refs/remotes/origin/HEAD", "status --porcelain"]);
    });
  });
});

// ---------------------------------------------------------------- status recovery

describe("status recovery", () => {
  test("status shows the last attempt, lease remaining and queue position", async () => {
    await withTempDir(async (dir) => {
      const keys = generateKeyPair();
      const identity: SessionIdentity = {
        url: "https://minga.test",
        agent: agentIdFromPublicKey(keys.publicKey),
        publicKey: keys.publicKey,
        privateKey: keys.privateKey,
        model: "m",
        harness: "h",
        lastAssignment: {
          attempt: "A-5", role: "build",
          leaseUntil: new Date(Date.now() + 5 * 60_000).toISOString(), task: "T-4",
        },
        lastSubmission: "S-7",
      };
      writeAgent(dir, identity);
      const loaded = readAgent(dir)!;
      expect(loaded.lastAssignment).toEqual(identity.lastAssignment);
      expect(loaded.lastSubmission).toBe("S-7");

      const mock = mockFetch((call) => {
        if (call.url.endsWith("/api/project")) return json(project);
        if (call.url.endsWith("/api/attempt/A-5")) {
          return json({ id: "A-5", task: "T-4", agent: loaded.agent, role: "build", state: "live", leaseUntil: identity.lastAssignment!.leaseUntil, taskStatus: "open" });
        }
        return json({
          id: "S-7", status: "queued", position: 2, attempt: "A-5", task: "T-4",
          agent: loaded.agent, model: "m", claim: "solves", message: "m", files: [],
          bytes: 0, queuedAt: "", runs: 0, points: 0,
        });
      });
      const result = await statusCommand(createClient("https://minga.test", keys, mock.fn), loaded);
      expect(result.text).toContain("attempt: A-5 (build) on T-4");
      expect(result.text).toMatch(/lease [1-5]m left/);
      expect(result.text).toContain("submission: S-7 queued #2");
      expect(mock.calls.map((call) => new URL(call.url).pathname)).toEqual([
        "/api/project", "/api/attempt/A-5", "/api/submission/S-7",
      ]);
      expect(result.data.submission!.status).toBe("queued");
      expect(result.data.assignment!.attempt).toBe("A-5");
    });
  });

  test("an expired lease and a missing submission stay readable", async () => {
    await withTempDir(async (dir) => {
      const keys = generateKeyPair();
      writeAgent(dir, {
        url: "https://minga.test", agent: agentIdFromPublicKey(keys.publicKey),
        publicKey: keys.publicKey, privateKey: keys.privateKey, model: "m", harness: "h",
        lastAssignment: { attempt: "A-1", role: "plan", leaseUntil: "2020-01-01T00:00:00.000Z", task: "T-1" },
        lastSubmission: "S-99",
      });
      const mock = mockFetch((call) => {
        if (call.url.endsWith("/api/project")) return json(project);
        return json({ error: "no submission" }, 404);
      });
      const result = await statusCommand(
        createClient("https://minga.test", keys, mock.fn), readAgent(dir)!,
      );
      expect(result.text).toContain("lease expired");
      expect(result.text).toContain("submission: S-99 (unavailable)");
      expect(result.data.submission).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------- init

describe("init", () => {
  const base = { name: 'a "quoted" name', goal: "line one\nline two", scope: "src/**", check: "bun test {files}", paths: ["src/**", "docs/**"] };

  test("scaffolds a fresh git repo, appends .minga/ and reports next commands", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, ".git"));
      writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
      const result = initCommand({ dir, ...base, url: "http://127.0.0.1:7777/" });
      expect(result.data.projectToml).toContain('name = "a \\"quoted\\" name"');
      expect(result.data.projectToml).toContain("goal = \"line one\\nline two\"");
      expect(result.data.projectToml).toContain('paths = ["src/**", "docs/**"]');
      expect(result.data.projectToml).toContain("\n[rules]\n");
      expect(result.data.projectToml).toContain("\n[rules.roles]\n");
      expect(result.data.projectToml).toContain("# [[task]]");
      expect(result.data.head).toMatch(/^ed25519:/);
      expect(result.data.headKeyFile).toBe(join(dir, ".minga", "head.json"));
      expect(result.data.next).toEqual([
        `minga serve --repo ${dir}`,
        "share http://127.0.0.1:7777/join",
      ]);
      expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain(".minga/");
      expect(readHead(dir)!.publicKey).toHaveLength(43);
      expect(result.text).toContain("next:");
    });
  });

  test("refuses to overwrite, --force allows it, non-git repo errors", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, ".git"));
      initCommand({ dir, ...base });
      expect(() => initCommand({ dir, ...base })).toThrow(/already exists; pass --force/);
      const forced = initCommand({ dir, ...base, force: true });
      expect(forced.data.projectToml).toContain("name =");
      expect(readFileSync(join(dir, ".gitignore"), "utf8").split(".minga/")).toHaveLength(2);
    });
    withTempDir((dir) => {
      expect(() => initCommand({ dir, ...base })).toThrow(/not a git repository; run "git init/);
    });
  });

  test("TOML basic strings escape controls", () => {
    expect(tomlBasicString('a\\b"c\n\t\u0001')).toBe('"a\\\\b\\"c\\n\\t\\u0001"');
    expect(renderProjectToml({ ...base, head: "ed25519:abc" })).toContain('head = "ed25519:abc"');
  });

  test("uncommenting any single rules line still yields a valid config", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, ".git"));
      const result = initCommand({ dir, ...base });
      const toml = result.data.projectToml;
      expect(() => Bun.TOML.parse(toml)).not.toThrow();
      expect(parseProject(toml).rules.width).toBe(3);

      const ruleLines = toml.split("\n").filter((line) =>
        /^# (width|lease_minutes|max_attempts_per_agent|default_points|accept|explore|build|attack|distill|plan) = /.test(line),
      );
      expect(ruleLines).toHaveLength(10);
      for (const line of ruleLines) {
        const edited = toml.replace(line, line.slice(2));
        expect(() => Bun.TOML.parse(edited)).not.toThrow();
        expect(() => parseProject(edited)).not.toThrow();
      }

      // The bug this guards: an uncommented width must stay inside [rules].
      const widthOnly = Bun.TOML.parse(toml.replace("# width = 3", "width = 3")) as Record<string, unknown>;
      expect(widthOnly.width).toBeUndefined();
      expect((widthOnly.rules as Record<string, unknown>).width).toBe(3);

      const planOnly = Bun.TOML.parse(toml.replace("# plan = 0", "plan = 0")) as {
        rules: { roles: Record<string, unknown> };
      };
      expect(planOnly.rules.roles.plan).toBe(0);
    });
  });
});

// ---------------------------------------------------------------- serve / doctor

describe("serve and doctor", () => {
  const root = join(import.meta.dir, "..");

  test("finds the package root from source and bundle URLs", () => {
    expect(findPackageRoot(pathToFileURL(join(root, "src", "cli", "main.ts")).href)).toBe(root);
    expect(findPackageRoot(pathToFileURL(join(root, "dist", "minga.mjs")).href)).toBe(root);
  });

  test("serve checks bun, finds the worker and passes flags through", async () => {
    let spawned: { command: string; args: string[] } | null = null;
    const syncRunner = () => ({ status: 0, stdout: "1.4.4\n", stderr: "" });
    const spawnFake = ((command: string, args: string[]) => {
      spawned = { command, args };
      return {
        on(_event: string, cb: (code: number | null) => void) { cb(0); },
        kill() { return true; },
      };
    }) as unknown as NonNullable<Parameters<typeof serveCommand>[1]>["spawn"];

    const result = await serveCommand(
      ["--repo", "x", "--port", "8000", "--db", "d.db", "--json", "--dir", "identity"],
      { bunPath: "bun-test", syncRunner, spawn: spawnFake, packageRoot: root },
    );
    expect(result.data.code).toBe(0);
    expect(spawned!.command).toBe("bun-test");
    expect(spawned!.args[0]).toBe(join(root, "src", "server", "main.ts"));
    expect(spawned!.args).toContain("--repo");
    expect(spawned!.args).toContain("8000");
    expect(spawned!.args).not.toContain("--json");
    expect(spawned!.args).not.toContain("identity");
  });

  test("serve errors cleanly when bun is missing", async () => {
    const missing = () => ({ status: 1, stdout: "", stderr: "" });
    await expect(serveCommand([], { syncRunner: missing, packageRoot: root })).rejects.toThrow(
      "Minga's server runs on Bun. Install it: npm install -g bun (or see https://bun.sh), then re-run this command.",
    );
    await expect(serveCommand([], {
      syncRunner: () => ({ status: 0, stdout: "1.2.9", stderr: "" }), packageRoot: root,
    })).rejects.toThrow(/needs Bun 1.3 or newer/);
  });

  test("doctor reports one check per item and a compact config line", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, ".git"));
      writeFileSync(join(dir, "project.toml"), 'name = "x"\n');
      const dryRun = {
        ok: true,
        project: {
          name: "x", check: "bun test {files}", paths: ["src/**"], branch: "main",
          head: "0123456789abcdef0123456789abcdef01234567", recheck: "on-overlap", checkKeep: [],
        },
        checkConcurrency: 3,
        seedTasks: 2,
      };
      const runner = (command: string, args: string[]): RunResult => {
        if (command === "bun" && args[0] === "--version") return { status: 0, stdout: "1.4.4", stderr: "" };
        if (command === "git") return { status: 0, stdout: "git version 2.44.0", stderr: "" };
        if (args.includes("--dry-run")) return { status: 0, stdout: JSON.stringify(dryRun, null, 2), stderr: "" };
        return { status: 1, stdout: "", stderr: "unexpected command" };
      };
      const result = doctorCommand({ dir, packageRoot: root }, { syncRunner: runner });
      expect(result.data.checks.map((c) => c.name)).toEqual(["node", "bun", "git", "repo", "project.toml", "config"]);
      expect(result.data.checks.every((c) => c.ok)).toBe(true);
      expect(result.text).toContain("ok  node");
      expect(result.text).toContain(
        'ok  config  x: check "bun test {files}", branch main @ 0123456, 3 check slot(s), recheck on-overlap',
      );
      expect(result.text.split("config").length).toBe(2);
      expect(result.text).not.toContain('"checkConcurrency"');
      expect(result.data.configDryRun).toEqual(dryRun);

      const broken = doctorCommand({ dir: join(dir, "nope"), packageRoot: root }, { syncRunner: runner });
      expect(broken.data.checks.find((c) => c.name === "repo")!.ok).toBe(false);
      expect(broken.data.checks.find((c) => c.name === "repo")!.fix).toMatch(/git init/);
    });
  });

  test("doctor uses the real command runner when none is injected", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, ".git"));
      writeFileSync(join(dir, "project.toml"), 'name = "x"\n');
      const result = doctorCommand({ dir, packageRoot: root });
      expect(result.data.checks.find((c) => c.name === "git")!.detail).toContain("git version");
      expect(result.data.checks.find((c) => c.name === "bun")!.ok).toBe(true);
    });
  });
});

// ---------------------------------------------------------------- join doc

describe("join document", () => {
  test("is short, imperative and covers kit, loop, MCP, conduct and exits", () => {
    const doc = renderJoinDoc(project, "https://minga.example/");
    expect(doc).toContain(project.name);
    expect(doc).toContain(project.goal);
    expect(doc).toContain(project.scope);
    expect(doc).toContain("bun test {files}");
    expect(doc).toContain("src/**, docs/**");
    expect(doc).toContain("npx -y minga-swarm@latest <cmd>");
    expect(doc).toContain("curl -fsSL https://minga.example/kit/minga.mjs -o minga.mjs && node minga.mjs <cmd>");
    expect(doc).toContain("GET THE CODE");
    expect(doc).toContain("git clone -b main https://minga.example/repo.git work && cd work");
    expect(doc).toContain("git-ignores .minga/");
    expect(doc.indexOf("GET THE CODE")).toBeLessThan(doc.indexOf("GET THE KIT"));
    expect(doc.indexOf("git clone")).toBeLessThan(doc.indexOf("minga join"));
    expect(doc).toContain("minga sync");
    expect(doc).not.toContain("git pull");
    expect(doc).toContain("minga check <file...>");
    expect(doc).toContain("ROLES AND CLAIMS");
    expect(doc).toContain("The first accepted");
    expect(doc).toContain("minga next --wait 600");
    expect(doc).toContain("minga beat <attempt>");
    expect(doc).toContain("--handoff");
    expect(doc).toContain("npx -y minga-swarm@latest mcp");
    expect(doc).toContain("minga_join");
    expect(doc).toContain("EXIT CODES");
    expect(doc).toContain("2 submission rejected");
    expect(doc).toContain("3 no task available");
    expect(doc).toContain("4 project finished");
    expect(doc).toContain('"no free task yet; waiting (Ns left)"');
    expect(doc).toContain("minga tasks [--open]");
    expect(doc).toContain("npx -y minga-swarm@latest mcp");
    expect(doc).toContain("If done is true, stop");
    expect(doc).toContain('head agent or 2 votes decides');
    expect(doc).not.toContain("minga.example//");
    expect(doc.split("\n").length).toBeLessThan(100);
  });
});

// ---------------------------------------------------------------- built kit on Node

describe("bundle on plain Node", () => {
  let kitDir = "";
  let kit = "";

  beforeAll(() => {
    kitDir = mkdtempSync(join(tmpdir(), "minga-kit-"));
    kit = join(kitDir, "minga.mjs");
    const bun = process.versions.bun ? process.execPath : "bun";
    const build = spawnSync(bun, ["build", "src/cli/main.ts", "--target=node", `--outfile=${kit}`], {
      cwd: join(import.meta.dir, ".."), encoding: "utf8",
    });
    expect(build.status).toBe(0);
    expect(readFileSync(kit, "utf8").split("\n")[0]).toBe("#!/usr/bin/env node");
  }, 60_000);

  afterAll(() => { if (kitDir) rmSync(kitDir, { recursive: true, force: true }); });

  /** Async spawn keeps the in-process Bun.serve event loop free to answer. */
  function runKit(args: string[], cwd?: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn("node", [kit, ...args], {
        cwd: cwd ?? kitDir, stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Uint8Array) => { stdout += Buffer.from(chunk).toString("utf8"); });
      child.stderr.on("data", (chunk: Uint8Array) => { stderr += Buffer.from(chunk).toString("utf8"); });
      const timer = setTimeout(() => { child.kill(); reject(new Error(`kit timed out: ${args.join(" ")}`)); }, 15_000);
      child.on("error", (err) => { clearTimeout(timer); reject(err); });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ status: code, stdout, stderr });
      });
    });
  }

  test("--version prints the package.json version", async () => {
    const result = await runKit(["--version"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe((await Bun.file(new URL("../package.json", import.meta.url)).json()).version);
  });

  test("submit waits for a verdict: exit 0 accepted, exit 2 rejected", async () => {
    const accepted = startFakeServer({ verdict: "accepted", finalDelayMs: 120 });
    const rejected = startFakeServer({ verdict: "rejected", finalDelayMs: 120 });
    try {
      await withTempDir(async (dir) => {
        withIdentity(dir, accepted.url);
        writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
        const ok = await runKit([
          "submit", "A-1", "--claim", "solves", "-m", "do it", "a.ts",
          "--root", dir, "--dir", dir, "--url", accepted.url,
        ], dir);
        expect(ok.status).toBe(0);
        expect(ok.stderr).toContain("queued S-1 (#1 in line)");
        expect(ok.stderr).toContain("checking S-1 (run 1)");
        expect(ok.stderr).not.toContain("verdict");
        expect(ok.stdout).not.toContain("verdict accepted S-1");
        expect(ok.stdout).toContain("verdict: accepted");
        expect(ok.stdout).toContain("exit code: 0");
        expect(ok.stdout).toContain("commit: deadbeef");
        expect(ok.stdout).toContain("points: 10");
        expect(ok.stdout).toContain("next: minga sync && minga next --wait 600");

        withIdentity(dir, rejected.url);
        const bad = await runKit([
          "submit", "A-2", "--claim", "progress", "-m", "try", "a.ts",
          "--root", dir, "--dir", dir, "--url", rejected.url,
        ], dir);
        expect(bad.status).toBe(2);
        expect(bad.stderr).not.toContain("verdict rejected");
        expect(bad.stdout).toContain("verdict: rejected");
        expect(bad.stdout).toContain("output tail:");
        expect(bad.stdout).toContain("AssertionError: nope");
        expect(bad.stdout).toContain('next: fix and run "minga submit A-2 ..." again');
      });
    } finally {
      accepted.server.stop();
      rejected.server.stop();
    }
  });

  test("an over-long -m is truncated with a stderr notice, not rejected", async () => {
    const server = startFakeServer({ verdict: "accepted", finalDelayMs: 100 });
    try {
      await withTempDir(async (dir) => {
        withIdentity(dir, server.url);
        writeFileSync(join(dir, "a.ts"), "x");
        const result = await runKit([
          "submit", "A-1", "--claim", "solves", "-m", `${"x".repeat(220)}\nsecond line`, "a.ts",
          "--root", dir, "--dir", dir, "--url", server.url,
        ], dir);
        expect(result.status).toBe(0);
        expect(result.stderr).toContain("submit message over 200 chars");
        const sent = [...server.submissions.values()][0] as { message: string };
        expect(sent.message).toBe(`${"x".repeat(197)}...`);
      });
    } finally {
      server.server.stop();
    }
  });

  test("--no-wait returns after the queued line; result shows final or pending", async () => {
    const server = startFakeServer({ verdict: "accepted", finalDelayMs: 1000 });
    try {
      await withTempDir(async (dir) => {
        withIdentity(dir, server.url);
        writeFileSync(join(dir, "a.ts"), "x");
        const queued = await runKit([
          "submit", "A-1", "--claim", "solves", "-m", "m", "a.ts",
          "--root", dir, "--dir", dir, "--url", server.url, "--no-wait",
        ], dir);
        expect(queued.status).toBe(0);
        expect(queued.stderr).toContain("queued S-1 (#1 in line)");
        expect(queued.stdout).toContain("submission S-1: queued #1");
        expect(queued.stdout).not.toContain("verdict:");

        const pending = await runKit(["result", "S-1", "--dir", dir, "--url", server.url], dir);
        expect(pending.status).toBe(0);
        expect(pending.stdout).toContain("queued #1");

        const waited = await runKit(["result", "S-1", "--wait", "--dir", dir, "--url", server.url], dir);
        expect(waited.status).toBe(0);
        expect(waited.stdout).toContain("verdict: accepted");
      });
    } finally {
      server.server.stop();
    }
  });

  test("next --wait loops then exits 3 when nothing is available", async () => {
    const server = startFakeServer({ assignment: null, nextDelayMs: 300 });
    try {
      await withTempDir(async (dir) => {
        withIdentity(dir, server.url);
        const none = await runKit(["next", "--wait", "2", "--dir", dir, "--url", server.url], dir);
        expect(none.status).toBe(3);
        expect(none.stdout).toContain("nothing to do, retry in 5s");
        const pollLines = none.stderr.trim().split("\n");
        expect(pollLines.length).toBeGreaterThan(1);
        for (const line of pollLines) {
          expect(line).toMatch(/^no free task yet; waiting \((\d+)s left\)$/);
        }
      });
    } finally {
      server.server.stop();
    }
  });

  test("next stops with exit 4 and the done message when the project is finished", async () => {
    const server = startFakeServer({ done: true });
    try {
      await withTempDir(async (dir) => {
        withIdentity(dir, server.url);
        const done = await runKit(["next", "--wait", "600", "--dir", dir, "--url", server.url], dir);
        expect(done.status).toBe(4);
        expect(done.stdout).toContain("the project has no open tasks left. Stop here.");
        expect(done.stderr).not.toContain("no free task yet");

        const raw = await runKit(["next", "--json", "--dir", dir, "--url", server.url], dir);
        expect(raw.status).toBe(4);
        expect(JSON.parse(raw.stdout)).toEqual({ assignment: null, done: true });
      });
    } finally {
      server.server.stop();
    }
  });

  test("tasks prints the tree, --open filters it and --json is raw", async () => {
    const overview: TasksResponse = {
      tasks: [
        { id: "T-1", title: "Root", parent: null, status: "solved", points: 0, live: 0, leaf: false },
        { id: "T-3", title: "isPrime", parent: "T-1", status: "open", points: 20, live: 2, leaf: true },
      ],
      open: 1,
      done: false,
    };
    const server = startFakeServer({ tasks: overview });
    try {
      await withTempDir(async (dir) => {
        withIdentity(dir, server.url);
        const tree = await runKit(["tasks", "--dir", dir, "--url", server.url], dir);
        expect(tree.status).toBe(0);
        expect(tree.stdout).toContain("T-1  solved      0 pts  Root [area]");
        expect(tree.stdout).toContain("  T-3  open · 2 live  20 pts  isPrime");
        expect(tree.stdout).toContain("open leaf tasks: 1");

        const open = await runKit(["tasks", "--open", "--dir", dir, "--url", server.url], dir);
        expect(open.status).toBe(0);
        expect(open.stdout).not.toContain("T-1  solved");
        expect(open.stdout).toContain("  T-3  open · 2 live  20 pts  isPrime");

        const raw = await runKit(["tasks", "--json", "--dir", dir, "--url", server.url], dir);
        expect(raw.status).toBe(0);
        expect(JSON.parse(raw.stdout)).toEqual(overview);
      });
    } finally {
      server.server.stop();
    }
  });

  test("next with an assignment exits 0 and prints it compactly", async () => {
    const server = startFakeServer({ assignment: { ...assignment, head: "abcdef1234567890abcdef" } });
    try {
      await withTempDir(async (dir) => {
        withIdentity(dir, server.url);
        const got = await runKit(["next", "--dir", dir, "--url", server.url], dir);
        expect(got.status).toBe(0);
        expect(got.stdout).toContain("attempt   A-5");
        expect(got.stdout).toContain("T-4  Wire the parser");
        expect(got.stdout).toContain("head abcdef1 (minga sync if your checkout is older)");
      });
    } finally {
      server.server.stop();
    }
  });

  test("next without --wait gives the wait command and exits 3", async () => {
    const server = startFakeServer({ assignment: null });
    try {
      await withTempDir(async (dir) => {
        withIdentity(dir, server.url);
        const none = await runKit(["next", "--dir", dir, "--url", server.url], dir);
        expect(none.status).toBe(3);
        expect(none.stdout.trim()).toBe('nothing to do right now; run "minga next --wait 600" to wait for a task');
      });
    } finally {
      server.server.stop();
    }
  });

  test("next and submit persist work that status recovers", async () => {
    const server = startFakeServer({ assignment, verdict: "accepted", finalDelayMs: 100 });
    try {
      await withTempDir(async (dir) => {
        withIdentity(dir, server.url);
        writeFileSync(join(dir, "a.ts"), "x");
        const got = await runKit(["next", "--dir", dir, "--url", server.url], dir);
        expect(got.status).toBe(0);
        let stored = JSON.parse(readFileSync(join(dir, ".minga", "agent.json"), "utf8"));
        expect(stored.lastAssignment).toEqual({
          attempt: "A-5", role: "build", leaseUntil: assignment.leaseUntil, task: "T-4",
        });

        const sent = await runKit([
          "submit", "A-5", "--claim", "solves", "-m", "m", "a.ts",
          "--root", dir, "--dir", dir, "--url", server.url,
        ], dir);
        expect(sent.status).toBe(0);
        stored = JSON.parse(readFileSync(join(dir, ".minga", "agent.json"), "utf8"));
        expect(stored.lastSubmission).toBe("S-1");

        const status = await runKit(["status", "--dir", dir, "--url", server.url], dir);
        expect(status.status).toBe(0);
        expect(status.stdout).toContain("attempt: A-5 (build) on T-4");
        expect(status.stdout).toContain("lease expired");
        expect(status.stdout).toContain("submission: S-1 accepted");
      });
    } finally {
      server.server.stop();
    }
  });

  test("--json stdout is pure JSON; progress stays on stderr", async () => {
    const server = startFakeServer({ verdict: "rejected", finalDelayMs: 100 });
    try {
      await withTempDir(async (dir) => {
        withIdentity(dir, server.url);
        writeFileSync(join(dir, "a.ts"), "x");
        const result = await runKit([
          "submit", "A-1", "--claim", "solves", "-m", "m", "a.ts",
          "--root", dir, "--dir", dir, "--url", server.url, "--json",
        ], dir);
        expect(result.status).toBe(2);
        expect(() => JSON.parse(result.stdout)).not.toThrow();
        expect(JSON.parse(result.stdout).status).toBe("rejected");
        expect(result.stdout).not.toContain("verdict rejected");
        expect(result.stderr).toContain("queued S-1 (#1 in line)");
        expect(result.stderr).not.toContain("verdict rejected");
      });
    } finally {
      server.server.stop();
    }
  });

  test("a failed check with no output says so", async () => {
    const server = startFakeServer({
      verdict: "rejected", finalDelayMs: 100, outputTail: "",
    });
    try {
      await withTempDir(async (dir) => {
        withIdentity(dir, server.url);
        writeFileSync(join(dir, "a.ts"), "x");
        const result = await runKit([
          "submit", "A-1", "--claim", "solves", "-m", "m", "a.ts",
          "--root", dir, "--dir", dir, "--url", server.url,
        ], dir);
        expect(result.status).toBe(2);
        expect(result.stdout).toContain("output: (the check printed nothing; exit code 1)");
        expect(result.stdout).not.toContain("output tail:");
        expect(result.stdout).toContain('next: fix and run "minga submit A-1 ..." again');
      });
    } finally {
      server.server.stop();
    }
  });

  test("AGENTS.md opens with a six-line fast path for both roles", () => {
    const lines = readFileSync(join(import.meta.dir, "..", "AGENTS.md"), "utf8").split("\n");
    expect(lines[0]).toBe("## Fast path");
    expect(lines.slice(0, 6).filter((line) => line.startsWith("Host:")).length).toBe(2);
    expect(lines.slice(0, 6).filter((line) => line.startsWith("Volunteer:")).length).toBe(3);
    expect(lines[6]).toBe("");
    expect(lines[7]).toBe("# AGENTS.md");
    expect(lines.slice(1, 6).join("\n")).toContain("minga serve");
    expect(lines.slice(1, 6).join("\n")).toContain("npx -y minga-swarm@latest join");
  });

  test("--json errors print {error} on stdout and exit 1", async () => {
    await withTempDir(async (dir) => {
      const result = await runKit(["status", "--dir", dir, "--json"], dir);
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        error: `no agent identity at ${join(dir, ".minga", "agent.json")}; run "minga join <url>" first`,
      });
    });
  });

  test("help and unknown command have stable exits", async () => {
    expect((await runKit(["help"])).status).toBe(0);
    expect((await runKit([])).status).toBe(0);
    const bad = await runKit(["frobnicate"]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("unknown command: frobnicate");
  });

  test("the built kit has no Bun API dependency", () => {
    const source = readFileSync(kit, "utf8");
    expect(source).not.toContain("Bun.serve");
    expect(source).not.toContain("Bun.Glob");
  });
});
