import { describe, expect, test } from "bun:test";
import type { MingaEvent, NewEvent, Rules } from "../src/core/types.ts";
import { replay } from "../src/log/reducer.ts";
import { findDuplicate, normalizeTitle } from "../src/server/dedupe.ts";

const RULES: Rules = {
  width: 2, leaseMinutes: 10, maxAttemptsPerAgent: 2,
  roles: { explore: 1, build: 1, attack: 0, distill: 0, plan: 0 },
  accept: { mode: "head-or-votes", votes: 1 }, defaultPoints: 3,
};
const T0 = "2026-01-01T00:00:00.000Z";
function logger() {
  let seq = 0;
  return (event: NewEvent): MingaEvent => ({ ...event, seq: ++seq, at: T0 }) as MingaEvent;
}
const post = (task: string, parent: string | null, title: string): NewEvent => ({
  type: "task.posted", actor: "server",
  data: { task, title, body: "", parent, points: 1, by: "config" },
});
const propose = (id: string, parent: string | null, title: string, agent = "a1"): NewEvent => ({
  type: "proposal.made", actor: agent,
  data: { proposal: id, agent, kind: "new_task", task: parent, title },
});
const decide = (id: string): NewEvent => ({
  type: "proposal.decided", actor: "head",
  data: { proposal: id, accepted: true, by: "head" },
});
const close = (task: string): NewEvent => ({
  type: "task.closed", actor: "server",
  data: { task, status: "solved" },
});

describe("normalizeTitle", () => {
  test("lowercases, drops punctuation and stopwords, sorts words", () => {
    expect(normalizeTitle("The Lemma, and a Proof of It!")).toBe("it lemma proof");
    expect(normalizeTitle("A an the of for to in on and or with")).toBe("");
    expect(normalizeTitle("  Zeta   alpha  ")).toBe("alpha zeta");
  });

  test("numbers are tokens and must match exactly", () => {
    expect(normalizeTitle("Prove lemma 3")).toBe("3 lemma prove");
    expect(normalizeTitle("Prove lemma 4")).toBe("4 lemma prove");
    expect(normalizeTitle("Prove lemma 3")).not.toBe(normalizeTitle("Prove lemma 4"));
  });
});

describe("findDuplicate", () => {
  test("matches an open sibling task with the same normalized title", () => {
    const ev = logger();
    const state = replay(RULES, [
      ev(post("T-1", null, "Area")),
      ev(post("T-2", "T-1", "Prove Lemma 3")),
      ev(post("T-3", null, "Prove Lemma 3")),
    ]);
    expect(findDuplicate(state, "T-1", "prove the lemma 3!")).toEqual({ task: "T-2" });
    expect(findDuplicate(state, null, "Prove lemma 3")).toEqual({ task: "T-3" });
    expect(findDuplicate(state, "T-1", "Prove lemma 4")).toBeNull(); // number differs
    expect(findDuplicate(state, "T-2", "Prove lemma 3")).toBeNull(); // different parent
  });

  test("a closed task is not a duplicate", () => {
    const ev = logger();
    const state = replay(RULES, [ev(post("T-1", null, "Area")), ev(post("T-2", "T-1", "Lemma")), ev(close("T-2"))]);
    expect(findDuplicate(state, "T-1", "Lemma")).toBeNull();
  });

  test("an undecided proposal matches and is preferred over a task", () => {
    const ev = logger();
    const state = replay(RULES, [
      ev(post("T-1", null, "Area")),
      ev(post("T-2", "T-1", "Lemma")),
      ev(propose("P-1", "T-1", "the LEMMA")),
    ]);
    expect(findDuplicate(state, "T-1", "Lemma")).toEqual({ proposal: "P-1" });
  });

  test("a decided proposal is not a duplicate", () => {
    const ev = logger();
    const state = replay(RULES, [
      ev(post("T-1", null, "Area")), ev(propose("P-1", "T-1", "Lemma")), ev(decide("P-1")),
    ]);
    expect(findDuplicate(state, "T-1", "Lemma")).toBeNull();
  });

  test("an empty normalized title never matches", () => {
    const ev = logger();
    const state = replay(RULES, [ev(post("T-1", null, "Area")), ev(post("T-2", "T-1", "the"))]);
    expect(findDuplicate(state, "T-1", "the and or")).toBeNull();
    expect(findDuplicate(state, "T-1", "!!! ???")).toBeNull();
  });
});
