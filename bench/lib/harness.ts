/**
 * The swarm itself: simulated agents, wait=0 latency probes, metrics sampling,
 * SSE viewers and a periodic status line. Everything talks to the public v2
 * protocol only (no src/server imports).
 */

import type {
  JoinResponse,
  MetricsResponse,
  NextResponse,
  SubmissionView,
  SubmitResponse,
} from "../../src/core/protocol.ts";
import { generateKeyPair, type KeyPair } from "../../src/identity/keys.ts";
import type { Options } from "./args.ts";
import { apiRequest, sleep } from "./client.ts";
import { PipelineStats, submissionTimings, type PipelineSnapshot } from "./pipeline.ts";
import { RouteStats, type RouteSnapshot } from "./stats.ts";

interface ModelMix {
  model: string;
  harness: string;
  weight: number;
}

const MODEL_MIX: readonly ModelMix[] = [
  { model: "claude-opus-5.5", harness: "claude-code", weight: 28 },
  { model: "gpt-6", harness: "codex", weight: 22 },
  { model: "deepseek-v4.1-flash", harness: "opencode", weight: 16 },
  { model: "hy4-flash", harness: "hermes", weight: 14 },
  { model: "kimi-k3", harness: "pi", weight: 12 },
  { model: "glm-5.3", harness: "antigravity", weight: 8 },
];
const WEIGHT_TOTAL = MODEL_MIX.reduce((sum, entry) => sum + entry.weight, 0);

/** A rejected attempt stays live; bound how often we resubmit on the same attempt. */
const MAX_RESUBMITS = 2;

function pickModel(): ModelMix {
  let roll = Math.random() * WEIGHT_TOTAL;
  for (const entry of MODEL_MIX) {
    roll -= entry.weight;
    if (roll < 0) return entry;
  }
  return MODEL_MIX[MODEL_MIX.length - 1]!;
}

/**
 * Give an attempt back before another next() call. A failed release must never
 * be followed by next() on the same agent: the server keeps the attempt live
 * and answers 409. Returns true only when the attempt is no longer held.
 */
async function releaseAttempt(
  baseUrl: string,
  keys: KeyPair,
  attempt: string,
  handoff: string,
  stats: RouteStats,
  routeName: string,
  leaseUntil?: string,
): Promise<boolean> {
  // An expired lease is no longer a held attempt; the server's sweep will end it.
  if (leaseUntil && Date.parse(leaseUntil) <= Date.now()) return true;
  for (let tryNo = 0; tryNo < 3; tryNo++) {
    const release = await apiRequest(baseUrl, keys, "POST", "/api/release", { attempt, handoff }, 8_000);
    stats.record(routeName, release.status, release.latencyMs, release.errorBody);
    if (release.ok) return true;
    // 410 means the attempt already ended (expired or closed), so it is not held.
    if (release.status === 410) return true;
    // 409 means a submission is still queued: calling next would also be a 409.
    if (release.status === 409) return false;
    await sleep(300);
  }
  return false;
}

export interface MetricsSample {
  tMs: number;
  uptimeSeconds: number;
  cpuSeconds: number;
  cpuPct: number;
  rssBytes: number;
  heapUsedBytes: number;
  queue: { queued: number; checking: number; concurrency: number };
  waiting: number;
  seq: number;
  agents: number;
  liveAttempts: number;
  streams: number;
}

export interface SseStats {
  connections: number;
  events: number;
  errors: number;
  maxLagMs: number;
}

export interface SwarmTotals {
  joins: number;
  joinErrors: number;
  assignments: number;
  noWork: number;
  beats: number;
  notes: number;
  submissions: number;
  accepted: number;
  rejected: number;
  releases: number;
  polls: number;
  resubmits: number;
}

export interface Targets {
  /** Worst p99 across next(probe), beat, note, submit and release. */
  p99Ms: number;
  p99Pass: boolean;
  errors5xx: number;
  errors5xxPass: boolean;
  /** A 409/410 after the harness fixes means protocol misuse; both must be zero. */
  errors409: number;
  errors410: number;
  conflictPass: boolean;
  peakCpuPct: number;
  cpuPass: boolean;
  peakRssBytes: number;
  rssPass: boolean;
  overall: boolean;
  notes: string[];
}

export interface HarnessResult {
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  routes: Record<string, RouteSnapshot>;
  /** Check-pipeline numbers from SubmissionView fields, separate from HTTP latency. */
  pipeline: PipelineSnapshot;
  samples: MetricsSample[];
  peakCpuPct: number;
  peakRssBytes: number;
  sse: SseStats;
  totals: SwarmTotals;
  targets: Targets;
}

function emptyTotals(): SwarmTotals {
  return {
    joins: 0, joinErrors: 0, assignments: 0, noWork: 0, beats: 0, notes: 0,
    submissions: 0, accepted: 0, rejected: 0, releases: 0, polls: 0, resubmits: 0,
  };
}

/** Run the full swarm against an already-running server. Does not throw on API errors. */
export async function runSwarm(opts: Options, baseUrl: string): Promise<HarnessResult> {
  const startedAt = Date.now();
  const deadline = startedAt + opts.duration * 1000;
  const stats = new RouteStats();
  const pipeline = new PipelineStats();
  const totals = emptyTotals();
  const samples: MetricsSample[] = [];
  const sse: SseStats = { connections: 0, events: 0, errors: 0, maxLagMs: 0 };
  let stop = false;

  const statusTimer = setInterval(() => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const probe = stats.snapshot()["POST /api/next probe"];
    const conflicts = stats.totalConflicts();
    console.log(
      `[${String(elapsed).padStart(3)}s] joins=${totals.joins} assigned=${totals.assignments} ` +
      `submitted=${totals.submissions} accepted=${totals.accepted} rejected=${totals.rejected} ` +
      `nextProbe p99=${probe?.p99.toFixed(1) ?? "0.0"}ms 5xx=${stats.total5xx()} ` +
      `409=${conflicts.errors409} 410=${conflicts.errors410}`,
    );
  }, 10_000);

  // ---------------------------------------------------------- SSE viewers (20)
  const viewers: AbortController[] = [];
  const viewerTasks: Promise<void>[] = [];
  for (let i = 0; i < 20; i++) {
    const controller = new AbortController();
    viewers.push(controller);
    viewerTasks.push((async () => {
      try {
        const res = await fetch(`${baseUrl}/api/stream`, {
          headers: { accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          sse.errors++;
          return;
        }
        sse.connections++;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const separator = /\r?\n\r?\n/;
          let match: RegExpExecArray | null;
          while ((match = separator.exec(buffer)) !== null) {
            const frame = buffer.slice(0, match.index);
            buffer = buffer.slice(match.index + match[0].length);
            const line = frame.split(/\r?\n/).find((part) => part.startsWith("data:"));
            if (!line) continue; // : ping or id/event-only frame
            try {
              const event = JSON.parse(line.slice(5).trim()) as { at?: unknown };
              sse.events++;
              if (typeof event.at === "string") {
                const lag = Date.now() - Date.parse(event.at);
                if (Number.isFinite(lag) && lag > sse.maxLagMs) sse.maxLagMs = lag;
              }
            } catch {
              // ignore malformed frame
            }
          }
        }
      } catch {
        if (!controller.signal.aborted) sse.errors++;
      }
    })());
  }

  // ------------------------------------------------- metrics + view sampler (5s)
  const sampleTask = (async () => {
    let previousCpu = 0;
    let previousAt = performance.now();
    let first = true;
    while (!stop) {
      const metrics = await apiRequest<MetricsResponse>(baseUrl, undefined, "GET", "/api/metrics", undefined, 5000);
      stats.record("GET /api/metrics", metrics.status, metrics.latencyMs, metrics.errorBody);
      if (metrics.body) {
        const at = performance.now();
        const deltaSeconds = (at - previousAt) / 1000;
        const cpuPct = first || deltaSeconds <= 0
          ? 0
          : Math.max(0, ((metrics.body.cpuSeconds - previousCpu) / deltaSeconds / opts.cores) * 100);
        first = false;
        previousCpu = metrics.body.cpuSeconds;
        previousAt = at;
        samples.push({
          tMs: Date.now() - startedAt,
          uptimeSeconds: metrics.body.uptimeSeconds,
          cpuSeconds: metrics.body.cpuSeconds,
          cpuPct,
          rssBytes: metrics.body.rssBytes,
          heapUsedBytes: metrics.body.heapUsedBytes,
          queue: metrics.body.queue,
          waiting: metrics.body.waiting,
          seq: metrics.body.seq,
          agents: metrics.body.agents,
          liveAttempts: metrics.body.liveAttempts,
          streams: metrics.body.streams,
        });
      }
      const view = await apiRequest<unknown>(baseUrl, undefined, "GET", "/api/view", undefined, 10_000);
      stats.record("GET /api/view", view.status, view.latencyMs, view.errorBody);
      await sleep(5000);
    }
  })();

  // --------------------------------------------------- 5-agent wait=0 probe group
  const probeTasks: Promise<void>[] = [];
  for (let i = 0; i < 5; i++) {
    probeTasks.push((async () => {
      const keys = generateKeyPair();
      const { model } = pickModel();
      const join = await apiRequest<JoinResponse>(baseUrl, keys, "POST", "/api/join", {
        publicKey: keys.publicKey, model, harness: "swarm-probe",
      }, 10_000);
      stats.record("POST /api/join", join.status, join.latencyMs, join.errorBody);
      if (!join.ok) return;
      while (!stop && Date.now() < deadline) {
        const tickStart = Date.now();
        const result = await apiRequest<NextResponse>(baseUrl, keys, "POST", "/api/next", { wait: 0, model }, 15_000);
        // Only the next() latency is measured for the target; the release is a separate route.
        stats.record("POST /api/next probe", result.status, result.latencyMs, result.errorBody);
        const assignment = result.ok ? result.body?.assignment : undefined;
        if (assignment) {
          // Probe agents keep no state: give the slot straight back before calling next again.
          const released = await releaseAttempt(
            baseUrl, keys, assignment.attempt, "latency probe", stats, "POST /api/release probe",
            assignment.leaseUntil,
          );
          if (!released) return; // never call next while an assignment may still be held
        }
        await sleep(Math.max(0, 1000 - (Date.now() - tickStart)));
      }
    })());
  }

  // ------------------------------------------------------------ simulated agents
  const agentTasks: Promise<void>[] = [];
  for (let i = 0; i < opts.agents; i++) {
    agentTasks.push((async () => {
      const joinAt = startedAt + (i / opts.ramp) * 1000;
      await sleep(joinAt - Date.now());
      if (stop) return;
      // Generate keys at join time so a 3000-agent ramp does not block startup.
      const keys = generateKeyPair();

      const { model, harness } = pickModel();
      const joined = await apiRequest<JoinResponse>(baseUrl, keys, "POST", "/api/join", {
        publicKey: keys.publicKey, model, harness,
      }, 15_000);
      stats.record("POST /api/join", joined.status, joined.latencyMs, joined.errorBody);
      if (!joined.ok) {
        totals.joinErrors++;
        return;
      }
      totals.joins++;

      while (!stop && Date.now() < deadline) {
        const next = await apiRequest<NextResponse>(baseUrl, keys, "POST", "/api/next", { wait: 30, model }, 40_000);
        stats.record("POST /api/next", next.status, next.latencyMs, next.errorBody);
        const assignment = next.ok ? next.body?.assignment : undefined;
        if (!assignment) {
          totals.noWork++;
          const retrySeconds = next.body?.retryAfterSeconds ?? 1;
          await sleep(Math.min(5000, Math.max(100, retrySeconds * 1000)));
          continue;
        }
        totals.assignments++;

        const thinkMs = (opts.thinkMin + Math.random() * (opts.thinkMax - opts.thinkMin)) * 1000;
        await sleep(Math.min(thinkMs, Math.max(0, deadline - Date.now())));
        if (stop || Date.now() >= deadline) break;

        // A long think needs a lease heartbeat.
        if (thinkMs > 8000) {
          const beat = await apiRequest(baseUrl, keys, "POST", "/api/beat", { attempt: assignment.attempt, model }, 15_000);
          stats.record("POST /api/beat", beat.status, beat.latencyMs, beat.errorBody);
          if (beat.ok) totals.beats++;
        }

        if (Math.random() < 0.2) {
          const note = await apiRequest(baseUrl, keys, "POST", "/api/note", {
            task: assignment.task.id,
            kind: "idea",
            text: `swarm agent exploring ${assignment.task.id} as ${assignment.role}`,
          }, 15_000);
          stats.record("POST /api/note", note.status, note.latencyMs, note.errorBody);
          if (note.ok) totals.notes++;
        }

        // Work this attempt until accepted, or hand it back. Every path that
        // calls next() again first makes sure the attempt is no longer held.
        let resubmits = 0;
        while (!stop && Date.now() < deadline) {
          const passes = Math.random() < opts.pass;
          const content = passes
            ? "load test artefact\nok\nsubmitted by simulated agent\n"
            : "load test artefact\nstill working\nsubmitted by simulated agent\n";
          const submitted = await apiRequest<SubmitResponse>(baseUrl, keys, "POST", "/api/submit", {
            attempt: assignment.attempt,
            claim: "progress",
            message: `swarm: ${assignment.task.id}`,
            files: { [`work/${assignment.task.id}.txt`]: content },
            model,
          }, 15_000);
          stats.record("POST /api/submit", submitted.status, submitted.latencyMs, submitted.errorBody);
          if (!submitted.ok || !submitted.body?.submission) {
            // Nothing was queued, so the attempt is safe to release.
            const released = await releaseAttempt(
              baseUrl, keys, assignment.attempt, "submission failed to queue", stats, "POST /api/release",
              assignment.leaseUntil,
            );
            totals.releases++;
            if (!released) return; // do not call next with a live attempt
            break;
          }
          totals.submissions++;

          // A timed-out poll just polls again. Never release while the
          // submission is queued or checking: the server rejects that with 409.
          let final: SubmissionView | undefined;
          while (!final && !stop && Date.now() < deadline) {
            const result = await apiRequest<SubmissionView>(
              baseUrl, undefined, "GET", `/api/submission/${encodeURIComponent(submitted.body.submission)}?wait=30`, undefined, 40_000,
            );
            stats.record("GET /api/submission", result.status, result.latencyMs, result.errorBody);
            totals.polls++;
            if (!result.ok || !result.body) {
              await sleep(1000);
              continue;
            }
            if (result.body.status === "accepted" || result.body.status === "rejected") {
              final = result.body;
            }
          }
          if (!final) break; // deadline or stop; leave the attempt to expire rather than release a queued submission

          pipeline.record(submissionTimings(final));
          if (final.status === "accepted") {
            totals.accepted++;
            break; // the server ended the attempt on acceptance
          }
          totals.rejected++;

          if (resubmits < MAX_RESUBMITS && Math.random() < 0.5) {
            // Resubmit on the SAME attempt: it stays live after a rejection.
            resubmits++;
            totals.resubmits++;
            continue;
          }
          // Give up on this attempt, with a handoff, before the next next() call.
          const released = await releaseAttempt(
            baseUrl, keys, assignment.attempt,
            `check ${final.status}: trying a different approach`, stats, "POST /api/release",
            assignment.leaseUntil,
          );
          totals.releases++;
          if (!released) return; // do not call next with a live attempt
          break;
        }
      }
    })());
  }

  await Promise.allSettled(agentTasks);
  stop = true;
  clearInterval(statusTimer);
  for (const controller of viewers) controller.abort();
  await Promise.allSettled([sampleTask, ...probeTasks, ...viewerTasks]);

  const routes = stats.snapshot();
  const targetNames = ["POST /api/next probe", "POST /api/beat", "POST /api/note", "POST /api/submit", "POST /api/release"];
  const p99Ms = Math.max(...targetNames.map((name) => routes[name]?.p99 ?? 0));
  const errors5xx = stats.total5xx();
  const { errors409, errors410 } = stats.totalConflicts();
  const peakCpuPct = samples.reduce((peak, sample) => Math.max(peak, sample.cpuPct), 0);
  const peakRssBytes = samples.reduce((peak, sample) => Math.max(peak, sample.rssBytes), 0);
  const notes: string[] = [];
  if ((routes["POST /api/next probe"]?.count ?? 0) === 0) notes.push("no wait=0 probe samples: p99 target is unproven");
  if (samples.length === 0) notes.push("no /api/metrics samples: CPU and RSS targets are unproven");
  if (sse.connections === 0) notes.push("no SSE connections established");
  if (pipeline.count === 0) notes.push("no final submissions: check-pipeline numbers are unproven");
  notes.push("submit-to-verdict latency is informational; it depends on the project's check");

  const targets: Targets = {
    p99Ms,
    p99Pass: (routes["POST /api/next probe"]?.count ?? 0) > 0 && p99Ms < 250,
    errors5xx,
    errors5xxPass: errors5xx === 0,
    errors409,
    errors410,
    conflictPass: errors409 === 0 && errors410 === 0,
    peakCpuPct,
    cpuPass: samples.length > 0 && peakCpuPct < 85,
    peakRssBytes,
    rssPass: samples.length > 0 && peakRssBytes < 1.5 * 1024 * 1024 * 1024,
    overall: true,
    notes,
  };
  targets.overall = targets.p99Pass && targets.errors5xxPass && targets.conflictPass && targets.cpuPass && targets.rssPass;

  return {
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date().toISOString(),
    durationSeconds: (Date.now() - startedAt) / 1000,
    routes,
    pipeline: pipeline.snapshot(),
    samples,
    peakCpuPct,
    peakRssBytes,
    sse,
    totals,
    targets,
  };
}
