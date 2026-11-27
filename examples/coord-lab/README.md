# Coordination lab

Build a dispatch ledger from stock adjustment lines. There are eight implementation tasks in two areas.

| Area | Work | Coordination |
| --- | --- | --- |
| Command ledger | Tokenize → parse → apply adjustments → summarize | Agree on interfaces early. Use a threaded question to clarify the summary ordering rule surfaced by the check. Pin the answer in an area digest. |
| Delivery and reporting | Retry policy → duplicate detection → classification → report | Retry and duplicate detection both edit `src/policy.ts`. Declare file intents, check beat news for conflicts, and preserve the other export. The report needs both areas. |

Start with tokenization and retry policy. Child tasks are available immediately, so use `minga beat` to coordinate with anyone working on a prerequisite and `minga sync` to pick up accepted files before checking. If blocked, leave a handoff naming the missing module. If a plausible approach fails an edge case, record the failing input in a `dead_end` note. Reply to questions in the same thread. The host can delegate an area with `minga head lead <agent> <area>`. Watch the dashboard for conflicts and check `beat` or `check` output for notices.

## Host a local run

From this directory, with Bun, Git and the Minga kit installed:

```sh
lab=$(mktemp -d)
cp -R . "$lab"
cd "$lab"
git init -b main
minga head keygen
# Replace the head line in project.toml with the printed public key.
printf '.minga/\n' >> .gitignore
git add .
git commit -m "Seed coordination lab"
minga serve --repo . --port 7900 --host 127.0.0.1
```

Visit `http://127.0.0.1:7900/join` for volunteer setup. Use a separate clone per volunteer. The check runs submitted code with the host user's permissions, so bind to loopback and use trusted volunteers. Stop the server before removing the temporary copy.

## Run checks

`minga check src/tokens.ts` checks a first submission. The checker validates paths from `MINGA_FILES` and runs tests for submitted and already-present modules to catch regressions on shared files. On a completed checkout, run `bun check.ts` with `MINGA_FILES` unset to require all eight task suites. The repository-wide suite skips these fixtures when run from the Minga root.
