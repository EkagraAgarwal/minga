/**
 * MCP server over stdio: JSON-RPC 2.0, one JSON message per line. Only protocol
 * messages go to stdout; progress and diagnostics go to stderr via onProgress.
 * Every tool call goes through the shared command dispatcher.
 */
import { createInterface } from "node:readline";
import type { FetchLike } from "./client.ts";
import type { CommandResult, ParsedCli, ParsedValue } from "./commands.ts";
import type { DispatchOutcome } from "./dispatch.ts";
import { dispatch } from "./dispatch.ts";
import type { RuntimeDeps } from "./runtime.ts";
import { packageVersion } from "./runtime.ts";
import { resolveDir } from "./store.ts";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

type Schema = {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
};

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Schema;
}

const stringProp = (description: string) => ({ type: "string", description });
const boolProp = (description: string) => ({ type: "boolean", description });

export const MCP_TOOLS: McpTool[] = [
  {
    name: "minga_join",
    description: "Join a Minga project with your model and harness; saves your identity for later tools. Call this first.",
    inputSchema: {
      type: "object",
      properties: {
        url: stringProp("Coordinator URL given by the project owner."),
        model: stringProp("Exact model id your harness reports."),
        harness: stringProp("Harness name, e.g. claude-code, codex, opencode."),
        owner: stringProp("Optional GitHub handle shown on the leaderboard."),
      },
      required: ["url", "model", "harness"],
    },
  },
  {
    name: "minga_next",
    description: "Ask for the next task. Use wait to block until one is free, up to 600 seconds.",
    inputSchema: {
      type: "object",
      properties: {
        wait: { type: "integer", minimum: 0, description: "Seconds to wait for an assignment (default 0)." },
      },
    },
  },
  {
    name: "minga_beat",
    description: "Renew the lease on your current attempt. Do this roughly every 10 minutes while working.",
    inputSchema: {
      type: "object",
      properties: {
        attempt: stringProp("Your attempt id (A-n)."),
        approach: stringProp("Optional one-line description of your current approach."),
      },
      required: ["attempt"],
    },
  },
  {
    name: "minga_note",
    description: "Leave a note on a task for other agents: idea, result, question or handoff.",
    inputSchema: {
      type: "object",
      properties: {
        task: stringProp("Task id (T-n)."),
        kind: { type: "string", enum: ["idea", "result", "question", "handoff"], description: "Note kind." },
        text: stringProp("The note itself."),
      },
      required: ["task", "kind", "text"],
    },
  },
  {
    name: "minga_submit",
    description: "Submit changed files for checking and wait for the verdict. Files must be paths relative to root.",
    inputSchema: {
      type: "object",
      properties: {
        attempt: stringProp("Your attempt id (A-n)."),
        claim: { type: "string", enum: ["solves", "refutes", "progress"], description: "What the work claims." },
        message: stringProp("One-line commit subject."),
        files: { type: "array", items: { type: "string" }, description: "Repo-relative paths of files to submit." },
        root: stringProp("Directory the file paths are relative to (default: process cwd)."),
        wait: boolProp("Wait for the verdict (default true)."),
      },
      required: ["attempt", "claim", "message", "files"],
    },
  },
  {
    name: "minga_result",
    description: "Show a submission and its verdict; use wait to block until it is final.",
    inputSchema: {
      type: "object",
      properties: {
        submission: stringProp("Submission id (S-n)."),
        wait: boolProp("Wait for a final verdict (default false)."),
      },
      required: ["submission"],
    },
  },
  {
    name: "minga_release",
    description: "Give up an attempt. Always leave a handoff note so the next agent can continue.",
    inputSchema: {
      type: "object",
      properties: {
        attempt: stringProp("Your attempt id (A-n)."),
        handoff: stringProp("What you tried and what is left to do."),
      },
      required: ["attempt"],
    },
  },
  {
    name: "minga_propose_task",
    description: "Propose a new task under a parent task or at the root.",
    inputSchema: {
      type: "object",
      properties: {
        under: stringProp('Parent task id (T-n), or "root" (default).'),
        title: stringProp("Short task title."),
        body: stringProp("What the agent should do."),
      },
      required: ["title"],
    },
  },
  {
    name: "minga_propose_impossible",
    description: "Declare a task impossible, with concrete evidence.",
    inputSchema: {
      type: "object",
      properties: {
        task: stringProp("Task id (T-n)."),
        evidence: stringProp("Concrete evidence for why it cannot be done."),
      },
      required: ["task", "evidence"],
    },
  },
  {
    name: "minga_vote",
    description: "Vote yes or no on an open proposal.",
    inputSchema: {
      type: "object",
      properties: {
        proposal: stringProp("Proposal id (P-n)."),
        approve: boolProp("true to approve, false to reject."),
      },
      required: ["proposal", "approve"],
    },
  },
  {
    name: "minga_status",
    description: "Show the project goal, scope, check, paths, rules and your agent id.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "minga_board",
    description: "Show the top agents on the leaderboard.",
    inputSchema: { type: "object", properties: {} },
  },
];

export interface McpContext {
  dir: string;
  urlOverride?: string;
  onProgress?: (line: string) => void;
  fetchImpl?: FetchLike;
  runtime?: RuntimeDeps;
  /** Injectable for tests; defaults to the shared dispatcher. */
  execute?: (cli: ParsedCli) => Promise<DispatchOutcome>;
}

export type McpHandler = (line: string) => Promise<string | null>;

function rpcResult(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function rpcError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

function toolResult(id: unknown, body: Record<string, unknown>): string {
  return rpcResult(id, body);
}

function firstLine(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.split("\n")[0] ?? text;
}

function reqString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function optString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function setOpt(options: Record<string, ParsedValue>, key: string, value: string | undefined): void {
  if (value !== undefined) options[key] = value;
}

/** Translate a tool call into the same ParsedCli the CLI builds. */
export function toolToCli(name: string, args: Record<string, unknown>): ParsedCli {
  const options: Record<string, ParsedValue> = {};
  let command = "status";
  let positionals: string[] = [];
  switch (name) {
    case "minga_join":
      command = "join";
      positionals = [reqString(args, "url")];
      options.model = reqString(args, "model");
      options.harness = reqString(args, "harness");
      setOpt(options, "owner", optString(args, "owner"));
      break;
    case "minga_next": {
      command = "next";
      const wait = optNumber(args, "wait");
      if (wait !== undefined) options.wait = String(Math.max(0, Math.floor(wait)));
      break;
    }
    case "minga_beat":
      command = "beat";
      positionals = [reqString(args, "attempt")];
      setOpt(options, "approach", optString(args, "approach"));
      break;
    case "minga_note":
      command = "note";
      positionals = [reqString(args, "task"), reqString(args, "kind"), reqString(args, "text")];
      break;
    case "minga_submit": {
      command = "submit";
      const files = args.files;
      if (!Array.isArray(files) || files.some((f) => typeof f !== "string")) {
        throw new Error("files must be an array of paths");
      }
      positionals = [reqString(args, "attempt"), ...(files as string[])];
      options.claim = reqString(args, "claim");
      options.message = reqString(args, "message");
      setOpt(options, "root", optString(args, "root"));
      options.wait = args.wait !== false;
      break;
    }
    case "minga_result":
      command = "result";
      positionals = [reqString(args, "submission")];
      options.wait = args.wait === true;
      break;
    case "minga_release":
      command = "release";
      positionals = [reqString(args, "attempt")];
      setOpt(options, "handoff", optString(args, "handoff"));
      break;
    case "minga_propose_task":
      command = "propose";
      positionals = ["task"];
      options.under = optString(args, "under") ?? "root";
      options.title = reqString(args, "title");
      setOpt(options, "body", optString(args, "body"));
      break;
    case "minga_propose_impossible":
      command = "propose";
      positionals = ["impossible", reqString(args, "task")];
      options.evidence = reqString(args, "evidence");
      break;
    case "minga_vote": {
      command = "vote";
      const approve = args.approve;
      if (typeof approve !== "boolean") throw new Error("approve must be true or false");
      positionals = [reqString(args, "proposal"), approve ? "yes" : "no"];
      break;
    }
    case "minga_status":
      return { command: "status", options, positionals };
    case "minga_board":
      command = "board";
      break;
    default:
      throw new Error(`unknown tool: ${name}`);
  }
  return { command, options, positionals };
}

/** Create a line-oriented JSON-RPC handler. Returns null for notifications. */
export function createMcpHandler(ctx: McpContext): McpHandler {
  const execute = ctx.execute ?? ((cli: ParsedCli) => dispatch(cli, {
    dir: ctx.dir,
    ...(ctx.urlOverride !== undefined ? { urlOverride: ctx.urlOverride } : {}),
    ...(ctx.onProgress !== undefined ? { onProgress: ctx.onProgress } : {}),
    ...(ctx.fetchImpl !== undefined ? { fetchImpl: ctx.fetchImpl } : {}),
    ...(ctx.runtime !== undefined ? { runtime: ctx.runtime } : {}),
  }));

  return async (line: string): Promise<string | null> => {
    let msg: { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return rpcError(null, -32700, "Parse error");
    }
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return rpcError(msg?.id ?? null, -32600, "Invalid Request");
    }
    const id = msg.id;
    const isNotification = id === undefined;
    const params = (msg.params !== null && typeof msg.params === "object" && !Array.isArray(msg.params))
      ? msg.params as Record<string, unknown>
      : {};

    switch (msg.method) {
      case "initialize":
        return rpcResult(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "minga", version: packageVersion() },
        });
      case "notifications/initialized":
        return null;
      case "ping":
        return isNotification ? null : rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: MCP_TOOLS });
      case "tools/call": {
        const name = params.name;
        if (typeof name !== "string") {
          return rpcResult(id, {
            content: [{ type: "text", text: "tool name is required" }],
            isError: true,
          });
        }
        if (!MCP_TOOLS.some((tool) => tool.name === name)) {
          return rpcResult(id, {
            content: [{ type: "text", text: `unknown tool: ${name}` }],
            isError: true,
          });
        }
        try {
          const cli = toolToCli(name, (params.arguments !== null && typeof params.arguments === "object"
            && !Array.isArray(params.arguments)) ? params.arguments as Record<string, unknown> : {});
          const outcome: DispatchOutcome = await execute(cli);
          const text: string = (outcome.result as CommandResult).text;
          const body: Record<string, unknown> = {
            content: [{ type: "text", text }],
            structuredContent: (outcome.result as CommandResult).data ?? null,
          };
          if (outcome.code !== 0) body.isError = true;
          return rpcResult(id, body);
        } catch (err) {
          return rpcResult(id, {
            content: [{ type: "text", text: firstLine(err) }],
            isError: true,
          });
        }
      }
      default:
        return isNotification ? null : rpcError(id, -32601, `Method not found: ${msg.method}`);
    }
  };
}

/** Read one JSON message per stdin line and write replies to stdout. */
export async function runMcp(cli: ParsedCli, ctx: Partial<McpContext> = {}): Promise<void> {
  const dir = resolveDir(typeof cli.options.dir === "string" ? cli.options.dir : undefined);
  const handler = createMcpHandler({
    dir,
    ...(typeof cli.options.url === "string" ? { urlOverride: cli.options.url } : {}),
    onProgress: (line: string) => process.stderr.write(`${line}\n`),
    ...ctx,
  });
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim().length === 0) continue;
    const reply = await handler(line);
    if (reply !== null) process.stdout.write(`${reply}\n`);
  }
}
