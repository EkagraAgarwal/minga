/**
 * One command dispatcher shared by the CLI and the MCP server. It never writes
 * to stdout: callers decide how to render `text` and `data`.
 */
import { generateKeyPair } from "../identity/keys.ts";
import type { FetchLike } from "./client.ts";
import { createClient } from "./client.ts";
import type { Client } from "./client.ts";
import {
  beatCommand, boardCommand, fitSubmitMessage, headBanCommand, headCloseCommand, headDecideCommand,
  headKeygenCommand, headNoteCommand, headPostCommand, headRuleCommand, joinCommand, nextCommand, noteCommand, parseClaim,
  parseNoteKind, parseRuleArgs, proposeCommand, releaseCommand, resultCommand, statusCommand,
  submitCommand, submissionExitCode, tasksCommand, voteCommand,
} from "./commands.ts";
import type { CommandResult, ParsedCli, ParsedValue, SubmitView } from "./commands.ts";
import { doctorCommand } from "./doctor.ts";
import { initCommand } from "./init.ts";
import type { RuntimeDeps } from "./runtime.ts";
import { serveCommand } from "./runtime.ts";
import { syncCommand } from "./sync.ts";
import {
  agentPath, headPath, readAgent, readHead, resolveAgentDir, resolveDir, writeAgent, writeHead,
} from "./store.ts";
import type { SessionIdentity } from "./store.ts";

export interface DispatchDeps {
  dir: string;
  urlOverride?: string;
  /** Progress lines (queued / checking), written to stderr, never part of --json output. */
  onProgress?: (line: string) => void;
  fetchImpl?: FetchLike;
  runtime?: RuntimeDeps;
}

export interface DispatchOutcome<T = unknown> {
  result: CommandResult<T>;
  /** 0 ok or assignment, 1 error (thrown), 2 rejected submission,
   * 3 no task free within the wait, 4 project finished (no open tasks left). */
  code: number;
}

function str(value: ParsedValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function raw(value: ParsedValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function intOption(value: ParsedValue | undefined, name: string): number | undefined {
  const text = str(value);
  if (text === undefined) return undefined;
  if (!/^\d+$/.test(text)) throw new Error(`--${name} must be a whole number, got "${text}"`);
  return Number(text);
}

function requirePositional(cli: ParsedCli, index: number, message: string): string {
  const value = cli.positionals[index];
  if (value === undefined || value.length === 0) throw new Error(message);
  return value;
}

function client(url: string, keys: { publicKey: string; privateKey: string }, deps: DispatchDeps): Client {
  return createClient(url, keys, deps.fetchImpl ?? fetch);
}

function requireAgent(
  deps: DispatchDeps,
): { identity: SessionIdentity; identityDir: string; client: Client } {
  const identityDir = resolveAgentDir(deps.dir);
  const identity = readAgent(identityDir);
  if (!identity) {
    throw new Error(`no agent identity at ${agentPath(identityDir)}; run "minga join <url>" first`);
  }
  return {
    identity,
    identityDir,
    client: client(deps.urlOverride ?? identity.url, identity, deps),
  };
}

/** Remember accepted files so `minga sync` can clean up after the submit. */
function acceptedFiles(view: SubmitView): { submission: string; files: string[] } | undefined {
  if (!("id" in view) || view.status !== "accepted") return undefined;
  return { submission: view.id, files: view.files };
}

function requireHeadClient(deps: DispatchDeps): Client {
  const identity = readHead(deps.dir);
  if (!identity) {
    throw new Error(`no head identity at ${headPath(deps.dir)}; run "minga head keygen" first`);
  }
  const url = deps.urlOverride ?? identity.url ?? readAgent(deps.dir)?.url;
  if (!url) throw new Error("no coordinator URL; pass --url");
  return client(url, identity, deps);
}

function modelOf(cli: ParsedCli, identity: SessionIdentity): string | undefined {
  return str(cli.options.model) ?? (identity.model.length > 0 ? identity.model : undefined);
}

/** Execute a parsed command. Throws on failure; returns text, data and exit code on success. */
export async function dispatch(cli: ParsedCli, deps: DispatchDeps): Promise<DispatchOutcome> {
  const dir = deps.dir;
  switch (cli.command) {
    case "join": {
      const url = cli.positionals[0] ?? str(cli.options.url);
      if (!url) throw new Error("join needs the project URL: minga join <url> --model <m> --harness <h>");
      const model = str(cli.options.model);
      const harness = str(cli.options.harness);
      if (!model || !harness) throw new Error("join needs --model and --harness");
      const existing = readAgent(dir);
      // An ancestor identity is reused only for the same project; otherwise
      // join still writes to cwd (or --dir), as documented.
      const reuse = existing !== null && existing.url === url;
      const keys = existing && reuse
        ? { publicKey: existing.publicKey, privateKey: existing.privateKey }
        : generateKeyPair();
      const { identity, result } = await joinCommand(client(url, keys, deps), {
        url,
        keys,
        model,
        harness,
        owner: str(cli.options.owner),
      });
      writeAgent(reuse ? resolveAgentDir(dir) : resolveDir(dir), identity);
      return { result, code: 0 };
    }

    case "next": {
      const { identity, identityDir, client: c } = requireAgent(deps);
      const result = await nextCommand(c, {
        model: modelOf(cli, identity),
        approach: str(cli.options.approach),
        wait: intOption(cli.options.wait, "wait") ?? 0,
        onProgress: deps.onProgress,
      });
      const a = result.data.assignment;
      if (a) {
        writeAgent(identityDir, {
          ...identity,
          lastAssignment: {
            attempt: a.attempt,
            role: a.role,
            leaseUntil: a.leaseUntil,
            task: a.task.id,
          },
        });
      }
      return { result, code: result.data.done === true ? 4 : result.data.assignment ? 0 : 3 };
    }

    case "beat": {
      const attempt = requirePositional(cli, 0, "beat needs an attempt id");
      const { identity, client: c } = requireAgent(deps);
      return {
        result: await beatCommand(c, {
          attempt,
          model: modelOf(cli, identity),
          approach: str(cli.options.approach),
        }),
        code: 0,
      };
    }

    case "note": {
      const task = requirePositional(cli, 0, "note needs a task id");
      const kind = parseNoteKind(requirePositional(cli, 1, "note needs a kind (idea, result, question, handoff)"));
      const text = cli.positionals.slice(2).join(" ");
      if (text.length === 0) throw new Error("note needs some text");
      const { client: c } = requireAgent(deps);
      return { result: await noteCommand(c, { task, kind, text }), code: 0 };
    }

    case "submit": {
      const attempt = requirePositional(cli, 0, "submit needs an attempt id");
      const claimText = str(cli.options.claim);
      if (!claimText) throw new Error("submit needs --claim solves|refutes|progress");
      const rawMessage = str(cli.options.message);
      if (!rawMessage) throw new Error('submit needs -m "<message>"');
      const fitted = fitSubmitMessage(rawMessage);
      if (fitted.notice !== undefined) deps.onProgress?.(fitted.notice);
      const { identity, identityDir, client: c } = requireAgent(deps);
      const result = await submitCommand(c, {
        attempt,
        claim: parseClaim(claimText),
        message: fitted.message,
        files: cli.positionals.slice(1),
        root: str(cli.options.root),
        model: modelOf(cli, identity),
        wait: cli.options.wait !== false,
        onProgress: deps.onProgress,
      });
      const submission = "submission" in result.data ? result.data.submission : result.data.id;
      const accepted = acceptedFiles(result.data);
      writeAgent(identityDir, {
        ...identity,
        lastSubmission: submission,
        ...(accepted !== undefined ? { lastAccepted: accepted } : {}),
      });
      return { result, code: submissionExitCode(result.data) };
    }

    case "result": {
      const submission = requirePositional(cli, 0, "result needs a submission id (S-n)");
      const { identity, identityDir, client: c } = requireAgent(deps);
      const result = await resultCommand(c, {
        submission,
        wait: cli.options.wait === true,
        onProgress: deps.onProgress,
      });
      const accepted = acceptedFiles(result.data);
      if (accepted !== undefined) writeAgent(identityDir, { ...identity, lastAccepted: accepted });
      return { result, code: submissionExitCode(result.data) };
    }

    case "release": {
      const attempt = requirePositional(cli, 0, "release needs an attempt id");
      const { client: c } = requireAgent(deps);
      return {
        result: await releaseCommand(c, { attempt, handoff: str(cli.options.handoff) }),
        code: 0,
      };
    }

    case "propose": {
      const kind = cli.positionals[0];
      const { client: c } = requireAgent(deps);
      if (kind === "task") {
        const under = str(cli.options.under) ?? "root";
        return {
          result: await proposeCommand(c, {
            kind: "new_task",
            task: under === "root" ? null : under,
            title: str(cli.options.title),
            body: str(cli.options.body),
          }),
          code: 0,
        };
      }
      if (kind === "impossible") {
        const task = requirePositional(cli, 1, "propose impossible needs a task id");
        return {
          result: await proposeCommand(c, {
            kind: "impossible",
            task,
            evidence: str(cli.options.evidence),
          }),
          code: 0,
        };
      }
      throw new Error('propose needs "task" or "impossible"');
    }

    case "vote": {
      const proposal = requirePositional(cli, 0, "vote needs a proposal id");
      const answer = requirePositional(cli, 1, "vote needs yes or no");
      if (answer !== "yes" && answer !== "no") throw new Error(`vote must be yes or no, got "${answer}"`);
      const { client: c } = requireAgent(deps);
      return { result: await voteCommand(c, { proposal, approve: answer === "yes" }), code: 0 };
    }

    case "status": {
      const { identity, client: c } = requireAgent(deps);
      return { result: await statusCommand(c, identity), code: 0 };
    }

    case "board": {
      const { client: c } = requireAgent(deps);
      return { result: await boardCommand(c), code: 0 };
    }

    case "tasks": {
      const { client: c } = requireAgent(deps);
      return { result: await tasksCommand(c, { openOnly: cli.options.open === true }), code: 0 };
    }

    case "sync": {
      const result = syncCommand({ dir, discard: cli.options.discard === true });
      return { result, code: result.data.refused ? 1 : 0 };
    }

    case "init": {
      const required = (name: string): string => {
        const value = str(cli.options[name]);
        if (!value) throw new Error(`init needs --${name}`);
        return value;
      };
      const pathsText = required("paths");
      const paths = pathsText.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
      if (paths.length === 0) throw new Error("init needs --paths with at least one glob");
      return {
        result: initCommand({
          dir: cli.positionals[0] ?? dir,
          name: required("name"),
          goal: required("goal"),
          scope: required("scope"),
          check: required("check"),
          paths,
          branch: str(cli.options.branch) ?? "main",
          force: cli.options.force === true,
          url: str(cli.options.url),
        }),
        code: 0,
      };
    }

    case "serve": {
      const result = await serveCommand(cli.raw ?? [], deps.runtime);
      return { result, code: result.data.code };
    }

    case "doctor": {
      const result = doctorCommand(
        { dir, repo: str(cli.options.repo), packageRoot: deps.runtime?.packageRoot },
        deps.runtime,
      );
      return { result, code: result.data.checks.every((check) => check.ok) ? 0 : 1 };
    }

    case "head": {
      const action = cli.action;
      if (action === "keygen") {
        const existing = readHead(dir);
        const { identity, result } = headKeygenCommand(
          existing,
          str(cli.options.url) ?? readAgent(dir)?.url,
        );
        writeHead(dir, identity);
        return { result, code: 0 };
      }

      const c = requireHeadClient(deps);

      if (action === "post") {
        const title = str(cli.options.title);
        const body = raw(cli.options.body);
        if (!title) throw new Error("head post needs --title");
        if (body === undefined) throw new Error("head post needs --body");
        return {
          result: await headPostCommand(c, {
            title,
            body,
            parent: str(cli.options.under) ?? null,
            points: intOption(cli.options.points, "points"),
          }),
          code: 0,
        };
      }

      if (action === "decide") {
        const proposal = requirePositional(cli, 0, "head decide needs a proposal id");
        const verdict = requirePositional(cli, 1, "head decide needs accept or reject");
        if (verdict !== "accept" && verdict !== "reject") {
          throw new Error(`head decide must be accept or reject, got "${verdict}"`);
        }
        return {
          result: await headDecideCommand(c, {
            proposal,
            accept: verdict === "accept",
            reason: str(cli.options.reason),
          }),
          code: 0,
        };
      }

      if (action === "rule") {
        return { result: await headRuleCommand(c, parseRuleArgs(cli.positionals)), code: 0 };
      }

      if (action === "ban") {
        const agent = requirePositional(cli, 0, "head ban needs an agent id");
        const reason = str(cli.options.reason);
        if (!reason) throw new Error("head ban needs --reason");
        return { result: await headBanCommand(c, { agent, reason }), code: 0 };
      }

      if (action === "note") {
        const task = requirePositional(cli, 0, "head note needs a task id");
        const text = cli.positionals.slice(1).join(" ");
        if (text.length === 0) throw new Error("head note needs some text");
        const kindText = str(cli.options.kind);
        return {
          result: await headNoteCommand(c, {
            task,
            text,
            ...(kindText !== undefined ? { kind: parseNoteKind(kindText) } : {}),
          }),
          code: 0,
        };
      }

      if (action === "close") {
        const task = requirePositional(cli, 0, "head close needs a task id");
        const status = requirePositional(cli, 1, "head close needs withdrawn, impossible or solved");
        if (status !== "withdrawn" && status !== "impossible" && status !== "solved") {
          throw new Error(`head close must be withdrawn, impossible or solved, got "${status}"`);
        }
        return {
          result: await headCloseCommand(c, {
            task,
            status,
            reason: str(cli.options.reason),
          }),
          code: 0,
        };
      }

      throw new Error(`unknown head action: ${action ?? ""} (try "minga head --help")`);
    }

    default:
      throw new Error(`unknown command: ${cli.command} (try "minga help")`);
  }
}

/** `resolveDir` is re-exported for callers that want the same default. */
export { resolveDir };
