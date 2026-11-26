# Minga swarm load test

`bench/swarm.ts` simulates 100s to 1000s of independent agents against a real
Minga server and checks whether it stays fast on a small VPS. It talks strictly
to the published v2 HTTP protocol (`src/core/protocol.ts`) — it never imports
`src/server` internals — so it works while the server is being rewritten.

## What it measures

- **Per-route load and latency** for `POST /api/join`, `/api/next`, `/beat`,
  `/note`, `/submit`, `/release`, `GET /api/submission`, `/api/view` and
  `/api/metrics`. Latency uses a fixed-memory HDR-style log-bucket histogram:
  counts, errors by status, p50/p95/p99/max are reported; raw samples are never
  retained (a few hundred buckets serve millions of requests).
- **The p99 that matters.** Agent `next` calls use a 30 s long poll, so their
  wall time is intentionally large. A separate group of 5 probe agents issues
  `POST /api/next` with `wait=0` every second and immediately releases any
  assignment it gets; *that* histogram is used for the `next < 250 ms` target,
  and the probe's own release latency is recorded on a separate route. `beat`,
  `note`, `submit` and `release` use their normal latencies.
- **Check pipeline, separate from HTTP latency.** For every final submission the
  harness reads `SubmissionView.queuedAt`, `startedAt`, `checkedAt` and
  `durationMs` and reports queue wait, check time and submit-to-verdict
  p50/p95/p99. Submit-to-verdict is informational: it depends on the project's
  check, not on the coordinator's hot path.
- **Server health** from `GET /api/metrics` every 5 s: process CPU seconds
  converted to a percentage of the pinned cores, RSS, queue depth, waiting
  long-polls, seq, agents and live attempts.
- **SSE fan-out** from 20 fake UI viewers on `GET /api/stream`: events received,
  connection errors and max lag (`now - event.at`).
- Each simulated agent has its own ed25519 key, a realistic model/harness mix,
  and loops through `next (wait=30) → think → (beat) → (note) → submit →
  poll submission → resubmit on the same attempt or release-with-handoff` until
  the duration ends. A timed-out submission poll just polls again; an attempt is
  never released while its submission is queued, and it is never held when
  `next` is called again. Joins ramp at `--ramp` agents/second. Retries on 429
  honour `Retry-After` (default 2 s), and all requests use keep-alive connections.

## Running it

From the repository root (Bun 1.4+, git on PATH):

```sh
# quick smoke test: 300 agents, 60 seconds
bun bench/swarm.ts --agents 300 --duration 60 --tasks 200

# the standard run: 1000 agents, 120 seconds, server pinned to 2 cores
bun bench/swarm.ts --agents 1000 --duration 120 --cores 2 --tasks 500

# stress run: 3000 agents, 3 cores, faster ramp
bun bench/swarm.ts --agents 3000 --duration 180 --cores 3 --tasks 1000 --ramp 100
```

Options (all optional):

| Flag | Default | Meaning |
| --- | --- | --- |
| `--agents N` | 1000 | number of simulated agents |
| `--duration N` | 120 | test length in seconds |
| `--cores N` | 2 | cores the generated server is pinned to |
| `--tasks N` | 500 | seed tasks in the generated `project.toml` |
| `--port N` | 7799 | port for the generated server |
| `--ramp N` | 50 | joins per second |
| `--think A-B` | 2-20 | thinking time range in seconds |
| `--pass F` | 0.3 | probability a submitted file contains `ok` |
| `--check-concurrency N` | `cores - 1` (min 1) | passed to the server as `--check-concurrency N` so the pool fits the pinned cores |
| `--keep` | off | keep the generated temp repo for inspection |
| `--url URL` | — | test an existing server; skips setup, pinning and teardown |
| `--help` | — | print usage |

Without `--url`, the harness creates a temp git repo with a `check.ts` (exits 0
when every file in `MINGA_FILES` contains the line `ok`), a valid `project.toml`
(`check = "bun check.ts"`, `paths = ["work/**/*.txt"]`, `width = 3`,
`lease_minutes = 2`, `check_concurrency` left at auto in the TOML, and `--tasks`
`[[task]]` entries), an initial commit on `main`, then starts
`bun src/server/main.ts --repo <tmp> --port <port> --check-concurrency <N>
--join-limit 0`. Server stdout and stderr are streamed straight to
`bench/results/<run>-server.log`; they are never buffered in memory.

The server process is pinned with PowerShell `ProcessorAffinity` on Windows,
`taskset -cp` on Linux, and a printed warning on macOS (unsupported). The
harness waits for `GET /api/project` before starting agents. It kills the
server and removes the temp repo afterwards (with retries for Windows file
locks), unless `--keep` was given. **Do not point `--url` at a server you cannot
afford to load.**

## Reading results

Every 10 s a one-line status shows joins, assignments, submissions, verdicts,
the probe p99, the 5xx count and the 409/410 counts. At the end a compact table
is printed, e.g.:

```
route                    count      p50      p95      p99      max  errors
POST /api/next probe       120      3.1      7.8     11.2     22.4  -
POST /api/submit         2,410     12.4     48.1     96.7    210.3  429:3
...
CHECK PIPELINE (from SubmissionView fields, informational)
  queue wait            n=   1200 p50=     2.0 p95=    12.0 p99=    30.0
  check time            n=   1200 p50=     8.0 p95=    40.0 p99=    90.0
  submit->verdict       n=   1200 p50=    12.0 p95=    60.0 p99=   130.0
TARGETS
  p99 next(probe)/beat/note/submit/release < 250 ms : 96.7 ms      PASS
  5xx responses == 0                      : 0            PASS
  409/410 responses == 0 (409=0, 410=0)   : 0            PASS
  server CPU < 85% of 2 cores             : 61.3%        PASS
  RSS < 1.5 GB                            : 312.4 MB     PASS
OVERALL: PASS
```

When any route returns an error, the first five raw error bodies per route are
printed under `ERROR BODIES` so harness protocol misuse is diagnosable.

The full run — config, every route histogram and error map, all metric samples,
SSE counters, totals and target verdicts — is written as JSON to
`bench/results/<ISO timestamp>-<agents>a.json` (colons and dots in the timestamp
are replaced with `-` so the name works on Windows).

`errors` shows non-2xx responses by status (`network` for transport failures).
A high p99 on `POST /api/next` (non-probe) is expected: those are 30 s long
polls. Empty sections are called out in the `notes` field — for example, an
older server without `/api/metrics` leaves CPU/RSS unproven rather than
silently passing.

Exit status is **0 unless setup failed** (bad args, no git, temp repo or server
that never answers `/api/project`). A failing target prints `FAIL` but still
exits 0: the JSON/table are the verdict, not the process code.

## Targets

| Target | Threshold |
| --- | --- |
| p99 of `next` (wait=0 probes), `beat`, `note`, `submit`, `release` | < 250 ms |
| 5xx responses on any measured route | 0 |
| 409/410 responses caused by the harness | 0 (any 409 indicates a bug) |
| Server CPU, as % of the pinned cores | < 85% |
| Server RSS | < 1.5 GB |

Submit-to-verdict latency is reported but is **not** a target: it depends on
the project's check command rather than the coordinator's request path.

## Unit tests and typecheck

```sh
bun test bench
bunx tsc --noEmit -p bench/tsconfig.json
```

The tests cover the histogram, the argument parser, and the setup phase
(temp repo, TOML validity via `Bun.TOML.parse`, `check.ts` exit codes). Errors
elsewhere in the repository during a full `bunx tsc --noEmit -p .` are expected
while the server rewrite is in progress.
