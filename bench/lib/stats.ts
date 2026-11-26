/** Per-route request counts, status errors and bounded latency histograms. */

import { Histogram, type HistogramSnapshot } from "./histogram.ts";

export const ROUTES = [
  "POST /api/join",
  "POST /api/next",
  "POST /api/next probe",
  "POST /api/beat",
  "POST /api/note",
  "POST /api/submit",
  "POST /api/release",
  "POST /api/release probe",
  "GET /api/submission",
  "GET /api/view",
  "GET /api/metrics",
] as const;

export type RouteName = (typeof ROUTES)[number];

export interface ErrorSample {
  status: number;
  /** Raw error body (bounded by the client at 500 chars). */
  body: string;
}

export interface RouteSnapshot extends HistogramSnapshot {
  /** Requests whose response status was not 2xx (keyed by status; "network" for fetch failures). */
  errors: Record<string, number>;
  errors5xx: number;
  errors409: number;
  errors410: number;
  /** First five error bodies seen on this route, for debugging harness protocol misuse. */
  errorSamples: ErrorSample[];
}

interface Accumulator {
  histogram: Histogram;
  count: number;
  errors: Map<string, number>;
  errors5xx: number;
  errors409: number;
  errors410: number;
  errorSamples: ErrorSample[];
}

function empty(): Accumulator {
  return {
    histogram: new Histogram(), count: 0, errors: new Map(),
    errors5xx: 0, errors409: 0, errors410: 0, errorSamples: [],
  };
}

export class RouteStats {
  private readonly routes = new Map<string, Accumulator>();

  private route(name: string): Accumulator {
    let entry = this.routes.get(name);
    if (!entry) {
      entry = empty();
      this.routes.set(name, entry);
    }
    return entry;
  }

  /** Record one completed request. Status 0 denotes a transport error. */
  record(name: string, status: number, latencyMs: number, errorBody?: string): void {
    const entry = this.route(name);
    entry.count++;
    entry.histogram.record(latencyMs);
    if (status < 200 || status >= 300) {
      const key = status === 0 ? "network" : String(status);
      entry.errors.set(key, (entry.errors.get(key) ?? 0) + 1);
      if (status >= 500) entry.errors5xx++;
      if (status === 409) entry.errors409++;
      if (status === 410) entry.errors410++;
      if (entry.errorSamples.length < 5) {
        entry.errorSamples.push({ status, body: errorBody ?? "" });
      }
    }
  }

  count(name: string): number {
    return this.routes.get(name)?.count ?? 0;
  }

  total5xx(): number {
    let total = 0;
    for (const entry of this.routes.values()) total += entry.errors5xx;
    return total;
  }

  totalConflicts(): { errors409: number; errors410: number } {
    let errors409 = 0;
    let errors410 = 0;
    for (const entry of this.routes.values()) {
      errors409 += entry.errors409;
      errors410 += entry.errors410;
    }
    return { errors409, errors410 };
  }

  private snapshotEntry(entry: Accumulator): RouteSnapshot {
    return {
      ...entry.histogram.snapshot(),
      count: entry.count,
      errors: Object.fromEntries(entry.errors),
      errors5xx: entry.errors5xx,
      errors409: entry.errors409,
      errors410: entry.errors410,
      errorSamples: [...entry.errorSamples],
    };
  }

  snapshot(): Record<string, RouteSnapshot> {
    const out: Record<string, RouteSnapshot> = {};
    for (const name of ROUTES) {
      out[name] = this.snapshotEntry(this.route(name));
    }
    // Include any ad-hoc route name not in the standard list.
    for (const [name, entry] of this.routes) {
      if (name in out) continue;
      out[name] = this.snapshotEntry(entry);
    }
    return out;
  }
}
