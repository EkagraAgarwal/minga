/**
 * Multi-process load generation.
 *
 * A single Bun process caps concurrent fetches (BUN_CONFIG_MAX_HTTP_REQUESTS,
 * default 256). With 1000 agents holding 30 s long-polls, everything else
 * queues client-side and times out. The parent therefore splits the agents
 * across worker processes, each with a 4096-fetch cap, and merges the bucketed
 * histograms the workers send back as JSON lines on stdout.
 */

import { join } from "node:path";
import type { MetricsResponse } from "../../src/core/protocol.ts";
import { defaultProcs, type Options } from "./args.ts";
import { apiRequest } from "./client.ts";
import {
  computeTargets,
  type HarnessResult,
  type ServerLatency,
  type SseStats,
  type SwarmTotals,
} from "./harness.ts";
import { Histogram, type HistogramSnapshot } from "./histogram.ts";
import { type ErrorSample, type RouteSnapshot } from "./stats.ts";

export interface WorkerProgress {
  kind: "progress";
  worker: number;
  elapsed: number;
  joins: number;
  assignments: number;
  submitted: number;
  accepted: number;
  rejected: number;
  probeP99: number;
  errors5xx: number;
  errors409: number;
  errors410: number;
}

interface WorkerResultLine {
  kind: "result";
  worker: number;
  result: HarnessResult;
}

type WorkerLine = WorkerProgress | WorkerResultLine;

const EMPTY_HISTOGRAM: HistogramSnapshot = {
  count: 0, min: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0, sum: 0, buckets: 0, counts: [],
};

/** Worker count actually used: never more workers than agents. */
export function effectiveProcs(opts: Pick<Options, "agents" | "procs">): number {
  return Math.min(opts.procs ?? defaultProcs(opts.agents), opts.agents);
}

/** Even agent split, remainder to the earliest workers. */
export function sliceCounts(agents: number, procs: number): number[] {
  return Array.from({ length: procs }, (_, i) => distribute(agents, procs, i));
}

/** Share a fixed per-run budget (SSE viewers, probes) across workers. */
export function distribute(total: number, parts: number, index: number): number {
  const base = Math.floor(total / parts);
  return base + (index < total % parts ? 1 : 0);
}

/** Merge client-side results from all workers into one harness result. */
export function mergeWorkerResults(results: readonly HarnessResult[]): HarnessResult {
  if (results.length === 0) throw new Error("no worker results to merge");

  const routes: Record<string, RouteSnapshot> = {};
  const names = new Set<string>();
  for (const result of results) {
    for (const name of Object.keys(result.routes ?? {})) names.add(name);
  }
  for (const name of names) {
    const histogram = new Histogram();
    const errors = new Map<string, number>();
    const errorSamples: ErrorSample[] = [];
    let errors5xx = 0;
    let errors409 = 0;
    let errors410 = 0;
    for (const result of results) {
      const snapshot = result.routes[name];
      if (!snapshot) continue;
      histogram.mergeSnapshot(snapshot);
      for (const [status, count] of Object.entries(snapshot.errors ?? {})) {
        errors.set(status, (errors.get(status) ?? 0) + count);
      }
      errors5xx += snapshot.errors5xx ?? 0;
      errors409 += snapshot.errors409 ?? 0;
      errors410 += snapshot.errors410 ?? 0;
      for (const sample of snapshot.errorSamples ?? []) {
        if (errorSamples.length < 5) errorSamples.push(sample);
      }
    }
    const merged = histogram.snapshot();
    routes[name] = {
      ...merged,
      count: merged.count,
      errors: Object.fromEntries(errors),
      errors5xx,
      errors409,
      errors410,
      errorSamples,
    };
  }

  const queueWait = new Histogram();
  const check = new Histogram();
  const verdict = new Histogram();
  let pipelineCount = 0;
  for (const result of results) {
    pipelineCount += result.pipeline?.count ?? 0;
    queueWait.mergeSnapshot(result.pipeline?.queueWait ?? EMPTY_HISTOGRAM);
    check.mergeSnapshot(result.pipeline?.check ?? EMPTY_HISTOGRAM);
    verdict.mergeSnapshot(result.pipeline?.verdict ?? EMPTY_HISTOGRAM);
  }

  const totals: SwarmTotals = {
    joins: 0, joinErrors: 0, assignments: 0, noWork: 0, beats: 0, notes: 0,
    submissions: 0, accepted: 0, rejected: 0, releases: 0, polls: 0, resubmits: 0,
  };
  for (const result of results) {
    for (const key of Object.keys(totals) as (keyof SwarmTotals)[]) {
      totals[key] += result.totals?.[key] ?? 0;
    }
  }

  const sse: SseStats = { connections: 0, events: 0, errors: 0, maxLagMs: 0 };
  for (const result of results) {
    if (!result.sse) continue;
    sse.connections += result.sse.connections;
    sse.events += result.sse.events;
    sse.errors += result.sse.errors;
    sse.maxLagMs = Math.max(sse.maxLagMs, result.sse.maxLagMs);
  }

  const started = Math.min(...results.map((result) => Date.parse(result.startedAt)));
  const ended = Math.max(...results.map((result) => Date.parse(result.endedAt)));
  const samples = results.flatMap((result) => result.samples ?? []);
  return {
    startedAt: new Date(started).toISOString(),
    endedAt: new Date(ended).toISOString(),
    durationSeconds: (ended - started) / 1000,
    routes,
    pipeline: {
      count: pipelineCount,
      queueWait: queueWait.snapshot(),
      check: check.snapshot(),
      verdict: verdict.snapshot(),
    },
    samples,
    peakCpuPct: samples.reduce((peak, sample) => Math.max(peak, sample.cpuPct), 0),
    peakRssBytes: samples.reduce((peak, sample) => Math.max(peak, sample.rssBytes), 0),
    sse,
    totals,
    targets: computeTargets(routes, samples, sse, pipelineCount, {}),
    serverLatency: {},
  };
}

/** Read the server's own handling-time histogram at the end of the run. */
export async function readServerLatency(baseUrl: string): Promise<ServerLatency> {
  const metrics = await apiRequest<MetricsResponse>(
    baseUrl, undefined, "GET", "/api/metrics", undefined, 10_000,
  );
  return metrics.body?.latencyMs ?? {};
}

/** Attach server-side latency and recompute the verdict against its p99. */
export function finalizeResult(result: HarnessResult, serverLatency: ServerLatency): HarnessResult {
  const targets = computeTargets(
    result.routes, result.samples, result.sse, result.pipeline.count, serverLatency,
  );
  return { ...result, serverLatency, targets };
}

function spawnWorker(
  opts: Options, baseUrl: string, workerId: number,
  agents: number, agentOffset: number, viewerCount: number, probeCount: number,
) {
  const script = join(import.meta.dir, "..", "swarm.ts");
  const projectRoot = join(import.meta.dir, "..", "..");
  return Bun.spawn(
    [
      process.execPath, script,
      "--worker", "--worker-id", String(workerId),
      "--url", baseUrl,
      "--agents", String(agents),
      "--agent-offset", String(agentOffset),
      "--viewer-count", String(viewerCount),
      "--probe-count", String(probeCount),
      `--sample-metrics=${workerId === 0 ? "true" : "false"}`,
      "--duration", String(opts.duration),
      "--cores", String(opts.cores),
      "--ramp", String(opts.ramp),
      "--think", `${opts.thinkMin}-${opts.thinkMax}`,
      "--pass", String(opts.pass),
    ],
    {
      cwd: projectRoot,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      // Critical: each process gets its own 4096-fetch budget before any fetch.
      env: { ...process.env, BUN_CONFIG_MAX_HTTP_REQUESTS: "4096" },
    },
  );
}

/** Consume a stream one newline-terminated JSON line at a time. */
async function readLines(
  stream: ReadableStream<Uint8Array> | null,
  onLine: (line: string) => void,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = (line: string) => {
    const text = line.trim();
    if (text) onLine(text);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        flush(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    }
    flush(buffer);
  } catch {
    // The child exited and closed its pipe.
  }
}

function reportProgress(
  progress: Map<number, WorkerProgress>,
  expected: number,
  lastTick: { value: number },
): void {
  const values = [...progress.values()];
  if (values.length === 0) return;
  const elapsed = Math.max(...values.map((entry) => entry.elapsed));
  const tick = Math.floor(elapsed / 10);
  if (tick <= lastTick.value) return;
  lastTick.value = tick;
  const sum = (key: keyof WorkerProgress): number =>
    values.reduce((total, entry) => total + (Number(entry[key]) || 0), 0);
  const probeP99 = Math.max(...values.map((entry) => entry.probeP99 || 0));
  console.log(
    `[${String(elapsed).padStart(3)}s] workers=${values.length}/${expected} ` +
    `joins=${sum("joins")} assigned=${sum("assignments")} ` +
    `submitted=${sum("submitted")} accepted=${sum("accepted")} rejected=${sum("rejected")} ` +
    `nextProbe p99=${probeP99.toFixed(1)}ms 5xx=${sum("errors5xx")} ` +
    `409=${sum("errors409")} 410=${sum("errors410")}`,
  );
}

/**
 * Run the whole load test through worker processes: spawn, collect JSON lines,
 * merge client stats, then read server-side latency and print-ready targets.
 */
export async function runWorkers(opts: Options, baseUrl: string): Promise<HarnessResult> {
  const procs = effectiveProcs(opts);
  const counts = sliceCounts(opts.agents, procs);
  let nextOffset = 0;
  const children = counts.map((agents, id) => {
    const offset = nextOffset;
    nextOffset += agents;
    return spawnWorker(
      opts, baseUrl, id, agents, offset,
      distribute(20, procs, id), distribute(5, procs, id),
    );
  });

  const results: HarnessResult[] = [];
  const progress = new Map<number, WorkerProgress>();
  const lastTick = { value: -1 };
  const readers = children.map((child, id) => readLines(child.stdout, (line) => {
    let message: WorkerLine;
    try {
      message = JSON.parse(line) as WorkerLine;
    } catch {
      console.error(`bench worker ${id}: ${line}`);
      return;
    }
    if (message.kind === "progress") {
      progress.set(message.worker ?? id, message);
      reportProgress(progress, procs, lastTick);
    } else if (message.kind === "result" && message.result) {
      results.push(message.result);
    }
  }));
  const logReaders = children.map((child, id) =>
    readLines(child.stderr, (line) => console.error(`bench worker ${id}: ${line}`)),
  );

  await Promise.all([...children.map((child) => child.exited), ...readers, ...logReaders]);

  const failed = children.filter((child) => child.exitCode !== 0).length;
  const merged = mergeWorkerResults(results);
  const finalized = finalizeResult(merged, await readServerLatency(baseUrl));
  if (failed > 0) finalized.targets.notes.push(`${failed} worker(s) exited non-zero`);
  if (results.length !== procs) {
    finalized.targets.notes.push(`received ${results.length}/${procs} worker results`);
  }
  return finalized;
}
