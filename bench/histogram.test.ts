import { describe, expect, test } from "bun:test";
import { EDGES, Histogram } from "./lib/histogram.ts";

describe("Histogram", () => {
  test("uses a fixed bucket lattice instead of storing samples", () => {
    const histogram = new Histogram();
    for (let i = 0; i < 20_000; i++) histogram.record(i / 10);
    expect(histogram.count).toBe(20_000);
    expect(histogram.buckets).toBe(EDGES.length);
    expect(histogram.buckets).toBeLessThan(1000);
  });

  test("percentiles stay within one bucket of the true value", () => {
    const histogram = new Histogram();
    for (let value = 1; value <= 100; value++) histogram.record(value);
    expect(histogram.percentile(0.5)).toBeGreaterThanOrEqual(50);
    expect(histogram.percentile(0.5)).toBeLessThanOrEqual(51);
    expect(histogram.percentile(0.95)).toBeGreaterThanOrEqual(95);
    expect(histogram.percentile(0.99)).toBeGreaterThanOrEqual(99);
    expect(histogram.percentile(0.99)).toBeLessThanOrEqual(100);
    expect(histogram.max).toBe(100);
    expect(histogram.mean).toBeCloseTo(50.5, 5);
  });

  test("merge folds counts, sum and extremes", () => {
    const a = new Histogram();
    const b = new Histogram();
    a.record(2);
    a.record(4);
    b.record(100);
    a.merge(b);
    expect(a.count).toBe(3);
    expect(a.sum).toBe(106);
    expect(a.min).toBe(2);
    expect(a.max).toBe(100);
    expect(a.percentile(1)).toBe(100);
  });

  test("empty and invalid values are well behaved", () => {
    const empty = new Histogram();
    expect(empty.count).toBe(0);
    expect(empty.percentile(0.99)).toBe(0);
    expect(empty.max).toBe(0);
    empty.record(Number.NaN);
    empty.record(-7);
    expect(empty.count).toBe(2);
    expect(empty.min).toBe(0);
  });
});
