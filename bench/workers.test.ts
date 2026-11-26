import { describe, expect, test } from "bun:test";
import type { MetricsSample } from "./lib/harness.ts";
import { computeTargets, type HarnessResult, type ServerLatency, type SwarmTotals } from "./lib/harness.ts";
import { Histogram } from "./lib/histogram.ts";
import { distribute, effectiveProcs, finalizeResult, mergeWorkerResults, sliceCounts } from "./lib/workers.ts";
import type { RouteSnapshot } from "./lib/stats.ts";

function totals(): SwarmTotals {
  return {
    joins: 0, joinErrors: 0, assignments: 0, noWork: 0, beats: 0, notes: 0,
    submissions: 0, accepted: 0, rejected: 0, releases: 0, polls: 0, resubmits: 0,
  };
}

function snapshot(values: number[]): RouteSnapshot {
  const histogram = new Histogram();
  for (const value of values) histogram.record(value);
  return {
    ...histogram.snapshot(),
    errors: {}, errors5xx: 0, errors409: 0, errors410: 0, errorSamples: [],
  };
}

function harnessResult(partial: Partial<HarnessResult> = {}): HarnessResult {
  const empty = new Histogram().snapshot();
  return {
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:10.000Z",
    durationSeconds: 10,
    routes: {},
    pipeline: { count: 0, queueWait: empty, check: empty, verdict: empty },
    samples: [],
    peakCpuPct: 0,
    peakRssBytes: 0,
    sse: { connections: 0, events: 0, errors: 0, maxLagMs: 0 },
    totals: totals(),
    targets: computeTargets({}, [], { connections: 0, events: 0, errors: 0, maxLagMs: 0 }, 0, {}),
    serverLatency: {},
    ...partial,
  };
}

function sample(cpuPct: number): MetricsSample {
  return {
    tMs: 0, uptimeSeconds: 10, cpuSeconds: 2, cpuPct, rssBytes: 100 * 1024 * 1024,
    heapUsedBytes: 10 * 1024 * 1024,
    queue: { queued: 0, checking: 0, concurrency: 1 },
    waiting: 0, seq: 1, agents: 1, liveAttempts: 0, streams: 0,
  };
}

describe("worker splitting", () => {
  test("effective process count defaults from agents and never exceeds them", () => {
    expect(effectiveProcs({ agents: 1000 })).toBe(4);
    expect(effectiveProcs({ agents: 2500 })).toBe(10);
    expect(effectiveProcs({ agents: 1000, procs: 2 })).toBe(2);
    expect(effectiveProcs({ agents: 10, procs: 50 })).toBe(10);
  });

  test("agent slices are even and sum to the total", () => {
    expect(sliceCounts(1000, 4)).toEqual([250, 250, 250, 250]);
    expect(sliceCounts(2501, 4)).toEqual([626, 625, 625, 625]);
    expect(sliceCounts(2500, 10).reduce((a, b) => a + b, 0)).toBe(2500);
  });

  test("fixed overhead is shared across workers", () => {
    expect(Array.from({ length: 10 }, (_, i) => distribute(20, 10, i))).toEqual(Array(10).fill(2));
    expect(Array.from({ length: 10 }, (_, i) => distribute(5, 10, i))).toEqual([1, 1, 1, 1, 1, 0, 0, 0, 0, 0]);
    expect(Array.from({ length: 3 }, (_, i) => distribute(20, 3, i))).toEqual([7, 7, 6]);
  });
});

describe("mergeWorkerResults", () => {
  test("adds bucket counts, counters, errors and SSE across workers", () => {
    const a = harnessResult({
      routes: { "POST /api/beat": snapshot(Array(10).fill(5)) },
      totals: { ...totals(), joins: 10, beats: 4 },
      sse: { connections: 20, events: 3, errors: 1, maxLagMs: 50 },
      samples: [sample(10)],
    });
    const b = harnessResult({
      routes: {
        "POST /api/beat": {
          ...snapshot(Array(20).fill(5)),
          errors: { network: 2 }, errors5xx: 1, errors409: 1,
          errorSamples: [{ status: 0, body: "timeout" }],
        },
      },
      totals: { ...totals(), joins: 15, beats: 6 },
      sse: { connections: 20, events: 5, errors: 0, maxLagMs: 90 },
      samples: [sample(30)],
    });
    const merged = mergeWorkerResults([a, b]);
    const beat = merged.routes["POST /api/beat"]!;
    expect(beat.count).toBe(30);
    expect(beat.p50).toBeCloseTo(5, 1);
    expect(beat.errors).toEqual({ network: 2 });
    expect(beat.errors5xx).toBe(1);
    expect(beat.errorSamples).toEqual([{ status: 0, body: "timeout" }]);
    expect(merged.totals.joins).toBe(25);
    expect(merged.totals.beats).toBe(10);
    expect(merged.sse).toEqual({ connections: 40, events: 8, errors: 1, maxLagMs: 90 });
    expect(merged.peakCpuPct).toBe(30);
    expect(mergeWorkerResults([a, b]).routes["POST /api/beat"]!.counts).toHaveLength(beat.buckets);
  });
});

describe("server-side target", () => {
  test("PASS/FAIL follows server p99, not the client p99", () => {
    const latency: ServerLatency = {
      "POST /api/submit": { count: 100, p50: 5, p99: 120, max: 200 },
      "POST /api/beat": { count: 100, p50: 3, p99: 20, max: 50 },
    };
    const result = harnessResult({
      routes: { "POST /api/submit": snapshot([900]) },
      samples: [sample(10)],
    });
    const finalized = finalizeResult(result, latency);
    expect(finalized.serverLatency).toEqual(latency);
    expect(finalized.targets.serverP99Ms).toBe(120);
    expect(finalized.targets.serverP99Pass).toBe(true);
    expect(finalized.targets.clientP99Ms).toBeGreaterThan(100);
    expect(finalized.targets.overall).toBe(true);

    const slow = finalizeResult(result, {
      ...latency, "POST /api/submit": { count: 100, p50: 5, p99: 400, max: 900 },
    });
    expect(slow.targets.serverP99Pass).toBe(false);
    expect(slow.targets.overall).toBe(false);
  });

  test("a server without latencyMs leaves the target unproven", () => {
    const targets = computeTargets({}, [sample(10)], { connections: 1, events: 0, errors: 0, maxLagMs: 0 }, 1, {});
    expect(targets.serverP99Pass).toBe(false);
    expect(targets.notes).toContain("no server-side latency in /api/metrics: p99 target is unproven");
  });
});
