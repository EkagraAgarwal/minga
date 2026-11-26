#!/usr/bin/env bun
/**
 * Minga swarm load test.
 *
 * Simulates hundreds to thousands of signed agents against a Minga v2 server,
 * pins that server to a few cores, measures per-route latency with bounded
 * histograms, samples /api/metrics, watches the SSE stream, and writes a JSON
 * result to bench/results/. Exits non-zero only when setup fails.
 */

import { parseArgs, USAGE } from "./lib/args.ts";
import { runSwarm } from "./lib/harness.ts";
import { renderReport, writeResult } from "./lib/report.ts";
import { createTempRepo, removeDir, startServer, type RunningServer } from "./lib/setup.ts";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return;
  }

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    console.error(`bench: ${error instanceof Error ? error.message : String(error)}`);
    console.error(USAGE);
    process.exit(1);
    return;
  }

  let server: RunningServer | undefined;
  let repoDir: string | undefined;
  try {
    let baseUrl = opts.url;
    if (!baseUrl) {
      const repo = await createTempRepo(opts.tasks);
      repoDir = repo.dir;
      console.log(`bench: temp repo ${repo.dir} (${opts.tasks} tasks)`);
      server = await startServer(repo.dir, opts.port, opts.cores);
      baseUrl = server.url;
      console.log(`bench: server ready at ${baseUrl}; affinity ${server.pinNote}`);
    } else {
      console.log(`bench: using existing server at ${baseUrl} (no pinning, no teardown)`);
    }

    console.log(
      `bench: starting ${opts.agents} agents, ramp ${opts.ramp}/s, duration ${opts.duration}s, ` +
      `think ${opts.thinkMin}-${opts.thinkMax}s, pass ${opts.pass}`,
    );
    const result = await runSwarm(opts, baseUrl);
    console.log(renderReport(result, opts, baseUrl));
    const file = await writeResult(result, opts, baseUrl);
    console.log(`bench: full result written to ${file}`);
  } catch (error) {
    console.error(`bench: setup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    if (server) await server.stop();
    if (repoDir) await removeDir(repoDir);
  }
}

await main();
