import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const html = readFileSync(join(root, "src", "ui", "index.html"), "utf8");

describe("observatory index.html", () => {
  test("is self-contained: no external script tags", () => {
    expect(html).not.toMatch(/<script\b[^>]*\bsrc\s*=/i);
    expect(html).toMatch(/<script>/i);
    expect(html).toContain("new EventSource(");
  });

  test("contains the required element ids", () => {
    const ids = [
      "cv", "legend", "board", "feed", "taskPick", "iTitle", "iStatus", "iMeta",
      "iSlots", "iLanes", "iNotes", "sAgents", "sTasks", "sAcc", "sRate",
      "reconnect", "empty", "joinCmd", "pName", "pHead", "pCheck",
    ];
    for (const id of ids) expect(html).toContain(`id="${id}"`);
  });
});

describe("dev server", () => {
  let proc: { kill: () => void; exited: Promise<number> } | null = null;
  let origin = "";

  beforeAll(async () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const port = probe.port;
    probe.stop(true);
    origin = `http://127.0.0.1:${port}`;

    // process.execPath, not "bun": on Windows "bun" can resolve to an npm shim, and killing the shim leaks the server.
    proc = Bun.spawn([process.execPath, join(root, "src", "ui", "dev-server.ts")], {
      cwd: root,
      env: { ...process.env, PORT: String(port) },
      stdout: "pipe",
      stderr: "pipe",
    });

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(origin + "/api/state");
        if (res.ok) {
          await res.arrayBuffer();
          return;
        }
      } catch {
        // server not up yet
      }
      await Bun.sleep(100);
    }
    throw new Error("dev server did not start on " + origin);
  }, 20000);

  afterAll(async () => {
    if (proc) {
      proc.kill();
      await proc.exited;
      proc = null;
    }
  });

  test("serves the app at /", async () => {
    const res = await fetch(origin + "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    const body = await res.text();
    expect(body).toContain('id="cv"');
    expect(body).toContain("minga");
  });

  test("serves a valid StateResponse at /api/state", async () => {
    const res = await fetch(origin + "/api/state");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    const body = await res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["leaderboard", "now", "project", "state"]);
    expect(typeof (body.project as Record<string, unknown>).name).toBe("string");
    expect(Array.isArray((body.leaderboard as Record<string, unknown>).agents)).toBe(true);
    const state = body.state as Record<string, unknown>;
    expect(typeof state.seq).toBe("number");
    expect(Object.keys(state.tasks as object).length).toBeGreaterThan(0);
    expect(Object.keys(state.agents as object).length).toBeGreaterThan(0);
  });

  test("serves SSE at /api/stream", async () => {
    const controller = new AbortController();
    const res = await fetch(origin + "/api/stream", { signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");

    const reader = res.body?.getReader();
    expect(reader).toBeTruthy();
    const first = await reader!.read();
    expect(first.done).toBe(false);
    const text = new TextDecoder().decode(first.value);
    expect(text).toContain(":");
    await reader!.cancel();
    controller.abort();
  });
});
