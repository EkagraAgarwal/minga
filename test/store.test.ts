import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEventStore } from "../src/log/store.ts";
import type { MingaEvent, NewEvent } from "../src/core/types.ts";

const T0 = "2026-01-01T00:00:00.000Z";

function joined(agent: string, model = "m1"): NewEvent {
  return {
    type: "agent.joined",
    actor: agent,
    data: { agent, publicKey: `pk-${agent}`, model, harness: "h", rejoin: false },
  };
}

function posted(task: string): NewEvent {
  return {
    type: "task.posted",
    actor: "server",
    data: { task, title: "t", body: "b", parent: null, points: 3, by: "config" },
  };
}

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "minga-store-"));
  tempDirs.push(dir);
  return join(dir, "events.db");
}

afterAll(async () => {
  for (const dir of tempDirs) {
    // Windows occasionally keeps the sqlite file handle alive for a tick
    // after close; cleanup is best-effort.
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
});

describe("event store", () => {
  test("head is 0 on an empty store and append stamps gap-free seqs", () => {
    const store = openEventStore(":memory:");
    expect(store.head()).toBe(0);

    const a = store.append(joined("aaa"), new Date(T0));
    const b = store.append(posted("T-1"), new Date("2026-01-01T00:01:00.000Z"));

    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(a.at).toBe(T0);
    expect(b.at).toBe("2026-01-01T00:01:00.000Z");
    expect(store.head()).toBe(2);
    store.close();
  });

  test("append defaults at to now as ISO-8601", () => {
    const store = openEventStore(":memory:");
    const before = Date.now();
    const ev = store.append(joined("aaa"));
    const after = Date.now();

    expect(ev.at).toBe(new Date(ev.at).toISOString());
    const ms = Date.parse(ev.at);
    expect(ms).toBeGreaterThanOrEqual(before - 1000);
    expect(ms).toBeLessThanOrEqual(after + 1000);
    store.close();
  });

  test("since is ascending, filtered by after and capped by limit", () => {
    const store = openEventStore(":memory:");
    for (let i = 1; i <= 5; i++) store.append(posted(`T-${i}`), new Date(T0));

    expect(store.since(0).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(store.since(2).map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(store.since(0, 2).map((e) => e.seq)).toEqual([1, 2]);
    expect(store.since(3, 2).map((e) => e.seq)).toEqual([4, 5]);
    expect(store.since(5)).toEqual([]);
    expect(store.since(0, 0)).toEqual([]);
    store.close();
  });

  test("round-trips the event payload through JSON", () => {
    const store = openEventStore(":memory:");
    const input: NewEvent = {
      type: "task.posted",
      actor: "server",
      data: { task: "T-9", title: "x", body: "line1\nline2", parent: null, points: 7, by: "config" },
    };
    const stored = store.append(input, new Date(T0));
    const [got] = store.since(0);

    expect(got).toEqual(stored);
    expect((got as Extract<MingaEvent, { type: "task.posted" }>).data.body).toBe("line1\nline2");
    store.close();
  });

  test("subscribers run synchronously; unsubscribe stops delivery; a thrower is isolated", () => {
    const store = openEventStore(":memory:");
    const seen: number[] = [];
    const unsubscribe = store.subscribe((e) => seen.push(e.seq));

    const originalError = console.error;
    const logged: unknown[] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      store.subscribe(() => {
        throw new Error("boom");
      });

      const ev = store.append(joined("aaa"), new Date(T0));
      expect(seen).toEqual([ev.seq]);
      expect(store.head()).toBe(1);
      expect(logged.length).toBe(1);

      unsubscribe();
      store.append(joined("bbb"), new Date(T0));
      expect(seen).toEqual([1]);
    } finally {
      console.error = originalError;
      store.close();
    }
  });

  test("persists across reopen with a file database", () => {
    const path = tempDbPath();
    const first = openEventStore(path);
    expect(existsSync(path)).toBe(true);
    first.append(joined("aaa"), new Date(T0));
    first.append(posted("T-1"), new Date("2026-01-01T00:01:00.000Z"));
    first.close();

    const second = openEventStore(path);
    expect(second.head()).toBe(2);
    const events = second.since(0);
    expect(events.map((e) => e.type)).toEqual(["agent.joined", "task.posted"]);
    expect(events.map((e) => e.at)).toEqual([T0, "2026-01-01T00:01:00.000Z"]);

    // Writing resumes at the existing head.
    expect(second.append(posted("T-2"), new Date(T0)).seq).toBe(3);
    second.close();

    const third = openEventStore(path);
    expect(third.head()).toBe(3);
    third.close();
  });
});
