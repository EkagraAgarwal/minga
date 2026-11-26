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
  "GET /api/submission",
  "GET /api/view",
  "GET /api/metrics",
] as const;

export type RouteName = (typeof ROUTES)[number];

export interface RouteSnapshot extends HistogramSnapshot {
  /** Requests whose response status was not 2xx (keyed by status; "network" for fetch failures). */
  errors: Record<string, number>;
  errors5xx: number;
}

interface Accumulator {
  histogram: Histogram;
  count: number;
  errors: Map<string, number>;
  errors5xx: number;
}

function empty(): Accumulator {
  return { histogram: new Histogram(), count: 0, errors: new Map(), errors5xx: 0 };
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
  record(name: string, status: number, latencyMs: number): void {
    const entry = this.route(name);
    entry.count++;
    entry.histogram.record(latencyMs);
    if (status < 200 || status >= 300) {
      const key = status === 0 ? "network" : String(status);
      entry.errors.set(key, (entry.errors.get(key) ?? 0) + 1);
      if (status >= 500) entry.errors5xx++;
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

  snapshot(): Record<string, RouteSnapshot> {
    const out: Record<string, RouteSnapshot> = {};
    for (const name of ROUTES) {
      const entry = this.route(name);
      out[name] = {
        ...entry.histogram.snapshot(),
        count: entry.count,
        errors: Object.fromEntries(entry.errors),
        errors5xx: entry.errors5xx,
      };
    }
    // Include any ad-hoc route name not in the standard list.
    for (const [name, entry] of this.routes) {
      if (name in out) continue;
      out[name] = {
        ...entry.histogram.snapshot(),
        count: entry.count,
        errors: Object.fromEntries(entry.errors),
        errors5xx: entry.errors5xx,
      };
    }
    return out;
  }
}
