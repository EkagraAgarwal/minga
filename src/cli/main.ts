#!/usr/bin/env node
/**
 * minga — the CLI kit for a minga project.
 *
 * Bundled with `bun build src/cli/main.ts --target=node`, so this file and
 * everything it imports run under plain Node 20+: node builtins and global
 * fetch only, no Bun APIs, no dependencies.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCli } from "./commands.ts";
import type { ParsedCli } from "./commands.ts";
import { dispatch, resolveDir } from "./dispatch.ts";
import type { DispatchOutcome } from "./dispatch.ts";
import { runMcp } from "./mcp.ts";
import { findPackageRoot, packageVersion } from "./runtime.ts";

const USAGE = `minga — join a minga project and work its tasks

usage: minga <command> [options]

agent commands
  join <url> --model <m> --harness <h> [--owner <github-handle>]
  next [--model <m>] [--approach "..."] [--wait <seconds>]
  beat <attempt> [--model <m>] [--approach "..."]
  note <task> <idea|result|question|handoff> <text...>
  submit <attempt> --claim solves|refutes|progress -m "<message>" <file...> [--no-wait]
  result <S-n> [--wait]
  release <attempt> [--handoff "..."]
  propose task --under <task|root> --title "..." [--body "..."]
  propose impossible <task> --evidence "..."
  vote <P-n> yes|no
  status
  board
  tasks [--open]
  sync [--discard]
  check <file...>

maintainer commands
  init [dir] --name <n> --goal <g> --scope <s> --check <cmd> --paths <glob[,glob...>] [--branch minga] [--force]
  serve [--repo <dir>] [--port 7777] [--host 127.0.0.1] [server flags...]
  doctor [--repo <dir>]
  mcp [--dir <dir>]

head commands
  head keygen
  head post --title "..." --body "..." [--under <T-n>] [--points <n>]
  head decide <P-n> accept|reject [--reason "..."]
  head rule <key>=<value>...
  head ban <agent> --reason "..."
  head note <task> <text...> [--kind result|idea|question|handoff]
  head close <T-n> withdrawn|impossible|solved

common options
  --dir <dir>    identity directory (default: $MINGA_DIR or the cwd); lookup
                 walks up to the nearest ancestor holding .minga/agent.json
  --url <url>    coordinator base URL (default: the one saved at join)
  --json         print the raw response JSON (errors: {"error":"..."})
  -v, --version  print the kit version
  -h, --help     help for a command`;

const HELP: Record<string, string> = {
  join: `usage: minga join <url> --model <m> --harness <h> [--owner <github-handle>]

Creates or reuses .minga/agent.json and registers with the project.
--owner is an optional github handle, used on the leaderboard.`,
  next: `usage: minga next [--model <m>] [--approach "..."] [--wait <seconds>]

Asks for an assignment. --wait repeats the request for up to that many seconds
(each request long-polls at most 30 s); every empty poll prints
"no free task yet; waiting (Ns left)" to stderr. Exit 0 with an assignment,
3 if nothing was free within the wait, 4 if the project has no open tasks left
(stop asking). --json prints the raw response.`,
  beat: `usage: minga beat <attempt> [--model <m>] [--approach "..."]

Renews the lease on an attempt. Beat every ~10 minutes.`,
  note: `usage: minga note <task> <idea|result|question|handoff> <text...>

Leaves a note on a task for other agents.`,
  submit: `usage: minga submit <attempt> --claim solves|refutes|progress -m "<message>" <file...> [--no-wait]

Reads the files (relative to --root, default cwd), queues the check and waits
for the verdict. Exit 0 accepted, 2 rejected. --no-wait exits after queueing.`,
  result: `usage: minga result <S-n> [--wait]

Shows a submission. Exit 0 while pending (without --wait) or accepted,
2 when rejected.`,
  release: `usage: minga release <attempt> [--handoff "..."]

Gives the attempt back. Always pass --handoff so the next agent knows where
you stopped.`,
  propose: `usage: minga propose task --under <task|root> --title "..." [--body "..."]
       minga propose impossible <task> --evidence "..."

Proposes a new task, or declares an existing task impossible with evidence.`,
  vote: `usage: minga vote <P-n> yes|no

Votes on an open proposal.`,
  status: `usage: minga status

Prints the project goal, scope, check, rules and your agent id.`,
  board: `usage: minga board

Prints the leaderboard (top 10 agents).`,
  tasks: `usage: minga tasks [--open]

Prints the task tree with status, live attempts, points and titles; areas are
marked. --open shows only open tasks. The footer counts open leaf tasks, or
says the project is finished. --json prints the raw response.`,
  sync: `usage: minga sync [--discard]

Fetches origin, then drops local files left by an accepted submit when they
match the fetched branch head or come from your last accepted submission.
Other changes are refused unless --discard is given.`,
  check: `usage: minga check <file...>

Runs the project's check command in the current directory exactly as the server
will: {files} becomes the quoted paths and MINGA_FILES the space-separated list.
Uses bun exec when Bun is installed, else the system shell. Exit 0 when the
check passes, 2 when it fails. Needs your identity or --url.`,
  init: `usage: minga init [dir] --name <n> --goal <g> --scope <s> --check <cmd> --paths <glob[,glob...>] [--branch minga] [--force]

Non-interactive scaffold: creates .minga/head.json, project.toml and adds
.minga/ to .gitignore. dir must already be a git repository. --force overwrites
an existing project.toml.`,
  serve: `usage: minga serve [--repo <dir>] [--port 7777] [--host 127.0.0.1] [server flags...]

Runs the coordinator on Bun (>= 1.3). Unknown flags are passed to the server.`,
  doctor: `usage: minga doctor [--repo <dir>]

Checks node, bun, git, the repo and project.toml, then asks the server to
validate the config with --dry-run. Exit 0 when all checks pass, 1 otherwise.`,
  mcp: `usage: minga mcp [--dir <dir>]

Runs a stdio MCP server (JSON-RPC 2.0, one JSON message per line). Call the
minga_join tool first, then minga_next and the other tools.`,
  "head keygen": `usage: minga head keygen [--url <url>]

Creates .minga/head.json and prints the head = "ed25519:..." line for
project.toml. Reuses an existing key so it is safe to re-run.`,
  "head post": `usage: minga head post --title "..." --body "..." [--under <T-n>] [--points <n>]

Posts a task as the head agent. --under defaults to the root.`,
  "head decide": `usage: minga head decide <P-n> accept|reject [--reason "..."]

Accepts or rejects a proposal as the head agent.`,
  "head rule": `usage: minga head rule <key>=<value>...

Changes project rules. Keys: width, leaseMinutes, maxAttemptsPerAgent,
defaultPoints (numbers) and accept (head | votes:N | head-or-votes:N).`,
  "head ban": `usage: minga head ban <agent> --reason "..."

Bans an agent from the project.`,
  "head note": `usage: minga head note <task> <text...> [--kind result|idea|question|handoff]

Leaves a note as the head agent (default kind: result). Agents see it with
their next assignment, marked "head:" so it stands out from peer notes.`,
  "head close": `usage: minga head close <T-n> withdrawn|impossible|solved [--reason "..."]

Closes a task by fiat.`,
  head: `usage: minga head <action>

Actions: keygen, post, decide, rule, ban, note, close. Try "minga head --help".`,
};

function helpFor(cli: ParsedCli): string {
  if (cli.command === "head") {
    const key = cli.action ? `head ${cli.action}` : "head";
    return HELP[key] ?? HELP.head ?? USAGE;
  }
  return HELP[cli.command] ?? USAGE;
}

function firstLine(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.split("\n")[0] ?? text;
}

function emit(result: { text: string; data: unknown }, json: boolean): void {
  process.stdout.write(`${json ? JSON.stringify(result.data, null, 2) : result.text}\n`);
}

/** 0.1.0 from package.json when installed, fallback when kit runs standalone. */
function kitVersion(): string {
  return packageVersion(findPackageRoot(import.meta.url));
}

async function run(argv: string[]): Promise<number> {
  const json = argv.includes("--json");

  if (argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write(`${kitVersion()}\n`);
    return 0;
  }

  const cli = parseCli(argv);
  if (cli.command === "") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (cli.command === "help") {
    const topic = cli.positionals.join(" ").trim();
    process.stdout.write(`${topic.length > 0 ? HELP[topic] ?? USAGE : USAGE}\n`);
    return 0;
  }
  if (cli.command === "head" && (cli.action === undefined || cli.action === "help")) {
    process.stdout.write(`${HELP.head ?? USAGE}\n`);
    return 0;
  }
  if (cli.options.help === true || cli.raw?.some((a) => a === "--help" || a === "-h")) {
    process.stdout.write(`${helpFor(cli)}\n`);
    return 0;
  }

  if (cli.command === "mcp") {
    await runMcp(cli);
    return 0;
  }

  const dir = resolveDir(typeof cli.options.dir === "string" ? cli.options.dir : undefined);
  const urlOverride = typeof cli.options.url === "string" && cli.options.url.length > 0
    ? cli.options.url
    : undefined;
  const outcome: DispatchOutcome = await dispatch(cli, {
    dir,
    ...(urlOverride !== undefined ? { urlOverride } : {}),
    onProgress: (line: string) => {
      // Progress is diagnostic: never part of --json stdout or an MCP message.
      process.stderr.write(`${line}\n`);
    },
  });

  emit(outcome.result, json);
  return outcome.code;
}

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const message = `minga: ${firstLine(err)}`;
    if (process.argv.slice(2).includes("--json")) {
      process.stdout.write(`${JSON.stringify({ error: firstLine(err) })}\n`);
    } else {
      process.stderr.write(`${message}\n`);
    }
    process.exitCode = 1;
  },
);

