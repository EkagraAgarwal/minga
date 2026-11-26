/**
 * Fixed-memory, HDR-style log-bucket histogram for latency measurements.
 *
 * Samples are never stored individually: each observation increments one of a
 * small, fixed set of buckets (denser at low latencies, geometric at higher
 * ones). A million samples cost the same memory as a thousand. Percentiles are
 * read as the upper edge of the bucket that crosses the rank, which keeps p99
 * within the bucket width (<= 10 ms in the 100..1000 ms range that matters for
 * the load-test target).
 */

interface Level {
  /** Bucket edges are generated up to this value (ms). */
  until: number;
  /** Width of a bucket inside this level (ms). */
  step: number;
}

const LEVELS: readonly Level[] = [
  { until: 1, step: 0.01 },
  { until: 10, step: 0.1 },
  { until: 100, step: 1 },
  { until: 1000, step: 10 },
  { until: 10_000, step: 100 },
  { until: 60_000, step: 1000 },
  { until: 600_000, step: 10_000 },
];

function buildEdges(): Float64Array {
  const edges: number[] = [];
  let start = 0;
  for (const level of LEVELS) {
    const buckets = Math.ceil((level.until - start) / level.step);
    for (let i = 1; i <= buckets; i++) edges.push(start + i * level.step);
    start = level.until;
  }
  // Overflow bucket: anything beyond the last generated edge (10 minutes).
  edges.push(Number.POSITIVE_INFINITY);
  return Float64Array.from(edges);
}

/** Upper edge of every bucket. Shared by all histograms; never mutated. */
export const EDGES: Float64Array = buildEdges();

/** Index of the first edge >= value (binary search, O(log buckets)). */
function bucketIndex(value: number): number {
  let lo = 0;
  let hi = EDGES.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((EDGES[mid] ?? 0) < value) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(lo, EDGES.length - 1);
}

export interface HistogramSnapshot {
  count: number;
  min: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  sum: number;
  /** Number of buckets in the fixed lattice (for asserting bounded memory). */
  buckets: number;
}

export class Histogram {
  private readonly counts = new Uint32Array(EDGES.length);
  private total = 0;
  private sumValues = 0;
  private minValue = Number.POSITIVE_INFINITY;
  private maxValue = 0;

  get count(): number {
    return this.total;
  }

  get sum(): number {
    return this.sumValues;
  }

  get mean(): number {
    return this.total === 0 ? 0 : this.sumValues / this.total;
  }

  get min(): number {
    return this.total === 0 ? 0 : this.minValue;
  }

  get max(): number {
    return this.maxValue;
  }

  get buckets(): number {
    return EDGES.length;
  }

  /** Record one observation in milliseconds. Non-finite/negative values clamp to 0. */
  record(valueMs: number): void {
    const value = Number.isFinite(valueMs) ? Math.max(0, valueMs) : 0;
    const index = bucketIndex(value);
    this.counts[index] = (this.counts[index] ?? 0) + 1;
    this.total++;
    this.sumValues += value;
    if (value < this.minValue) this.minValue = value;
    if (value > this.maxValue) this.maxValue = value;
  }

  /** Upper bucket edge at the given rank (p in [0,1]); 0 for an empty histogram. */
  percentile(p: number): number {
    if (this.total === 0) return 0;
    const rank = Math.ceil(Math.min(1, Math.max(0, p)) * this.total);
    let cumulative = 0;
    for (let i = 0; i < this.counts.length; i++) {
      cumulative += this.counts[i] ?? 0;
      if (cumulative >= rank) return EDGES[i] ?? 0;
    }
    return this.maxValue;
  }

  /** Fold another histogram into this one (used to merge probe/route samples). */
  merge(other: Histogram): void {
    for (let i = 0; i < this.counts.length; i++) {
      this.counts[i] = (this.counts[i] ?? 0) + (other.counts[i] ?? 0);
    }
    this.total += other.total;
    this.sumValues += other.sumValues;
    this.minValue = Math.min(this.minValue, other.minValue);
    this.maxValue = Math.max(this.maxValue, other.maxValue);
  }

  snapshot(): HistogramSnapshot {
    return {
      count: this.total,
      min: this.min,
      mean: this.mean,
      p50: this.percentile(0.5),
      p95: this.percentile(0.95),
      p99: this.percentile(0.99),
      max: this.max,
      sum: this.sumValues,
      buckets: EDGES.length,
    };
  }
}
