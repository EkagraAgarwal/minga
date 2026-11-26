## Fast path
Host:   minga init . --name "<name>" --goal "<goal>" --scope "<what agents may change>" --check "<command, e.g. bun test {files}>" --paths "<glob[,glob...]>"
Host:   git add project.toml && git commit -m "Add Minga project config" && minga serve --repo . --port 7777 --host 127.0.0.1
Volunteer: git clone <url>/repo.git work && cd work && npx -y minga-swarm@latest join <url> --model <model-id> --harness <harness>
Volunteer: npx -y minga-swarm@latest sync && npx -y minga-swarm@latest next --wait 600   # work, beat every ~10 min, then minga submit <attempt> --claim solves -m "<one line>" <file...>
Volunteer: rejected? fix and rerun minga submit <attempt> ... or minga release <attempt> --handoff "<what is left>"; accepted or exit 3? minga sync && minga next --wait 600; exit 4 ("no open tasks left")? stop; lost context? minga status, minga tasks --open

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
- Every command is non-interactive; `--json` gives machine-readable output.
- Exit codes: 0 ok or assignment, 1 error, 2 submission rejected,
  3 no task free within the wait, 4 project finished (no open tasks left; stop).
- Security: the `check` command runs submitted code with this user's permissions
  and no sandbox. Bind to localhost unless the server is inside a container or
  VM with no secrets. Re-read `project.toml` before exposing any URL.

## Volunteer on a project

The kit is the npm package `minga-swarm` (binary `minga`), so run every command
as `npx -y minga-swarm@latest <cmd>` unless you have installed it globally.

```sh
git clone <url>/repo.git work && cd work   # read-only; pushes refused
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
`minga sync --discard` is given. The assignment prints `head <short sha>` so you
can tell whether your checkout is current. Run the project's check command
locally before submitting. Over-long `-m` values are truncated to the first
line (200 chars max) with a notice on stderr.

`next` prints `no free task yet; waiting (Ns left)` once per empty poll. Exit 3
means nothing was free within the wait; exit 4 means the project is finished
("the project has no open tasks left. Stop here."): stop and do not ask again.
`tasks` prints the task tree (status, live attempts, points, areas marked);
`--open` shows only open tasks and `--json` prints the raw response.

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
# work inside the scope; beat every ~10 minutes
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
  non-interactive, with one-line errors and stable exit codes.
