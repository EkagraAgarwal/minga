import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProjectInfo } from "../src/core/protocol.ts";
import { agentIdFromPublicKey } from "../src/identity/keys.ts";
import type { FetchLike } from "../src/cli/client.ts";
import type { ParsedCli } from "../src/cli/commands.ts";
import type { DispatchOutcome } from "../src/cli/dispatch.ts";
import { createMcpHandler, MCP_PROTOCOL_VERSION, MCP_TOOLS, toolToCli } from "../src/cli/mcp.ts";
import { agentPath } from "../src/cli/store.ts";

const project: ProjectInfo = {
  name: "Minga",
  goal: "Self-hosted coordination.",
  scope: "src/**",
  check: "bun test {files}",
  paths: ["src/**"],
  headAgent: "0123456789abcdef",
  rules: {
    width: 2,
    leaseMinutes: 10,
    maxAttemptsPerAgent: 2,
    roles: { explore: 1, build: 2, attack: 1, distill: 1, plan: 1 },
    accept: { mode: "head" },
    defaultPoints: 10,
  },
};

function rpc(id: number | string, method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
}

function decode(line: string | null): Record<string, any> {
  expect(line).not.toBeNull();
  return JSON.parse(line!) as Record<string, any>;
}

function canned(outcome: Partial<DispatchOutcome> = {}) {
  return async (_cli: ParsedCli): Promise<DispatchOutcome> => ({
    result: { text: "joined Minga as agent abc", data: { agent: "abc" } },
    code: 0,
    ...outcome,
  });
}

async function withTempDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "minga-mcp-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("MCP protocol", () => {
  test("initialize negotiates 2025-06-18 and advertises tools", async () => {
    const handler = createMcpHandler({ dir: process.cwd(), execute: canned() });
    const reply = decode(await handler(rpc(1, "initialize", { protocolVersion: "2025-06-18" })));
    expect(reply.jsonrpc).toBe("2.0");
    expect(reply.id).toBe(1);
    expect(reply.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(reply.result.capabilities).toEqual({ tools: {} });
    expect(reply.result.serverInfo.name).toBe("minga");
  });

  test("ping answers, initialized notifications are silent", async () => {
    const handler = createMcpHandler({ dir: process.cwd(), execute: canned() });
    expect(decode(await handler(rpc(2, "ping"))).result).toEqual({});
    expect(await handler(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))).toBeNull();
    expect(await handler(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "notifications/initialized" }))).toBeNull();
  });

  test("tools/list exposes all twelve tools with JSON Schema inputs", async () => {
    const handler = createMcpHandler({ dir: process.cwd(), execute: canned() });
    const reply = decode(await handler(rpc(4, "tools/list")));
    expect(reply.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "minga_join", "minga_next", "minga_beat", "minga_note", "minga_submit", "minga_result",
      "minga_release", "minga_propose_task", "minga_propose_impossible", "minga_vote",
      "minga_status", "minga_board",
    ]);
    for (const tool of reply.result.tools) {
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.inputSchema.type).toBe("object");
      expect(typeof tool.inputSchema.properties).toBe("object");
    }
    expect(MCP_TOOLS.length).toBe(12);

    const joined = reply.result.tools.find((t: { name: string }) => t.name === "minga_join");
    const next = reply.result.tools.find((t: { name: string }) => t.name === "minga_next");
    const submitted = reply.result.tools.find((t: { name: string }) => t.name === "minga_submit");
    const result = reply.result.tools.find((t: { name: string }) => t.name === "minga_result");
    expect(joined.description).toContain("minga_next");
    expect(joined.description).toContain("minga_submit");
    expect(next.description).toContain("call again if assignment is null");
    expect(next.description).toContain("30 seconds");
    expect(next.inputSchema.properties.wait.description).toContain("default 30");
    expect(submitted.description).toContain("waits for the verdict");
    expect(submitted.description).toContain("~10 minutes");
    expect(submitted.description).toContain("wait:false");
    expect(submitted.description).toContain("minga_result");
    expect(result.description).toContain("wait:false");
  });

  test("unknown methods use -32601; bad JSON uses -32700", async () => {
    const handler = createMcpHandler({ dir: process.cwd(), execute: canned() });
    expect(decode(await handler(rpc(5, "frobnicate"))).error).toEqual({
      code: -32601, message: "Method not found: frobnicate",
    });
    expect(decode(await handler("{not json")).error.code).toBe(-32700);
    expect(decode(await handler(JSON.stringify({ jsonrpc: "1.0", id: 6, method: "ping" }))).error.code).toBe(-32600);
  });
});

describe("tool calls", () => {
  test("tools/call returns CLI text plus structuredContent", async () => {
    const handler = createMcpHandler({ dir: process.cwd(), execute: canned() });
    const reply = decode(await handler(rpc(7, "tools/call", {
      name: "minga_join",
      arguments: { url: "http://minga.test", model: "m", harness: "h" },
    })));
    expect(reply.result.content).toEqual([{ type: "text", text: "joined Minga as agent abc" }]);
    expect(reply.result.structuredContent).toEqual({ agent: "abc" });
    expect(reply.result.isError).toBeUndefined();
  });

  test("thrown errors and non-zero exit codes become isError results", async () => {
    const failing = createMcpHandler({
      dir: process.cwd(),
      execute: async () => { throw new Error("first line\nsecond line"); },
    });
    const error = decode(await failing(rpc(8, "tools/call", { name: "minga_status", arguments: {} })));
    expect(error.result.isError).toBe(true);
    expect(error.result.content[0].text).toBe("first line");
    expect(error.result.structuredContent).toBeUndefined();

    const rejected = createMcpHandler({
      dir: process.cwd(),
      execute: canned({ code: 2, result: { text: "verdict: rejected", data: { status: "rejected" } } }),
    });
    const verdict = decode(await rejected(rpc(9, "tools/call", {
      name: "minga_submit",
      arguments: { attempt: "A-1", claim: "solves", message: "m", files: ["a.ts"] },
    })));
    expect(verdict.result.isError).toBe(true);
    expect(verdict.result.content[0].text).toBe("verdict: rejected");
    expect(verdict.result.structuredContent).toEqual({ status: "rejected" });
  });

  test("unknown tools and missing arguments are one-line errors", async () => {
    const handler = createMcpHandler({ dir: process.cwd(), execute: canned() });
    const unknown = decode(await handler(rpc(10, "tools/call", { name: "nope", arguments: {} })));
    expect(unknown.result.isError).toBe(true);
    expect(unknown.result.content[0].text).toBe("unknown tool: nope");
    const missing = decode(await handler(rpc(11, "tools/call", { name: "minga_join", arguments: { model: "m" } })));
    expect(missing.result.isError).toBe(true);
    expect(missing.result.content[0].text).toBe("url is required");
  });

  test("tool arguments map onto the shared dispatcher's ParsedCli", () => {
    expect(toolToCli("minga_join", { url: "u", model: "m", harness: "h", owner: "o" })).toEqual({
      command: "join", options: { model: "m", harness: "h", owner: "o" }, positionals: ["u"],
    });
    expect(toolToCli("minga_next", { wait: 600 }).options.wait).toBe("600");
    // One long-poll by default; the agent calls again if assignment is null.
    expect(toolToCli("minga_next", {}).options.wait).toBe("30");
    expect(toolToCli("minga_next", { wait: false }).options.wait).toBe("0");
    expect(toolToCli("minga_submit", {
      attempt: "A-1", claim: "solves", message: "m", files: ["a.ts", "b.ts"], root: "r",
    })).toEqual({
      command: "submit",
      options: { claim: "solves", message: "m", root: "r", wait: true },
      positionals: ["A-1", "a.ts", "b.ts"],
    });
    expect(toolToCli("minga_submit", {
      attempt: "A-1", claim: "solves", message: "m", files: [], wait: false,
    }).options.wait).toBe(false);
    expect(toolToCli("minga_result", { submission: "S-1", wait: true }).command).toBe("result");
    expect(toolToCli("minga_propose_task", { title: "t", under: "T-1" })).toEqual({
      command: "propose", options: { under: "T-1", title: "t" }, positionals: ["task"],
    });
    expect(toolToCli("minga_propose_impossible", { task: "T-1", evidence: "e" }).positionals).toEqual(["impossible", "T-1"]);
    expect(toolToCli("minga_vote", { proposal: "P-1", approve: false }).positionals).toEqual(["P-1", "no"]);
    expect(toolToCli("minga_release", { attempt: "A-1", handoff: "h" }).command).toBe("release");
    expect(toolToCli("minga_status", {}).command).toBe("status");
    expect(toolToCli("minga_board", {}).command).toBe("board");
    expect(toolToCli("minga_note", { task: "T-1", kind: "idea", text: "x" }).positionals).toEqual(["T-1", "idea", "x"]);
    expect(toolToCli("minga_beat", { attempt: "A-1" }).command).toBe("beat");
  });
});

describe("MCP round trip through the real dispatcher", () => {
  test("minga_join writes an identity and minga_status reads the project", async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push(new URL(url).pathname);
      if (init?.method === "POST") {
        const body = JSON.parse(init.body as string) as { publicKey: string };
        return new Response(JSON.stringify({
          agent: "0123456789abcdef", rejoin: false, project, live: [], publicKey: body.publicKey,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify(project), { status: 200, headers: { "content-type": "application/json" } });
    };

    await withTempDir(async (dir) => {
      const progress: string[] = [];
      const handler = createMcpHandler({ dir, fetchImpl, onProgress: (line) => progress.push(line) });

      const joined = decode(await handler(rpc(20, "tools/call", {
        name: "minga_join",
        arguments: { url: "http://minga.test", model: "claude-x", harness: "claude-code" },
      })));
      expect(joined.result.isError).toBeUndefined();
      expect(joined.result.content[0].text).toContain("joined Minga as agent 0123456789abcdef");
      expect(joined.result.structuredContent.project.goal).toBe(project.goal);
      expect(existsSync(agentPath(dir))).toBe(true);
      expect(JSON.parse(readFileSync(agentPath(dir), "utf8")).model).toBe("claude-x");

      const status = decode(await handler(rpc(21, "tools/call", { name: "minga_status", arguments: {} })));
      expect(status.result.isError).toBeUndefined();
      expect(status.result.content[0].text).toContain("goal: Self-hosted coordination.");
      expect(status.result.structuredContent.project.scope).toBe("src/**");
      expect(calls).toEqual(["/api/join", "/api/project"]);
      expect(progress).toEqual([]);
    });
  });

  test("join then a signed verb reuses the stored key", async () => {
    const seen: Record<string, string> = {};
    const fetchImpl: FetchLike = async (url, init) => {
      const path = new URL(url).pathname;
      if (path === "/api/join") {
        return new Response(JSON.stringify({ agent: "0123456789abcdef", rejoin: false, project, live: [] }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      seen[path] = (init!.headers as Record<string, string>)["x-minga-agent"] ?? "";
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    };
    await withTempDir(async (dir) => {
      const handler = createMcpHandler({ dir, fetchImpl });
      await handler(rpc(30, "tools/call", {
        name: "minga_join", arguments: { url: "http://minga.test", model: "m", harness: "h" },
      }));
      const beat = decode(await handler(rpc(31, "tools/call", {
        name: "minga_beat", arguments: { attempt: "A-1", approach: "reading" },
      })));
      expect(beat.result.isError).toBeUndefined();
      const stored = JSON.parse(readFileSync(agentPath(dir), "utf8")) as { publicKey: string };
      expect(seen["/api/beat"]).toBe(agentIdFromPublicKey(stored.publicKey));
    });
  });

  test("protocol messages are the only stdout writes in mcp mode", async () => {
    const handler = createMcpHandler({ dir: process.cwd(), execute: canned() });
    const lines = [
      rpc(40, "initialize"),
      rpc(41, "ping"),
      "not-json",
    ];
    const replies: (string | null)[] = [];
    for (const line of lines) replies.push(await handler(line));
    expect(replies.filter((r) => r !== null)).toHaveLength(3);
    for (const reply of replies) {
      if (reply !== null) expect(() => JSON.parse(reply)).not.toThrow();
    }
  });
});
