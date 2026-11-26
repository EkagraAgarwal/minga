/** Compact stdout table and full JSON result file. */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Options } from "./args.ts";
import type { HarnessResult } from "./harness.ts";
import { ROUTES, type RouteSnapshot } from "./stats.ts";

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function verdict(pass: boolean): string {
  return pass ? "PASS" : "FAIL";
}

function percentileLine(label: string, h: { p50: number; p95: number; p99: number; count: number }): string {
  return `  ${pad(label, 20)} n=${pad(String(h.count), 7)} p50=${pad(h.p50.toFixed(1), 8)} p95=${pad(h.p95.toFixed(1), 8)} p99=${pad(h.p99.toFixed(1), 8)}`;
}

/** Human-readable summary for stdout. */
export function renderReport(result: HarnessResult, opts: Options, baseUrl: string): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`Minga swarm load test: ${opts.agents} agents / ${opts.duration}s / ${opts.cores} cores / ${baseUrl}`);
  lines.push("");
  lines.push(pad("route", 24) + pad("count", 9) + pad("p50", 9) + pad("p95", 9) + pad("p99", 9) + pad("max", 10) + "errors");
  lines.push("-".repeat(88));
  for (const name of ROUTES) {
    const entry = result.routes[name];
    if (!entry || entry.count === 0) continue;
    const errors = Object.entries(entry.errors).map(([status, count]) => `${status}:${count}`).join(" ") || "-";
    lines.push(
      pad(name, 24) +
      pad(String(entry.count), 9) +
      pad(entry.p50.toFixed(1), 9) +
      pad(entry.p95.toFixed(1), 9) +
      pad(entry.p99.toFixed(1), 9) +
      pad(entry.max.toFixed(1), 10) +
      errors,
    );
  }
  lines.push("");
  const totals = result.totals;
  lines.push(
    `agents joined=${totals.joins} (errors ${totals.joinErrors}) · assignments=${totals.assignments} · ` +
    `submissions=${totals.submissions} (accepted ${totals.accepted}, rejected ${totals.rejected}, ` +
    `resubmits ${totals.resubmits}) · releases=${totals.releases} · beats=${totals.beats} · notes=${totals.notes} · polls=${totals.polls}`,
  );
  lines.push(
    `SSE viewers: ${result.sse.connections}/20 connected, ${result.sse.events} events, ` +
    `${result.sse.errors} errors, max lag ${result.sse.maxLagMs} ms`,
  );
  lines.push(
    `server peak: CPU ${result.peakCpuPct.toFixed(1)}% of ${opts.cores} cores · ` +
    `RSS ${mb(result.peakRssBytes)} · ${result.samples.length} metric samples`,
  );

  lines.push("");
  lines.push("CHECK PIPELINE (from SubmissionView fields, informational)");
  const p = result.pipeline;
  lines.push(percentileLine("queue wait", p.queueWait));
  lines.push(percentileLine("check time", p.check));
  lines.push(percentileLine("submit->verdict", p.verdict));

  lines.push("");
  lines.push("TARGETS");
  const t = result.targets;
  lines.push(`  p99 next(probe)/beat/note/submit/release < 250 ms : ${pad(t.p99Ms.toFixed(1) + " ms", 12)} ${verdict(t.p99Pass)}`);
  lines.push(`  5xx responses == 0                      : ${pad(String(t.errors5xx), 12)} ${verdict(t.errors5xxPass)}`);
  lines.push(`  409/410 responses == 0 (409=${t.errors409}, 410=${t.errors410}) : ${pad(String(t.errors409 + t.errors410), 12)} ${verdict(t.conflictPass)}`);
  lines.push(`  server CPU < 85% of ${opts.cores} cores            : ${pad(t.peakCpuPct.toFixed(1) + "%", 12)} ${verdict(t.cpuPass)}`);
  lines.push(`  RSS < 1.5 GB                            : ${pad(mb(t.peakRssBytes), 12)} ${verdict(t.rssPass)}`);
  for (const note of t.notes) lines.push(`  note: ${note}`);

  const withErrors: { name: string; entry: NonNullable<RouteSnapshot> }[] = [];
  for (const name of ROUTES) {
    const entry = result.routes[name];
    if (entry && entry.errorSamples.length > 0) withErrors.push({ name, entry });
  }
  if (withErrors.length) {
    lines.push("");
    lines.push("ERROR BODIES (first 5 per route)");
    for (const { name, entry } of withErrors) {
      lines.push(`  ${name}:`);
      for (const sample of entry.errorSamples) {
        lines.push(`    [${sample.status}] ${sample.body || "(empty body)"}`);
      }
    }
  }

  lines.push("");
  lines.push(`OVERALL: ${verdict(t.overall)}`);
  return lines.join("\n");
}

/** Write the full result as JSON; return the path. Filename uses a filesystem-safe ISO timestamp. */
export async function writeResult(result: HarnessResult, opts: Options, baseUrl: string, runId?: string): Promise<string> {
  const dir = join(import.meta.dir, "..", "results");
  mkdirSync(dir, { recursive: true });
  const stamp = runId ?? new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(dir, `${stamp}-${opts.agents}a.json`);
  const payload = {
    schema: 2,
    config: { ...opts, url: baseUrl },
    ...result,
  };
  await Bun.write(file, JSON.stringify(payload, null, 2));
  return file;
}
