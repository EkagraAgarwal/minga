/**
 * Check-pipeline timings, read from the SubmissionView fields so they are
 * reported separately from HTTP latency. All numbers stay in bounded
 * histograms: no raw sample is retained.
 */

import type { SubmissionView } from "../../src/core/protocol.ts";
import { Histogram, type HistogramSnapshot } from "./histogram.ts";

export interface SubmissionTimings {
  /** queuedAt -> startedAt: time spent waiting for a check slot. */
  queueWaitMs?: number;
  /** The check command's own duration. */
  checkMs?: number;
  /** queuedAt -> checkedAt: submit-to-verdict on the server. Informational only. */
  verdictMs?: number;
}

function elapsed(from: string | undefined, to: string | undefined): number | undefined {
  if (!from || !to) return undefined;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return undefined;
  return b - a;
}

/** Derive pipeline numbers from a final SubmissionView. Missing fields are omitted. */
export function submissionTimings(view: SubmissionView): SubmissionTimings {
  const out: SubmissionTimings = {};
  const queueWaitMs = elapsed(view.queuedAt, view.startedAt);
  if (queueWaitMs !== undefined) out.queueWaitMs = queueWaitMs;
  if (typeof view.durationMs === "number" && Number.isFinite(view.durationMs) && view.durationMs >= 0) {
    out.checkMs = view.durationMs;
  }
  const verdictMs = elapsed(view.queuedAt, view.checkedAt);
  if (verdictMs !== undefined) out.verdictMs = verdictMs;
  return out;
}

export interface PipelineSnapshot {
  count: number;
  queueWait: HistogramSnapshot;
  check: HistogramSnapshot;
  verdict: HistogramSnapshot;
}

export class PipelineStats {
  private readonly queueWait = new Histogram();
  private readonly check = new Histogram();
  private readonly verdict = new Histogram();
  private n = 0;

  get count(): number {
    return this.n;
  }

  record(timings: SubmissionTimings): void {
    this.n++;
    if (timings.queueWaitMs !== undefined) this.queueWait.record(timings.queueWaitMs);
    if (timings.checkMs !== undefined) this.check.record(timings.checkMs);
    if (timings.verdictMs !== undefined) this.verdict.record(timings.verdictMs);
  }

  snapshot(): PipelineSnapshot {
    return {
      count: this.n,
      queueWait: this.queueWait.snapshot(),
      check: this.check.snapshot(),
      verdict: this.verdict.snapshot(),
    };
  }
}
