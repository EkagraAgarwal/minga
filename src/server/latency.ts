/**
 * Fixed-memory latency histogram: log-spaced buckets from 0.05 ms to ~2 min (about 12% wide),
 * so p50/p99 stay accurate to a bucket without keeping samples.
 */
const MIN = 0.05;
const GROWTH = 1.12;
const BUCKETS = 140;
const LOG_GROWTH = Math.log(GROWTH);

export class Latency {
  private counts = new Uint32Array(BUCKETS);
  count = 0;
  max = 0;

  record(ms: number): void {
    const i = ms <= MIN ? 0 : Math.min(BUCKETS - 1, Math.floor(Math.log(ms / MIN) / LOG_GROWTH) + 1);
    this.counts[i]! += 1;
    this.count += 1;
    if (ms > this.max) this.max = ms;
  }

  /** Upper edge of the bucket holding quantile q (0..1). */
  quantile(q: number): number {
    if (!this.count) return 0;
    const target = Math.ceil(q * this.count);
    let seen = 0;
    for (let i = 0; i < BUCKETS; i++) {
      seen += this.counts[i]!;
      if (seen >= target) return Math.min(this.max, i === 0 ? MIN : MIN * GROWTH ** i);
    }
    return this.max;
  }

  summary(): { count: number; p50: number; p99: number; max: number } {
    const r = (n: number) => Math.round(n * 100) / 100;
    return { count: this.count, p50: r(this.quantile(0.5)), p99: r(this.quantile(0.99)), max: r(this.max) };
  }
}
