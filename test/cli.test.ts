import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { HEADER } from "../src/core/protocol.ts";
import type { ProjectInfo } from "../src/core/protocol.ts";
import { agentIdFromPublicKey, canonicalRequest, generateKeyPair, verifyMessage } from "../src/identity/keys.ts";
import type { FetchLike } from "../src/cli/client.ts";
import { createClient } from "../src/cli/client.ts";
import {
  formatRules, headKeygenCommand, joinCommand, nextCommand, parseAcceptPolicy, parseCli,
  parseRuleArgs, readSubmissionFiles, renderSubmission, submitCommand,
} from "../src/cli/commands.ts";
import { doctorCommand } from "../src/cli/doctor.ts";
import { initCommand, renderProjectToml, tomlBasicString } from "../src/cli/init.ts";
import { renderJoinDoc } from "../src/cli/join-doc.ts";
import { findPackageRoot, serveCommand, type RunResult } from "../src/cli/runtime.ts";
import { agentPath, readAgent, readHead, writeAgent, writeHead } from "../src/cli/store.ts";

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
  nextDelayMs?: number;
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
      if (req.method === "POST" && url.pathname === "/api/join") {
        const body = await req.json() as { publicKey: string };
        return json({ agent: agentIdFromPublicKey(body.publicKey), rejoin: false, project, live: [] });
      }
      if (req.method === "POST" && url.pathname === "/api/next") {
        const body = await req.json() as { wait?: number };
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
        setTimeout(() => { entry.status = "checking"; }, Math.floor(finalDelay / 2));
        setTimeout(() => {
          entry.status = verdict;
          entry.ok = verdict === "accepted";
          entry.exitCode = verdict === "accepted" ? 0 : 1;
          entry.outputTail = verdict === "accepted" ? "" : "AssertionError: nope\n  at a.ts:1";
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
          // Release the first long-poll at "checking" so the client can print
          // the queued -> checking -> verdict progression.
          const deadline = Date.now() + wait * 1000;
          while (entry.status === "queued" && Date.now() < deadline) await sleep(10);
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
    {
      name: "head keygen",
      argv: ["head", "keygen", "--url", "https://m.example"],
      command: "head", action: "keygen", positionals: [], options: { url: "https://m.example" },
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
    await expect(createClient("https://minga.test", keys, failing.fn).next()).rejects.toThrow("409: lease expired");
    const plain = mockFetch(() => new Response("boom", { status: 500 }));
    await expect(createClient("https://minga.test", keys, plain.fn).project()).rejects.toThrow("500: boom");
  });
});

// ---------------------------------------------------------------- join / store / head

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
      "width=2 leaseMinutes=10 maxAttemptsPerAgent=2 defaultPoints=10 accept=head-or-votes:2",
    );
  });
});

// ---------------------------------------------------------------- submit / result / next logic

describe("submit and result logic", () => {
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
      expect(progress).toEqual(["queued S-7 #2", "verdict accepted S-7"]);
      expect(result.text).toContain("verdict: accepted");
      expect(result.text).toContain("exit code: 0");
      expect(result.text).toContain("commit: abc1234");
      expect(result.text).toContain("points: 10");
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
      expect(result.text).toBe("queued S-9 #1");
      expect(mock.calls).toHaveLength(1);
    });
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
    expect(result.text).toBe("nothing to do, retry in 42s");
    expect(mock.calls).toHaveLength(1);
    expect(JSON.parse(mock.calls[0]!.init.body as string).wait).toBeUndefined();
  });

  test("repeats with capped long-poll until an assignment arrives", async () => {
    let calls = 0;
    const mock = mockFetch(() => {
      calls++;
      return json(calls < 3 ? { assignment: null, retryAfterSeconds: 5 } : { assignment });
    });
    const result = await nextCommand(createClient("https://minga.test", generateKeyPair(), mock.fn), { wait: 60 });
    expect(calls).toBe(3);
    expect(result.text).toContain("attempt   A-5");
    expect(result.text).toContain("role      build");
    expect(result.text).toContain("T-4  Wire the parser");
    expect(result.text).toContain("T-1 Root > T-4 Wire the parser");
    expect(result.text).toContain("start at parse");
    expect(result.text).toContain("A-6 fedcba9876543210 claude-y attack — fuzz it");
    const waits = mock.calls.map((c) => JSON.parse(c.init.body as string).wait as number);
    expect(waits[0]).toBe(30);
    expect(Math.max(...waits)).toBeLessThanOrEqual(30);
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
      expect(result.data.projectToml).toContain("# [rules]");
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

  test("doctor reports one check per item and a config dry-run", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, ".git"));
      writeFileSync(join(dir, "project.toml"), 'name = "x"\n');
      const runner = (command: string, args: string[]): RunResult => {
        if (command === "bun" && args[0] === "--version") return { status: 0, stdout: "1.4.4", stderr: "" };
        if (command === "git") return { status: 0, stdout: "git version 2.44.0", stderr: "" };
        if (args.includes("--dry-run")) return { status: 0, stdout: '{"name":"x","tasks":0}', stderr: "" };
        return { status: 1, stdout: "", stderr: "unexpected command" };
      };
      const result = doctorCommand({ dir, packageRoot: root }, { syncRunner: runner });
      expect(result.data.checks.map((c) => c.name)).toEqual(["node", "bun", "git", "repo", "project.toml", "config"]);
      expect(result.data.checks.every((c) => c.ok)).toBe(true);
      expect(result.text).toContain("ok  node");
      expect(result.text).toContain('ok  config  {"name":"x","tasks":0}');

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
    expect(doc).toContain("npx -y minga@latest <cmd>");
    expect(doc).toContain("curl -fsSL https://minga.example/kit/minga.mjs -o minga.mjs && node minga.mjs <cmd>");
    expect(doc).toContain("minga next --wait 600");
    expect(doc).toContain("minga beat <attempt>");
    expect(doc).toContain("--handoff");
    expect(doc).toContain("npx -y minga mcp");
    expect(doc).toContain("minga_join");
    expect(doc).toContain("EXIT CODES");
    expect(doc).toContain("2 submission rejected");
    expect(doc).toContain("3 no task available");
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

  test("--version prints 0.1.0", async () => {
    const result = await runKit(["--version"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("0.1.0");
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
        expect(ok.stdout).toContain("queued S-1 #1");
        expect(ok.stdout).toContain("checking S-1");
        expect(ok.stdout).toContain("verdict accepted S-1");
        expect(ok.stdout).toContain("verdict: accepted");
        expect(ok.stdout).toContain("exit code: 0");
        expect(ok.stdout).toContain("commit: deadbeef");
        expect(ok.stdout).toContain("points: 10");

        withIdentity(dir, rejected.url);
        const bad = await runKit([
          "submit", "A-2", "--claim", "progress", "-m", "try", "a.ts",
          "--root", dir, "--dir", dir, "--url", rejected.url,
        ], dir);
        expect(bad.status).toBe(2);
        expect(bad.stdout).toContain("verdict: rejected");
        expect(bad.stdout).toContain("output tail:");
        expect(bad.stdout).toContain("AssertionError: nope");
      });
    } finally {
      accepted.server.stop();
      rejected.server.stop();
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
        expect(queued.stdout).toContain("queued S-1 #1");
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
      });
    } finally {
      server.server.stop();
    }
  });

  test("next with an assignment exits 0 and prints it compactly", async () => {
    const server = startFakeServer({ assignment });
    try {
      await withTempDir(async (dir) => {
        withIdentity(dir, server.url);
        const got = await runKit(["next", "--dir", dir, "--url", server.url], dir);
        expect(got.status).toBe(0);
        expect(got.stdout).toContain("attempt   A-5");
        expect(got.stdout).toContain("T-4  Wire the parser");
      });
    } finally {
      server.server.stop();
    }
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
