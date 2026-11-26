/** CLI argument parsing for bench/swarm.ts. Pure so it can be unit-tested. */

export interface Options {
  agents: number;
  duration: number;
  cores: number;
  tasks: number;
  port: number;
  ramp: number;
  /** Lower bound of the simulated thinking time, in seconds. */
  thinkMin: number;
  /** Upper bound of the simulated thinking time, in seconds. */
  thinkMax: number;
  /** Probability that a submitted file contains the line "ok". */
  pass: number;
  /**
   * Check slots passed to the server as `--check-concurrency N`. Defaults to
   * cores - 1 (min 1) so the warm check pool fits the pinned cores.
   */
  checkConcurrency: number;
  /** Keep the generated temp repo after the run instead of deleting it. */
  keep: boolean;
  /**
   * Number of worker processes that share the agent load. Defaults to
   * max(1, ceil(agents / 250)) so no single Bun process holds more than about
   * 250 concurrent fetches (Bun's default HTTP connection cap is 256).
   */
  procs?: number;
  /** Internal: run as a worker child and emit JSON lines on stdout. */
  worker?: boolean;
  /** Internal: zero-based worker index, used only in progress labels. */
  workerId?: number;
  /** Internal: global index of this worker's first agent, for a shared ramp. */
  agentOffset?: number;
  /** Internal: SSE viewers this worker opens (the parent distributes 20 total). */
  viewerCount?: number;
  /** Internal: wait=0 probes this worker opens (the parent distributes 5 total). */
  probeCount?: number;
  /** Internal: whether this worker samples /api/metrics (only one worker does). */
  sampleMetrics?: boolean;
  /** If set, test this already-running server instead of starting one. */
  url?: string;
}

/** Default worker count for a given number of agents. */
export function defaultProcs(agents: number): number {
  return Math.max(1, Math.ceil(agents / 250));
}

export const DEFAULTS: Options = {
  agents: 1000,
  duration: 120,
  cores: 2,
  tasks: 500,
  port: 7799,
  ramp: 50,
  thinkMin: 2,
  thinkMax: 20,
  pass: 0.3,
  checkConcurrency: 1,
  keep: false,
};

export const USAGE = `Usage: bun bench/swarm.ts [options]

  --agents N      simulated agents (default ${DEFAULTS.agents})
  --duration N    test duration in seconds (default ${DEFAULTS.duration})
  --cores N       cores the server is pinned to (default ${DEFAULTS.cores})
  --tasks N       seed tasks in the generated project.toml (default ${DEFAULTS.tasks})
  --port N        port for the generated server (default ${DEFAULTS.port})
  --ramp N        agents joined per second (default ${DEFAULTS.ramp})
  --think A-B     thinking time range in seconds (default ${DEFAULTS.thinkMin}-${DEFAULTS.thinkMax})
  --pass F        probability a submission passes, 0..1 (default ${DEFAULTS.pass})
  --procs N       worker processes sharing the load
                  (default: max(1, ceil(agents / 250)))
  --check-concurrency N
                  server check slots, passed as --check-concurrency N
                  (default: cores - 1, minimum 1)
  --keep          keep the generated temp repo for inspection (default: delete it)
  --url URL       use an existing server; skips setup, pinning and teardown
  --help          print this message

Examples:
  bun bench/swarm.ts --agents 300 --duration 60
  bun bench/swarm.ts --agents 1000 --duration 120 --cores 2 --tasks 500
  bun bench/swarm.ts --agents 1000 --duration 90 --cores 2 --tasks 600 --check-concurrency 1
  bun bench/swarm.ts --agents 3000 --duration 180 --cores 3 --ramp 100
  bun bench/swarm.ts --agents 1000 --url http://127.0.0.1:7777
`;

function integer(name: string, raw: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`--${name} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return value;
}

function thinkRange(raw: string): { thinkMin: number; thinkMax: number } {
  const match = /^(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?$/.exec(raw.trim());
  if (!match || !match[1]) throw new Error(`--think must look like 2-20 or 5 (got "${raw}")`);
  const min = Number(match[1]);
  const max = match[2] === undefined ? min : Number(match[2]);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) {
    throw new Error(`--think range is invalid (got "${raw}")`);
  }
  return { thinkMin: min, thinkMax: max };
}

const BOOLEAN_FLAGS = new Set(["keep", "worker", "sample-metrics"]);

/** Parse CLI flags. Accepts both `--agents 300` and `--agents=300`. */
export function parseArgs(argv: readonly string[]): Options {
  const options: Options = { ...DEFAULTS };
  const known = new Set([
    "agents", "duration", "cores", "tasks", "port", "ramp", "think", "pass",
    "procs", "check-concurrency", "keep", "worker", "worker-id",
    "agent-offset", "viewer-count", "probe-count", "sample-metrics", "url",
  ]);
  let checkConcurrencySet = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("--")) throw new Error(`unexpected argument "${arg}"`);
    const eq = arg.indexOf("=");
    const name = (eq === -1 ? arg.slice(2) : arg.slice(2, eq)).trim();
    if (!known.has(name)) throw new Error(`unknown option "--${name}"`);
    let raw: string | undefined = eq === -1 ? undefined : arg.slice(eq + 1);
    if (BOOLEAN_FLAGS.has(name)) {
      if (raw !== undefined && raw !== "true" && raw !== "false") {
        throw new Error(`--${name} must be true or false (got "${raw}")`);
      }
      const enabled = raw === undefined || raw === "true";
      if (name === "keep") options.keep = enabled;
      else if (name === "worker") options.worker = enabled;
      else options.sampleMetrics = enabled;
      continue;
    }
    if (raw === undefined) {
      raw = argv[++i];
      if (raw === undefined || raw.startsWith("--")) {
        throw new Error(`--${name} needs a value`);
      }
    }

    switch (name) {
      case "agents": options.agents = integer(name, raw, 1); break;
      case "duration": options.duration = integer(name, raw, 1); break;
      case "cores": options.cores = integer(name, raw, 1, 256); break;
      case "tasks": options.tasks = integer(name, raw, 1); break;
      case "port": options.port = integer(name, raw, 1, 65535); break;
      case "ramp": options.ramp = integer(name, raw, 1); break;
      case "think": Object.assign(options, thinkRange(raw)); break;
      case "pass": {
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0 || value > 1) {
          throw new Error(`--pass must be between 0 and 1 (got "${raw}")`);
        }
        options.pass = value;
        break;
      }
      case "procs": options.procs = integer(name, raw, 1); break;
      case "worker-id": options.workerId = integer(name, raw, 0); break;
      case "agent-offset": options.agentOffset = integer(name, raw, 0); break;
      case "viewer-count": options.viewerCount = integer(name, raw, 0); break;
      case "probe-count": options.probeCount = integer(name, raw, 0); break;
      case "check-concurrency": options.checkConcurrency = integer(name, raw, 1); checkConcurrencySet = true; break;
      case "url": {
        let parsed: URL;
        try {
          parsed = new URL(raw);
        } catch {
          throw new Error(`--url must be an absolute http(s) URL (got "${raw}")`);
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          throw new Error(`--url must use http or https (got "${raw}")`);
        }
        options.url = parsed.toString().replace(/\/$/, "");
        break;
      }
    }
  }

  if (!checkConcurrencySet) options.checkConcurrency = Math.max(1, options.cores - 1);
  return options;
}
