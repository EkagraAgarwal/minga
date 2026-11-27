import { describe, expect, test } from "bun:test";
import type { MingaEvent, NewEvent, Rules } from "../src/core/types.ts";
import { replay } from "../src/log/reducer.ts";
import { leadAreaFor } from "../src/server/leads.ts";

const RULES: Rules = {
  width: 2, leaseMinutes: 10, maxAttemptsPerAgent: 2,
  roles: { explore: 1, build: 1, attack: 0, distill: 0, plan: 0 },
  accept: { mode: "head" }, defaultPoints: 3,
};
const T0 = "2026-01-01T00:00:00.000Z";
function logger() {
  let seq = 0;
  return (event: NewEvent): MingaEvent => ({ ...event, seq: ++seq, at: T0 }) as MingaEvent;
}
const post = (task: string, parent: string | null = null): NewEvent => ({
  type: "task.posted", actor: "server",
  data: { task, title: task, body: "", parent, points: 1, by: "config" },
});
const grant = (agent: string, area: string): NewEvent => ({
  type: "lead.granted", actor: "head", data: { agent, area },
});
const revoke = (agent: string, area: string): NewEvent => ({
  type: "lead.revoked", actor: "head", data: { agent, area },
});

describe("leadAreaFor", () => {
  test("walks from the task through its parents and returns the nearest led area", () => {
    const ev = logger();
    const state = replay(RULES, [
      ev(post("T-1")), ev(post("T-2", "T-1")), ev(post("T-3", "T-2")), ev(post("T-4")),
      ev(grant("a1", "T-1")), ev(grant("a1", "T-2")), ev(grant("a2", "T-4")),
    ]);
    expect(leadAreaFor(state, "a1", "T-3")).toBe("T-2"); // nearest led ancestor wins
    expect(leadAreaFor(state, "a1", "T-2")).toBe("T-2"); // the task itself counts
    expect(leadAreaFor(state, "a1", "T-1")).toBe("T-1");
    expect(leadAreaFor(state, "a2", "T-4")).toBe("T-4");
    expect(leadAreaFor(state, "a1", "T-4")).toBeNull(); // another agent's area
    expect(leadAreaFor(state, "nobody", "T-3")).toBeNull();
    expect(leadAreaFor(state, "a1", null)).toBeNull(); // root is never led
  });

  test("a revocation removes the area; an unknown area is harmless", () => {
    const ev = logger();
    const state = replay(RULES, [
      ev(post("T-1")), ev(post("T-2", "T-1")),
      ev(grant("a1", "T-1")),
      ev(revoke("a1", "T-1")),
      ev(grant("a1", "T-99")),
    ]);
    expect(leadAreaFor(state, "a1", "T-2")).toBeNull();
    expect(state.index.leadAreas?.["a1"]).toEqual(["T-99"]);
  });
});
