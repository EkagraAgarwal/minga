import { describe, expect, test } from "bun:test";
import { createCoordinationTracker } from "../src/log/coordination.ts";
import type { Actor, MingaEvent } from "../src/core/types.ts";

const BASE = Date.parse("2026-01-01T00:00:00.000Z");
const at = (seconds: number): string => new Date(BASE + seconds * 1000).toISOString();

function logger() {
  let seq = 0;
  return <T extends MingaEvent["type"]>(
    seconds: number,
    type: T,
    data: Extract<MingaEvent, { type: T }>["data"],
    actor: Actor = "server",
  ): MingaEvent => {
    seq += 1;
    return { seq, at: at(seconds), type, actor, data } as MingaEvent;
  };
}

function replay(events: MingaEvent[]) {
  const tracker = createCoordinationTracker();
  for (const event of events) tracker.apply(event);
  return tracker.snapshot();
}

function sampleLog(): MingaEvent[] {
  const log = logger();
  const events: MingaEvent[] = [
    log(0, "task.posted", { task: "T-1", title: "one", body: "b", parent: null, points: 1, by: "config" }),
    log(0, "task.posted", { task: "T-2", title: "two", body: "b", parent: null, points: 1, by: "config" }),
    log(0, "task.posted", { task: "T-3", title: "three", body: "b", parent: null, points: 1, by: "config" }),
  ];
  for (let i = 1; i <= 12; i += 1) {
    events.push(log(0, "attempt.started", {
      attempt: `A-${i}`, task: i <= 10 ? "T-1" : "T-2", agent: `a${i}`, role: "build",
      approach: "", model: "m", leaseUntil: at(100),
    }));
  }
  // A question answered twice, a hand-off on the task that will be solved,
  // a dead-end and a digest on an open task, and a second unanswered hand-off.
  events.push(
    log(0, "note.added", { note: "N-1", task: "T-1", agent: "a1", kind: "question", text: "q" }),
    log(0, "note.added", { note: "N-5", task: "T-1", agent: "a1", kind: "handoff", text: "h" }),
    log(0, "note.added", { note: "N-2", task: "T-1", agent: "a2", kind: "idea", text: "r1", replyTo: "N-1" }),
    log(0, "note.added", { note: "N-3", task: "T-1", agent: "a3", kind: "result", text: "r2", replyTo: "N-1" }),
    log(0, "note.added", { note: "N-4", task: "T-1", agent: "a1", kind: "question", text: "q2" }),
    log(0, "note.added", { note: "N-6", task: "T-2", agent: "a11", kind: "dead_end", text: "d" }),
    log(0, "note.added", { note: "N-7", task: "T-3", agent: "a12", kind: "digest", text: "g" }),
    log(0, "note.added", { note: "N-8", task: "T-3", agent: "a12", kind: "idea", text: "i" }),
    log(0, "note.added", { note: "N-9", task: "T-3", agent: "a12", kind: "handoff", text: "h2" }),
    log(1, "task.closed", { task: "T-1", status: "solved" }),
    log(1, "task.closed", { task: "T-2", status: "refuted" }),
  );
  for (let i = 1; i <= 10; i += 1) {
    events.push(log(1, "attempt.ended", { attempt: `A-${i}`, reason: "task_closed" }));
  }
  events.push(
    log(1, "attempt.ended", { attempt: "A-11", reason: "released", why: "dead_end" }),
    log(1, "attempt.ended", { attempt: "A-12", reason: "expired" }),
  );
  for (let i = 1; i <= 10; i += 1) {
    events.push(log(1 + i, "attempt.notified", { attempt: `A-${i}`, agent: `a${i}`, via: "test" }));
  }
  events.push(
    log(2, "proposal.voted", { proposal: "P-1", agent: "a1", approve: true, duplicate: true }),
    log(2, "proposal.voted", { proposal: "P-1", agent: "a2", approve: true, duplicate: true }),
    log(2, "proposal.voted", { proposal: "P-1", agent: "a3", approve: true, duplicate: false }),
    { seq: 99, at: at(0), type: "mystery.event", actor: "server", data: {} } as unknown as MingaEvent,
  );
  return events;
}

describe("createCoordinationTracker", () => {
  test("a fresh tracker has zeroed stats", () => {
    expect(createCoordinationTracker().snapshot()).toEqual({
      closes: 0,
      closedUnder: 0,
      closedUnderShare: 0,
      notifyLagSeconds: { count: 0, p50: 0, p90: 0, max: 0 },
      notesPerClosedTask: 0,
      questions: { asked: 0, answered: 0, open: 0 },
      handoffs: 0,
      handoffsFollowedBySolve: 0,
      deadEnds: 0,
      digests: 0,
      duplicateProposals: 0,
    });
  });

  test("folds every coordination stat from a replayed log", () => {
    const events = sampleLog();
    const tracker = createCoordinationTracker();
    for (const event of events) tracker.apply(event);

    expect(tracker.snapshot()).toEqual({
      closes: 2,
      closedUnder: 10,
      closedUnderShare: 10 / 12,
      notifyLagSeconds: { count: 10, p50: 5, p90: 9, max: 10 },
      notesPerClosedTask: 3,
      questions: { asked: 2, answered: 1, open: 1 },
      handoffs: 2,
      handoffsFollowedBySolve: 1,
      deadEnds: 2,
      digests: 1,
      duplicateProposals: 2,
    });
    // snapshot() is a cheap, non-mutating copy.
    expect(tracker.snapshot()).toEqual(tracker.snapshot());
    expect(tracker.snapshot()).not.toBe(tracker.snapshot());
  });

  test("the fold is deterministic: two replays of the same log agree", () => {
    const events = sampleLog();
    expect(replay(events)).toEqual(replay(events));
  });

  test("notifications with no known task.closed are ignored", () => {
    const log = logger();
    const tracker = createCoordinationTracker();
    tracker.apply(log(0, "attempt.notified", { attempt: "A-99", agent: "a", via: "test" }));
    tracker.apply(log(0, "task.closed", { task: "T-1", status: "solved" }));
    tracker.apply(log(1, "attempt.notified", { attempt: "A-99", agent: "a", via: "test" }));
    expect(tracker.snapshot().notifyLagSeconds).toEqual({ count: 0, p50: 0, p90: 0, max: 0 });
  });

  test("keeps notification sampling bounded and max exact over a long log", () => {
    const log = logger();
    const tracker = createCoordinationTracker();
    for (let i = 1; i <= 5000; i += 1) {
      tracker.apply(log(i, "attempt.started", {
        attempt: `B-${i}`, task: `T-${i}`, agent: "a", role: "build", approach: "", model: "m", leaseUntil: at(10_000),
      }));
      tracker.apply(log(i + 1, "task.closed", { task: `T-${i}`, status: "solved" }));
      tracker.apply(log(i + 1 + i, "attempt.notified", { attempt: `B-${i}`, agent: "a", via: "test" }));
    }
    const lag = tracker.snapshot().notifyLagSeconds;
    expect(lag.count).toBe(5000);
    expect(lag.max).toBe(5000);
    expect(lag.p50).toBeGreaterThan(0);
    expect(lag.p50).toBeLessThan(lag.max);
    expect(lag.p90).toBeGreaterThan(lag.p50);
    expect(lag.p90).toBeLessThanOrEqual(lag.max);
  });

  test("folds 50,000 events in under 500 ms", () => {
    const log = logger();
    const events: MingaEvent[] = [];
    for (let i = 0; i < 12_500; i += 1) {
      const t = i * 4;
      events.push(log(t, "attempt.started", {
        attempt: `A-${i}`, task: `T-${i}`, agent: `a${i}`, role: "build", approach: "", model: "m", leaseUntil: at(1000),
      }));
      events.push(log(t + 1, "task.closed", { task: `T-${i}`, status: "solved" }));
      events.push(log(t + 2, "attempt.ended", { attempt: `A-${i}`, reason: "task_closed" }));
      events.push(log(t + 3, "attempt.notified", { attempt: `A-${i}`, agent: `a${i}`, via: "test" }));
    }
    expect(events).toHaveLength(50_000);

    const tracker = createCoordinationTracker();
    const startedAt = performance.now();
    for (const event of events) tracker.apply(event);
    const elapsed = performance.now() - startedAt;

    expect(elapsed).toBeLessThan(500);
    expect(tracker.snapshot().notifyLagSeconds).toEqual({ count: 12_500, p50: 2, p90: 2, max: 2 });
  });
});
