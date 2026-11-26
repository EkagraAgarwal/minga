/**
 * Append-only event log on bun:sqlite.
 *
 * The store is the only writer: it stamps `seq` (head + 1) and `at` (now, or a
 * caller-supplied date) so the log is gap-free and replayable. Subscribers are
 * notified synchronously after the row is committed; a subscriber that throws
 * is logged and skipped so it can never break an append.
 */
import { Database } from "bun:sqlite";
import type { EventStore, OpenEventStore } from "../core/contracts.ts";
import type { MingaEvent, NewEvent } from "../core/types.ts";

interface EventRow {
  seq: number;
  at: string;
  type: string;
  actor: string;
  data: string;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS events (
    seq   INTEGER PRIMARY KEY,
    at    TEXT NOT NULL,
    type  TEXT NOT NULL,
    actor TEXT NOT NULL,
    data  TEXT NOT NULL
  );
`;

/** Row -> event. `data` is stored as JSON text. */
function toEvent(row: EventRow): MingaEvent {
  return {
    seq: row.seq,
    at: row.at,
    type: row.type,
    actor: row.actor,
    data: JSON.parse(row.data),
  } as MingaEvent;
}

export const openEventStore: OpenEventStore = (path: string): EventStore => {
  const db = new Database(path, { create: true });
  const isFile = path !== ":memory:" && path !== "";
  if (isFile) {
    // WAL keeps readers from blocking the single writer. In-memory DBs have no
    // WAL journal, so only file-backed stores opt in.
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
  }
  db.exec(SCHEMA);

  const headStmt = db.prepare("SELECT MAX(seq) AS seq FROM events");
  const insertStmt = db.prepare(
    "INSERT INTO events (seq, at, type, actor, data) VALUES (?, ?, ?, ?, ?)",
  );
  const sinceStmt = db.prepare(
    "SELECT seq, at, type, actor, data FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?",
  );

  const listeners = new Set<(event: MingaEvent) => void>();

  const head = (): number => {
    const row = headStmt.get() as { seq: number | null } | null;
    return row?.seq ?? 0;
  };

  const append = (event: NewEvent, at?: Date): MingaEvent => {
    const seq = head() + 1;
    const stored: MingaEvent = {
      ...event,
      seq,
      at: (at ?? new Date()).toISOString(),
    } as MingaEvent;
    insertStmt.run(
      stored.seq,
      stored.at,
      stored.type,
      stored.actor,
      JSON.stringify(stored.data),
    );
    for (const listener of listeners) {
      try {
        listener(stored);
      } catch (err) {
        console.error("event store subscriber failed:", err);
      }
    }
    return stored;
  };

  const since = (after: number, limit?: number): MingaEvent[] => {
    const rows = sinceStmt.all(after, limit ?? -1) as EventRow[];
    return rows.map(toEvent);
  };

  const subscribe = (listener: (event: MingaEvent) => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const close = (): void => {
    listeners.clear();
    if (isFile) {
      try {
        // Fold the WAL back into the main file so the database is a single
        // self-contained file after close.
        db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      } catch {
        // Checkpoint is best-effort; closing is what matters.
      }
    }
    db.close();
  };

  return { append, since, head, subscribe, close };
};
