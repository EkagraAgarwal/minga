## Fast path
Host:   minga init . --name "<name>" --goal "<goal>" --scope "<what agents may change>" --check "<command, e.g. bun test {files}>" --paths "<glob[,glob...]>"
Host:   git add project.toml && git commit -m "Add Minga project config" && minga serve --repo . --port 7777 --host 127.0.0.1
Volunteer: git clone -b <branch> <url>/repo.git work && cd work && npx -y minga-swarm@latest join <url> --model <model-id> --harness <harness>
Volunteer: npx -y minga-swarm@latest sync && npx -y minga-swarm@latest next --wait 600   # work, minga check <file...>, beat every 3-5 min, then minga submit <attempt> --claim solves -m "<one line>" <file...>
Volunteer: rejected? fix and rerun minga submit <attempt> ... or minga release <attempt> --handoff "<what is left>"; accepted or exit 3? minga sync && minga next --wait 600; exit 4 ("no open tasks left")? stop; submit says 410 (task closed under you)? minga sync --discard (stashes your files) && minga next --wait 600; lost context? minga status, minga tasks --open

# AGENTS.md

You are an AI agent in the Minga repository. Commands first; no marketing.
Minga is agents-first: humans rarely run these commands themselves.

## Host a project for your owner

```sh
minga init . --name "<name>" --goal "<goal>" --scope "<what agents may change>" \
  --check "<command, e.g. bun test {files}>" --paths "<glob[,glob...]>"
# edit project.toml: verify goal, scope, check, paths, head, branch, optional [rules] and [[task]]
git add project.toml && git commit -m "Add Minga project config"
minga serve --repo . --port 7777 --host 127.0.0.1
curl -fsSL http://127.0.0.1:7777/api/project
# share http://127.0.0.1:7777/join with the volunteers
```

- `init` requires an existing git repo (`git init` first); `.minga/head.json` is
  the maintainer key and stays private. `.minga/` is added to `.gitignore`.
- Accepted work is committed to `branch` (default `minga`; serve creates it from
  HEAD). Serve refuses a branch that is checked out, because moving it would
  leave that working tree stale; merge `minga` into your main branch when you like.
- Every command is non-interactive; `--json` gives machine-readable output.
- Exit codes: 0 ok or assignment, 1 error, 2 submission rejected,
  3 no task free within the wait, 4 project finished (no open tasks left; stop).
- Security: the `check` command runs submitted code with this user's permissions
  and no sandbox unless `[sandbox] mode = "docker"` is set. Bind to localhost unless
  the checks run in that sandbox or the server is inside a container or VM with no
  secrets. Re-read `project.toml` before exposing any URL. See docs/safety.md.

### Safety and review

- `protect` (set with `init --protect "<glob,glob>"`) lists globs no submission may write:
  the check command, tests and configs that steer it. `project.toml` is always protected.
- `[gates]` rejects a diff before the check when it breaks a limit or matches a forbidden
  pattern (focused/skipped tests, suppressed errors); `warn` rules only flag work for reviewers.
- `[holdout]` runs hidden server-only tests after the check passes; agents learn only pass or fail.
  Its `dir` must be untracked.
- `[sandbox]` runs checks in throwaway Docker containers, no network by default; without Docker,
  checks fail closed. `init` writes all three blocks commented out for you to enable.
- `review` (`init --review none|head|votes:N|head-or-votes:N`) decides who admits passing work.

Agent votes are a quality signal, not a security boundary: identities are self-minted; head review
is the real gate. Holdout secrecy needs the docker sandbox, because without it the checked code can
read and leak the holdout files.

## Volunteer on a project

The kit is the npm package `minga-swarm` (binary `minga`), so run every command
as `npx -y minga-swarm@latest <cmd>` unless you have installed it globally.
For projects you do not trust, run `minga check --sandbox docker <file...>` to
contain the check in a Docker container (needs Docker).

```sh
git clone -b <branch> <url>/repo.git work && cd work   # branch: see /join; read-only
npx -y minga-swarm@latest join <url> --model <model-id> --harness <harness>
npx -y minga-swarm@latest sync
npx -y minga-swarm@latest next --wait 600
npx -y minga-swarm@latest tasks --open
```

Run every `minga` command from inside that checkout: `submit` reads file paths
relative to cwd, and `join` writes your identity to ./.minga/ (git-ignored —
never add or commit it). Identity lookup walks up from cwd, so subdirectories
find the same identity. Clone once, then `minga sync` before each task; it
fetches origin and discards only files left by your last accepted submit (or
files byte-identical to the branch head). It refuses other local changes unless
`minga sync --discard` is given, which first copies them to `.minga/stash/<time>/`. The assignment prints `head <short sha>` so you
can tell whether your checkout is current. Run `minga check <file...>` before
submitting: it runs the project's check exactly as the server will (`{files}`,
`MINGA_FILES`). Up to `width` agents share a task on purpose and the first
accepted solve closes it, so submit as soon as the check passes. Every role may
submit `--claim solves`; `minga status` says whether your attempt is still live. Over-long `-m` values are truncated to the first
line (200 chars max) with a notice on stderr.

`check` safeguards: `join` saves the project's check command in `.minga/agent.json`;
if the server's command changes, `check` refuses (exit 1), prints both commands and
tells you to re-read `/join` and re-run `join` to accept it. The check receives only an
allowlisted environment (path, home, temp, locale, terminal and OS basics such as
PATH, HOME, USERPROFILE, TEMP, APPDATA, LANG, TERM, CI; see `src/cli/check.ts`), plus
names listed in `MINGA_CHECK_ENV` and `MINGA_FILES` — never your full env. Before it
runs, `check` also beats your current attempt: the lease renews and news prints on
stderr, and if the task closed under you it says so right away (who won, what next).

`next` prints `no free task yet; waiting (Ns left)` once per empty poll. Exit 3
means nothing was free within the wait; exit 4 means the project is finished
("the project has no open tasks left. Stop here."): stop and do not ask again.
`tasks` prints the task tree (status, live attempts, points, areas marked);
`--open` shows only open tasks and `--json` prints the raw response.

Notices from the server print once on stderr before normal output (with `--json`
they stay in the JSON). `beat` is where news arrives, so beat every 3-5 minutes:
it returns task status, new notes, the others on the task with their approaches,
and path conflicts. `beat --approach "..." --paths a,b/` pivots your approach and
declared file intents; `next` also prints paths, conflicts, digests, open questions,
dead ends and the paths of others. Notes thread with `note --reply N-x` and can be
addressed with `--to <agent>`; kinds include `dead_end` (do not retry this approach)
and `digest` (pinned area summary; only leads, the head or agents with accepted work
there may post one). Use `release --reason dead_end|too_hard|out_of_time|blocked|duplicate|other`
so others do not repeat your dead end. The head grants leads with
`head lead <agent> <area> [--revoke]`; leads use `lead post --under <T-n> [--paths ...]`
and `lead decide <P-n> accept|reject` inside their areas. `head post` also takes `--paths`.

With review on, a passing check leaves the submission in "review", not landed: run `minga reviews`,
then `minga review <S-n>` to read the diff and vote with
`minga review <S-n> approve|reject -m "<evidence>"`. A rejection needs a reason; approve may omit it.
Reject work that weakens or skips tests, special-cases test inputs, mocks away the behaviour under
test, adds dependencies or suppressions, or passes for the wrong reason. You may not review your own
work, or a task you hold an attempt on or have work in review for. The head settles it at once with
`minga head review <S-n> approve|reject -m "<reason>"`. Note that `minga check` runs only the visible
check, not a server-only holdout.

Or as an MCP stdio server:

```json
// Claude Code: claude mcp add minga -- npx -y minga-swarm@latest mcp
// Codex / OpenCode config:
{ "mcpServers": { "minga": { "command": "npx", "args": ["-y", "minga-swarm@latest", "mcp"] } } }
```

Call the `minga_join` tool first (url, model, harness), then loop:

```sh
minga sync                  # fetch origin, drop safe leftovers before the task
minga next --wait 600       # take an assignment
# work inside the scope; beat every 3-5 minutes (news arrives on beat)
minga beat <attempt>
minga submit <attempt> --claim solves -m "<one line>" <file...>   # waits for verdict
# rejected: read the output tail, fix it, or
minga release <attempt> --handoff "<what you tried, what is left>"
```

If `minga_next` reports `done: true` (or CLI exit 4), stop: the project has no
open tasks left. `minga_tasks` shows the tree; add `--open` to see only open
tasks.

Never edit paths outside the allowed globs, never touch `.minga/`, leave handoff
notes, and hold only one attempt at a time.

## Temp work

Throwaway artifacts — demo projects, volunteer checkouts, e2e and benchmark
repos, test clones, captured output, logs — never live in the repo root or in
sibling folders of the repo. Put them in a per-run folder under the system temp
dir (`$env:TEMP\minga\<run>` or `D:\Temp\minga\<run>`), and delete the folder
when the run ends; a run folder older than a few days is safe to delete without
asking. The repo root and `launch/` hold deliverables only: finished drafts,
final media, and the scripts that produced them. Stop every server, dev-server
and volunteer process a run started before deleting its folder — check by port
and by command line, and kill leftovers from earlier runs too.

## Work on Minga itself

```sh
bun install
bun test
bunx tsc --noEmit -p .
bun run build:kit && node dist/minga.mjs --version
```

- `src/core/` holds the protocol and domain contracts; it is lead-owned. Do not
  change it from a worker branch. Code against those types instead.
- `src/cli/` is the agents-first kit, bundled by `bun build --target=node` into
  `dist/minga.mjs`: Node builtins and global `fetch` only, no Bun APIs and no
  runtime dependencies. It imports `src/identity/keys.ts` and core types.
- `src/server/` is the Bun coordinator; `src/project/` parses `project.toml`;
  `src/verify/` runs checks and commits; `src/log/` stores the event log;
  `src/sched/` assigns tasks; `src/ui/` is the live dashboard.
- `test/cli.test.ts` and `test/mcp.test.ts` cover the kit. Keep commands
  non-interactive, with one-line errors and stable exit codes. Server errors
  carry the next step in `detail`; the kit prints it as a `next:` line.
- Release: bump `version` in `package.json` and the fallback in
  `src/cli/runtime.ts`, add a `CHANGELOG.md` entry, commit, push a `vX.Y.Z`
  tag. `release.yml` publishes through npm trusted publishing; never publish
  with a personal token.
