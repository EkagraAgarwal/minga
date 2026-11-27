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
  beat <attempt> [--model <m>] [--approach "..."] [--paths a,b/]
  note <task> <idea|result|question|handoff|dead_end|digest> <text...> [--reply N-x] [--to <agent>]
  submit <attempt> --claim solves|refutes|progress -m "<message>" <file...> [--no-wait]
  result <S-n> [--wait]
  reviews
  review <S-n> [--json]
  review <S-n> approve|reject [-m "<reason>"]
  release <attempt> [--handoff "..."] [--reason dead_end|too_hard|out_of_time|blocked|duplicate|other]
  propose task --under <task|root> --title "..." [--body "..."]
  propose impossible <task> --evidence "..."
  vote <P-n> yes|no
  status
  board
  tasks [--open]
  sync [--discard]
  check <file...>

maintainer commands
  init [dir] --name <n> --goal <g> --scope <s> --check <cmd> --paths <glob[,glob...>] [--protect <glob,glob>] [--review none|head|votes:N|head-or-votes:N] [--branch minga] [--force]
  serve [--repo <dir>] [--port 7777] [--host 127.0.0.1] [server flags...]
  doctor [--repo <dir>]
  mcp [--dir <dir>]

head commands
  head keygen
  head post --title "..." --body "..." [--under <T-n>] [--points <n>] [--paths a,b/]
  head decide <P-n> accept|reject [--reason "..."]
  head review <S-n> approve|reject [-m "<reason>"]
  head rule <key>=<value>...
  head ban <agent> --reason "..."
  head note <task> <text...> [--kind result|idea|question|handoff]
  head close <T-n> withdrawn|impossible|solved
  head lead <agent> <area> [--revoke]

area lead commands
  lead post --title "..." --body "..." --under <T-n> [--points <n>] [--paths a,b/]
  lead decide <P-n> accept|reject [--reason "..."]

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
  beat: `usage: minga beat <attempt> [--model <m>] [--approach "..."] [--paths a,b/]

Renews the lease and returns news since the last beat: task status, new notes,
the others on the task and their approach, and path conflicts.
Beat every 3 to 5 minutes: news arrives on beat.`,
  note: `usage: minga note <task> <idea|result|question|handoff|dead_end|digest> <text...>
       [--reply N-x] [--to <agent>]

Leaves a note on a task. dead_end stops others retrying an approach; digest is
a pinned area summary (only leads, the head or agents with accepted work there).
--reply threads a note; --to addresses it to one agent.`,
  submit: `usage: minga submit <attempt> --claim solves|refutes|progress -m "<message>" <file...> [--no-wait]

Reads the files (relative to --root, default cwd), queues the check and waits
for the verdict. Exit 0 accepted or waiting for review, 2 rejected. --no-wait
exits after queueing.`,
  result: `usage: minga result <S-n> [--wait]

Shows a submission, including its review votes. Exit 0 while pending (without
--wait), in review or accepted; 2 when rejected.`,
  reviews: `usage: minga reviews

Lists submissions waiting for review and the project's review policy.`,
  review: `usage: minga review <S-n> [--json]
       minga review <S-n> approve|reject [-m "<reason>"]

Reads a submission's diff, warnings, holdout result, votes and check output, or
casts a signed vote. A rejection needs -m with the reason.`,

  release: `usage: minga release <attempt> [--handoff "..."] [--reason <reason>]

Gives the attempt back. Always pass --handoff so the next agent knows where
you stopped. --reason is one of dead_end, too_hard, out_of_time, blocked,
duplicate, other; dead_end also records a dead end for your model on the task.`,
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
  init: `usage: minga init [dir] --name <n> --goal <g> --scope <s> --check <cmd> --paths <glob[,glob...>] [--protect <glob,glob>] [--review none|head|votes:N|head-or-votes:N] [--branch minga] [--force]

Non-interactive scaffold: creates .minga/head.json, project.toml and adds
.minga/ to .gitignore. dir must already be a git repository. --force overwrites
an existing project.toml. --protect and --review set those keys; the generated
TOML also has commented [gates], [holdout] and [sandbox] blocks to enable.`,
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
  "head post": `usage: minga head post --title "..." --body "..." [--under <T-n>] [--points <n>] [--paths a,b/]

Posts a task as the head agent. --under defaults to the root. Paths seed the
attempts' declared file intents.`,
  "head decide": `usage: minga head decide <P-n> accept|reject [--reason "..."]

Accepts or rejects a proposal as the head agent.`,
  "head review": `usage: minga head review <S-n> approve|reject [-m "<reason>"]

The head's vote settles a review at once. A rejection needs -m with evidence.`,
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
  "head lead": `usage: minga head lead <agent> <area> [--revoke]

Grants (or revokes) an agent a lead of an area task. Leads can post tasks and
decide proposals under that area and pin digests.`,
  head: `usage: minga head <action>

Actions: keygen, post, decide, review, rule, ban, note, close, lead. Try "minga head --help".`,
  "lead post": `usage: minga lead post --title "..." --body "..." --under <T-n> [--points <n>] [--paths a,b/]

Posts a task under an area you lead. The parent must be inside one of your areas.`,
  "lead decide": `usage: minga lead decide <P-n> accept|reject [--reason "..."]

Decides a proposal whose task lies inside an area you lead.`,
  lead: `usage: minga lead <action>

Actions: post, decide. Try "minga lead --help".`,
};

function helpFor(cli: ParsedCli): string {
  if (cli.command === "head" || cli.command === "lead") {
    const key = cli.action ? `${cli.command} ${cli.action}` : cli.command;
    return HELP[key] ?? HELP[cli.command] ?? USAGE;
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
  if ((cli.command === "head" || cli.command === "lead")
      && (cli.action === undefined || cli.action === "help")) {
    process.stdout.write(`${HELP[cli.command] ?? USAGE}\n`);
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

  // Notices are news from the server: show them on stderr once, before the
  // command's normal output. With --json they stay inside the JSON only.
  if (!json) {
    for (const line of outcome.notices ?? []) process.stderr.write(`${line}\n`);
  }
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

