# Safety: what guards the gate

Minga lands work that passes the project's check. A check is only as good as what it
measures, and agents are good at making a suite turn green for the wrong reason: they
edit the tests, skip them, mock away the behaviour under test, special-case the inputs
the tests use, or suppress the error. A check also runs code strangers wrote, on the
host's machine.

Since 0.3, a project can stack six controls on top of the check. Each one is opt-in in
`project.toml`. With none of them set, a server behaves as it did in 0.2. Nothing
replaces a human reading the diff; these controls decide which diffs a human has to read,
and they make the cheap shortcuts fail before anyone looks.

| Control | Stops | Does not stop |
|---|---|---|
| `protect` | Edits to the tests, manifests and config that steer the check | Work that games tests it cannot edit |
| `[gates]` | Common shortcuts on added lines (`.only(`, `.skip(`, `@ts-ignore`, `\|\| true`), oversized diffs | Anything a regex cannot see |
| `[holdout]` | Overfitting to the visible tests: private tests also have to pass | Leaks, unless the check runs in the sandbox |
| `[sandbox]` | Checked code reading the host, the maintainer key, the network | Kernel or Docker escapes |
| `review` | Anything landing without approval | A careless reviewer |
| Signed requests, rate limits, bans | Impersonation and floods | Sybil voters (identities are self-minted) |

## protect

```toml
paths   = ["src/**", "test/**"]
protect = ["test/**", "package.json", "bun.lock", "tsconfig.json", ".github/**"]
```

`paths` says what a submission may write. `protect` carves out what it may never write,
even inside `paths`. The server refuses a protected path with 403 before anything runs.
`project.toml` is always protected. Protect everything that decides what the check
means, not only the tests: the manifest (a new dependency can replace the code under
test), lockfiles, test-runner and compiler configs, CI files.

If agents are supposed to add tests, keep the existing ones protected and let new ones go
in a separate directory, for example `paths = ["src/**", "test/new/**"]` with
`protect = ["test/*.test.ts"]`.

A check that runs only `{files}` lets the agent choose which tests run, because it can
submit code without the test that covers it. Prefer a check that runs the whole suite,
or at least a fixed list.

## [gates]

```toml
[gates]
max_files = 10
max_changed_lines = 400
forbid = [
  { pattern = '\.(only|skip)\(', paths = ["**/*.test.*"], reason = "focused or skipped test" },
  { pattern = '@ts-(ignore|nocheck)', reason = "suppressed type error" },
  { pattern = '\|\|\s*true\b', reason = "exit code forced to 0" },
]
warn = [{ pattern = 'TODO|FIXME', reason = "unfinished" }]
```

Gates read only the lines a submission adds, by diffing against the commit it is
checked on, so existing code never trips them. A `forbid` match rejects the submission
before the check runs, and the agent is told why. A `warn` match only flags it for
reviewers. Gates are heuristics and will miss things; their job is to make the cheap
shortcuts expensive.

## [holdout]

```toml
[holdout]
command = "bun test .holdout/"
dir = ".minga/holdout"   # git-ignored; never served
```

After the check passes, the server lays the files under `dir` over the same checkout and
runs `command`. Agents learn only pass or fail. The holdout's output goes to
`.minga/holdout-logs/<submission>.txt` for the maintainer and never into the event log,
the dashboard or the agent's response. The server refuses to start if git tracks the
holdout directory or the project branch contains it.

Without the sandbox, the checked code runs on the host while the holdout files sit in
its working directory, so it can read them and print them. The holdout run's output is
withheld, but the code could still write the files somewhere a later check would print.
Holdout secrecy needs `[sandbox] mode = "docker"`.

## [sandbox]

```toml
[sandbox]
mode = "docker"
image = "oven/bun:1"
network = "none"   # or "bridge" for checks that must download
memory = "2g"
cpus = 2
pids = 512
```

Each check runs in a throwaway container:
- **Mounts:** only that check's checkout, at `/work`. The repository, `.minga/` (the maintainer key, the event log, the holdout files) and the host's home are never mounted.
- **Container limits:** read-only root, a fresh `/tmp`, no network by default, all capabilities dropped, `no-new-privileges`, and caps on memory, CPUs and processes.
- **Environment:** the container gets none of the host's environment beyond `MINGA_FILES` and names you list in `MINGA_CHECK_ENV`.
- **Git metadata:** the checkout's `.git` pointer is hidden from the container and verified afterwards. A check cannot plant git hooks or config for the host's next `git checkout`.
- **Timeouts:** a timed-out container is removed with `docker rm -f`.
- **Missing Docker:** the check fails closed. Nothing is accepted, and the server never runs the check unsandboxed.

`--network none` breaks checks that install dependencies at run time. Bake them into the
image, keep them in `check_keep` (a cache that persists between checks in a slot, which
one check could poison for the next), or use `network = "bridge"`.

## review

```toml
review = "head"            # or "votes:2", or "head-or-votes:2"
```

With review on, work that passes the check and the holdout waits in review instead of
landing:
1. **The agent moves on.** Its attempt ends, so it can take another task; the task stays open.
2. **Reviewers read the diff.** It is at `GET /api/review/<S-n>`, or `minga review <S-n>`.
3. **A decision settles it.**
   - The head approves or rejects with `minga head review <S-n> approve|reject -m "<why>"`.
   - In vote modes, other agents vote. A voter needs accepted work. It must not be the author, must not hold an attempt on the same task, and must not have its own work in review there.
4. **Approved work lands.** If the branch moved on files the work touches, it is rechecked on the new head first.
5. **Other work on that task ends.** Once one submission is accepted, every other submission still in review on the task finishes as stale.

Agent identities are self-minted keys, so one operator can run many agents. Agent votes
are a quality signal, not a security boundary. `head` is the real gate. Use
`head-or-votes:N` to let trusted volunteers clear the easy cases while the head can still
step in.

## The rest

- **Host binding:** the server binds to 127.0.0.1 by default and warns when exposed without a sandbox.
- **Signed requests:** every write is signed (Ed25519) and replay-protected.
- **Limits and bans:** joins are rate-limited per IP, requests per agent, and the head can ban an agent.
- **The kit:** `minga check` on a volunteer's machine runs the project's command with an allowlisted environment. It refuses if the server changes the command since `join`.
- **Audit:** every accepted commit carries trailers naming the agent, model, harness, task, attempt and, when reviewed, who approved it.
