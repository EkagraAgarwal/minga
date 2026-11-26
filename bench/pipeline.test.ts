import { describe, expect, test } from "bun:test";
import type { SubmissionView } from "../src/core/protocol.ts";
import { PipelineStats, submissionTimings } from "./lib/pipeline.ts";

function view(partial: Partial<SubmissionView>): SubmissionView {
  return {
    id: "sub-1", attempt: "att-1", task: "task-1", agent: "agent-1", model: "m",
    claim: "progress", message: "m", files: [], bytes: 0, status: "rejected",
    queuedAt: "2026-01-01T00:00:00.000Z", runs: 1, points: 0, ...partial,
  };
}

describe("submissionTimings", () => {
  test("derives queue wait, check time and submit-to-verdict from view fields", () => {
    const t = submissionTimings(view({
      startedAt: "2026-01-01T00:00:00.250Z",
      checkedAt: "2026-01-01T00:00:01.000Z",
      durationMs: 700,
    }));
    expect(t.queueWaitMs).toBe(250);
    expect(t.checkMs).toBe(700);
    expect(t.verdictMs).toBe(1000);
  });

  test("omits fields that are not present yet", () => {
    expect(submissionTimings(view({}))).toEqual({});
    const t = submissionTimings(view({ startedAt: "2026-01-01T00:00:00.100Z", durationMs: 5 }));
    expect(t).toEqual({ queueWaitMs: 100, checkMs: 5 });
  });

  test("ignores invalid and backwards timestamps", () => {
    const t = submissionTimings(view({
      startedAt: "not-a-date", checkedAt: "2025-01-01T00:00:00.000Z", durationMs: -1,
    }));
    expect(t).toEqual({});
  });
});

describe("PipelineStats", () => {
  test("counts every final submission and keeps bounded snapshots", () => {
    const stats = new PipelineStats();
    stats.record(submissionTimings(view({
      startedAt: "2026-01-01T00:00:00.250Z", checkedAt: "2026-01-01T00:00:01.000Z", durationMs: 700,
    })));
    stats.record(submissionTimings(view({})));
    const snap = stats.snapshot();
    expect(snap.count).toBe(2);
    expect(snap.queueWait.count).toBe(1);
    expect(snap.check.count).toBe(1);
    expect(snap.verdict.count).toBe(1);
    expect(snap.verdict.p99).toBeGreaterThan(0);
  });
});
