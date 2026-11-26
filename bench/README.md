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
  `POST /api/next` with `wait=0` every second; *that* histogram is used for the
  `next < 250 ms` target. `beat`, `note` and `submit` use their normal latencies.
- **Server health** from `GET /api/metrics` every 5 s: process CPU seconds
  converted to a percentage of the pinned cores, RSS, queue depth, waiting
  long-polls, seq, agents and live attempts.
- **SSE fan-out** from 20 fake UI viewers on `GET /api/stream`: events received,
  connection errors and max lag (`now - event.at`).
- Each simulated agent has its own ed25519 key, a realistic model/harness mix,
  and loops through `next (wait=30) → think → (beat) → (note) → submit →
  poll submission → resubmit or release-with-handoff` until the duration ends.
  Joins ramp at `--ramp` agents/second. Retries on 429 honour `Retry-After`
  (default 2 s), and all requests use keep-alive connections.

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
| `--url URL` | — | test an existing server; skips setup, pinning and teardown |
| `--help` | — | print usage |

Without `--url`, the harness creates a temp git repo with a `check.ts` (exits 0
when every file in `MINGA_FILES` contains the line `ok`), a valid `project.toml`
(`check = "bun check.ts"`, `paths = ["work/**/*.txt"]`, `width = 3`,
`lease_minutes = 2`, `check_concurrency` at auto, and `--tasks` `[[task]]`
entries), an initial commit on `main`, then starts
`bun src/server/main.ts --repo <tmp> --port <port> --join-limit 0`.

The server process is pinned with PowerShell `ProcessorAffinity` on Windows,
`taskset -cp` on Linux, and a printed warning on macOS (unsupported). The
harness waits for `GET /api/project` before starting agents. It kills the
server and removes the temp repo afterwards (with retries for Windows file
locks). **Do not point `--url` at a server you cannot afford to load.**

## Reading results

Every 10 s a one-line status shows joins, assignments, submissions, verdicts,
the probe p99 and the 5xx count. At the end a compact table is printed, e.g.:

```
route                    count      p50      p95      p99      max  errors
POST /api/next probe       120      3.1      7.8     11.2     22.4  -
POST /api/submit         2,410     12.4     48.1     96.7    210.3  429:3
...
TARGETS
  p99 next(probe)/beat/note/submit < 250 ms : 96.7 ms      PASS
  5xx responses == 0                      : 0            PASS
  server CPU < 85% of 2 cores             : 61.3%        PASS
  RSS < 1.5 GB                            : 312.4 MB     PASS
OVERALL: PASS
```

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
| p99 of `next` (wait=0 probes), `beat`, `note`, `submit` | < 250 ms |
| 5xx responses on any measured route | 0 |
| Server CPU, as % of the pinned cores | < 85% |
| Server RSS | < 1.5 GB |

## Unit tests and typecheck

```sh
bun test bench
bunx tsc --noEmit -p bench/tsconfig.json
```

The tests cover the histogram, the argument parser, and the setup phase
(temp repo, TOML validity via `Bun.TOML.parse`, `check.ts` exit codes). Errors
elsewhere in the repository during a full `bunx tsc --noEmit -p .` are expected
while the server rewrite is in progress.
