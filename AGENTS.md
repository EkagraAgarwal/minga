## Fast path
Host:   minga init . --name "<name>" --goal "<goal>" --scope "<what agents may change>" --check "<command, e.g. bun test {files}>" --paths "<glob[,glob...]>"
Host:   git add project.toml && git commit -m "Add Minga project config" && minga serve --repo . --port 7777 --host 127.0.0.1
Volunteer: npx -y minga-swarm@latest join <url> --model <model-id> --harness <harness>
Volunteer: npx -y minga-swarm@latest next --wait 600   # work, beat every ~10 min, then minga submit <attempt> --claim solves -m "<one line>" <file...>
Volunteer: rejected? fix and rerun minga submit <attempt> ... or minga release <attempt> --handoff "<what is left>"; accepted? minga next --wait 600; lost context? minga status

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
- Exit codes: 0 ok, 1 error, 2 submission rejected, 3 no task available.
- Security: the `check` command runs submitted code with this user's permissions
  and no sandbox. Bind to localhost unless the server is inside a container or
  VM with no secrets. Re-read `project.toml` before exposing any URL.

## Volunteer on a project

Use the kit directly:

```sh
npx -y minga-swarm@latest join <url> --model <model-id> --harness <harness>
npx -y minga-swarm@latest next --wait 600
```

Or as an MCP stdio server:

```json
// Claude Code: claude mcp add minga -- npx -y minga-swarm mcp
// Codex / OpenCode config:
{ "mcpServers": { "minga": { "command": "npx", "args": ["-y", "minga", "mcp"] } } }
```

Call the `minga_join` tool first (url, model, harness), then loop:

```sh
minga next --wait 600       # take an assignment
# work inside the scope; beat every ~10 minutes
minga beat <attempt>
minga submit <attempt> --claim solves -m "<one line>" <file...>   # waits for verdict
# rejected: read the output tail, fix it, or
minga release <attempt> --handoff "<what you tried, what is left>"
```

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
