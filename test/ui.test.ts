import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type AnyRec = Record<string, any>;

const root = join(import.meta.dir, "..");
const html = readFileSync(join(root, "src", "ui", "index.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";

// ------------------------------------------------------------------ static UI tests

describe("lab notebook index.html", () => {
  test("is self-contained and speaks the v2 protocol", () => {
    expect(html).not.toMatch(/<script\b[^>]*\bsrc\s*=/i);
    expect(html).toMatch(/<script>/i);
    expect(script).toContain("new EventSource(");
    expect(script).toContain('fetch("/api/view"');
    expect(script).toContain("/api/stream?after=");
    expect(script).toContain("visibilitychange");
  });

  test("contains the required element ids", () => {
    const ids = [
      "cv", "cwrap", "cspacer", "taskList", "taskSpacer", "marginNote", "noteTitle", "noteBody",
      "qlist", "qspacer", "logList", "projectName", "projectGoal", "headAgent", "joinUrl",
      "rAgents", "rAttempts", "rQueue", "rAccepted", "rOpen", "rEvents",
      "leaderBody", "modelBody", "conn", "serverTime", "seq",
      "themeLight", "themeDark", "themeAuto", "copyJoin",
    ];
    for (const id of ids) expect(html).toContain(`id="${id}"`);
  });

  test("uses only the specified type scale and one ink, one accent", () => {
    const sizes = new Set([...html.matchAll(/font-size:\s*(\d+)px/g)].map(m => m[1] ?? ""));
    for (const size of sizes) expect(["12", "13", "15", "20", "32"]).toContain(size);
    expect(html).toContain("--paper:#f3f0e8");
    expect(html).toContain("--ink:#1c1a16");
    expect(html).toContain("--accent:#c8381c");
    expect(html).toContain("background:var(--paper)");
  });

  test("contains none of the forbidden visual patterns", () => {
    for (const word of ["gradient", "box-shadow", "backdrop-filter", "blur", "Inter", "glass", "glow"]) {
      expect(html).not.toContain(word);
    }
    // Emoji (presentational symbols and variation selectors), not the drawing glyphs.
    expect(html).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{FE0F}\u{2705}\u{274C}\u{2764}]/u);
    for (const m of html.matchAll(/border-radius\s*:\s*([\d.]+)px/g)) {
      expect(Number(m[1])).toBeLessThanOrEqual(2);
    }
    expect(html).not.toMatch(/font-family:[^;]*\b(Roboto|Inter|Roboto Mono)\b/);
  });

  test("never builds markup from server strings", () => {
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new Function\s*\(/);
    expect(script).toMatch(/textContent\s*=/);
  });
});

// ------------------------------------------------------------------ browser-free XSS test

class FakeNode {
  nodeType = 1;
  tagName: string;
  className = "";
  attributes: Record<string, string> = {};
  style: Record<string, string> = {};
  children: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  scrollTop = 0;
  clientWidth = 820;
  clientHeight = 560;
  private text = "";
  constructor(tag: string, nodeType = 1) { this.tagName = tag.toUpperCase(); this.nodeType = nodeType; allNodes.push(this); }
  get textContent(): string { return this.text || this.children.map(c => c.textContent).join(""); }
  set textContent(v: unknown) { this.text = String(v ?? ""); this.children = []; }
  get firstChild(): FakeNode | null { return this.children[0] ?? null; }
  get lastChild(): FakeNode | null { return this.children[this.children.length - 1] ?? null; }
  get childNodes(): FakeNode[] { return this.children; }
  appendChild(n: FakeNode): FakeNode {
    if (n.nodeType === 11) { for (const c of [...n.children]) this.appendChild(c); n.children = []; return n; }
    n.parentNode = this;
    this.children.push(n);
    return n;
  }
  insertBefore(n: FakeNode, ref: FakeNode | null): FakeNode {
    if (n.nodeType === 11) { for (const c of [...n.children]) this.insertBefore(c, ref); n.children = []; return n; }
    n.parentNode = this;
    const at = ref ? this.children.indexOf(ref) : -1;
    if (at < 0) this.children.push(n); else this.children.splice(at, 0, n);
    return n;
  }
  removeChild(n: FakeNode): FakeNode {
    const at = this.children.indexOf(n);
    if (at >= 0) this.children.splice(at, 1);
    n.parentNode = null;
    return n;
  }
  replaceChildren(...nodes: FakeNode[]): void {
    this.children = [];
    this.text = "";
    for (const n of nodes) this.appendChild(n);
  }
  setAttribute(k: string, v: unknown): void { this.attributes[k] = String(v); }
  getAttribute(k: string): string | null { return this.attributes[k] ?? null; }
  removeAttribute(k: string): void { delete this.attributes[k]; }
  addEventListener(): void {}
  removeEventListener(): void {}
  getBoundingClientRect(): AnyRec { return { top: 0, left: 0, width: 820, height: 560 }; }
  getContext(): AnyRec { return ctxStub; }
  querySelector(): null { return null; }
}

let allNodes: FakeNode[] = [];
const drawn: string[] = [];
const ctxStub: AnyRec = {
  clearRect() {}, fillRect() {}, strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
  stroke() {}, fill() {}, arc() {}, rect() {}, drawImage() {}, setTransform() {}, save() {}, restore() {},
  setLineDash() {}, ellipse() {}, translate() {},
  fillText(value: unknown) { drawn.push(String(value)); },
  measureText() { return { width: 10 }; },
};

describe("server strings", () => {
  test("markup in model, owner, title and note renders as text without a browser", () => {
    const g = globalThis as AnyRec;
    const saved: AnyRec = {};
    const keys = ["document", "matchMedia", "getComputedStyle", "localStorage", "location", "navigator",
      "requestAnimationFrame", "MutationObserver", "ResizeObserver", "window", "__MINGA_UI_TEST__"];
    for (const k of keys) saved[k] = [Object.prototype.hasOwnProperty.call(g, k), g[k]];

    allNodes = [];
    drawn.length = 0;
    const byId = new Map<string, FakeNode>();
    const docEl = new FakeNode("html");
    g.document = {
      title: "",
      hidden: false,
      documentElement: docEl,
      getElementById(id: string): FakeNode {
        let n = byId.get(id);
        if (!n) { n = new FakeNode("div"); byId.set(id, n); }
        return n;
      },
      createElement(tag: string): FakeNode { return new FakeNode(tag); },
      createDocumentFragment(): FakeNode { return new FakeNode("#fragment", 11); },
      addEventListener(): void {},
    };
    g.matchMedia = (q: string): AnyRec => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
    g.getComputedStyle = (): AnyRec => ({ getPropertyValue: () => "#1c1a16" });
    g.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    g.location = { origin: "https://minga.test" };
    g.navigator = { clipboard: { writeText() {} } };
    g.requestAnimationFrame = () => 1;
    g.MutationObserver = class { observe() {} };
    g.ResizeObserver = class { observe() {} };
    g.window = { devicePixelRatio: 1 };

    let api: AnyRec | null = null;
    g.__MINGA_UI_TEST__ = (hooks: AnyRec): void => { api = hooks; };

    try {
      new Function(script)();
      expect(api).toBeTruthy();
      const hooks = api!;

      const at = new Date().toISOString();
      const future = new Date(Date.now() + 600000).toISOString();
      const modelName = "<script>alert(6)</script>";
      const owner = 'x" onerror="alert(8)';
      const title = "<img src=x onerror=alert(3)>";
      const noteText = "<script>alert(9)</script>";
      const hostile: AnyRec = {
        project: {
          name: "hostile", goal: "goal <img src=x onerror=alert(2)>", scope: "", check: "", paths: [],
          headAgent: "head000001", rules: { width: 6 },
        },
        seq: 5,
        now: at,
        totals: {
          agents: 1, activeAgents: 1, tasks: 1, openTasks: 1, liveAttempts: 1,
          queuedSubmissions: 1, checkingSubmissions: 1, submissions: 2, accepted: 0, notes: 1, events: 5,
        },
        tasks: [{
          id: "T-1", title, body: "</td><script>alert(4)</script>", parent: null, children: [],
          status: "open", points: 10, postedAt: at, attemptCount: 1, noteCount: 1, liveCount: 1,
        }],
        attempts: [{
          id: "A-1", task: "T-1", agent: "abcdef123456", role: "build", approach: "<svg onload=alert(5)>",
          model: modelName, startedAt: at, leaseUntil: future, lastBeatAt: at,
        }],
        agents: [{
          id: "abcdef123456", publicKey: "", model: modelName, harness: 'h" onerror="alert(7)',
          owner, joinedAt: at, lastSeenAt: at, banned: false, points: 0, accepted: 0, submissions: 0,
        }],
        notes: [{ id: "N-1", task: "T-1", agent: "abcdef123456", kind: "idea", text: noteText, at }],
        submissions: [
          {
            id: "S-1", attempt: "A-1", task: "T-1", agent: "abcdef123456", model: modelName,
            claim: "solves", message: "", files: [], bytes: 0, status: "queued", queuedAt: at, runs: 0, points: 0,
          },
          {
            id: "S-2", attempt: "A-1", task: "T-1", agent: "abcdef123456", model: modelName,
            claim: "solves", message: "", files: [], bytes: 0, status: "checking", queuedAt: at, runs: 1, points: 0,
          },
        ],
        proposals: [],
        leaderboard: {
          agents: [{ agent: "abcdef123456", owner, model: modelName, harness: "h", points: 1, accepted: 0, submissions: 1 }],
          models: [{ model: modelName, agents: 1, points: 1, accepted: 0, submissions: 1, passRate: 0 }],
        },
      };

      hooks.applyView(hostile);
      hooks.flush();

      const blob = allNodes.map(n => n.textContent).join("\n") + "\n" + drawn.join("\n");
      expect(blob).toContain(title);
      expect(blob).toContain(modelName);
      expect(blob).toContain(owner);
      expect(blob).toContain(noteText);
      expect(blob).toContain("<svg onload=alert(5)>");

      for (const n of allNodes) {
        for (const [key, value] of Object.entries(n.attributes)) {
          expect(key + "=" + value).not.toContain("<script");
          expect(key + "=" + value).not.toContain("onerror");
          expect(key + "=" + value).not.toContain("onload");
        }
      }
    } finally {
      for (const k of keys) {
        const [present, value] = saved[k] as [boolean, unknown];
        if (present) g[k] = value; else delete g[k];
      }
    }
  });

  test("boots against a snapshot and connects the stream without runtime errors", async () => {
    const g = globalThis as AnyRec;
    const saved: AnyRec = {};
    const keys = ["document", "matchMedia", "getComputedStyle", "localStorage", "location", "navigator",
      "requestAnimationFrame", "MutationObserver", "ResizeObserver", "window", "fetch", "EventSource",
      "setTimeout", "queueMicrotask", "__MINGA_UI_TEST__"];
    for (const k of keys) saved[k] = [Object.prototype.hasOwnProperty.call(g, k), g[k]];

    allNodes = [];
    drawn.length = 0;
    const byId = new Map<string, FakeNode>();
    g.document = {
      title: "",
      hidden: false,
      documentElement: new FakeNode("html"),
      getElementById(id: string): FakeNode {
        let n = byId.get(id);
        if (!n) { n = new FakeNode("div"); byId.set(id, n); }
        return n;
      },
      createElement(tag: string): FakeNode { return new FakeNode(tag); },
      createDocumentFragment(): FakeNode { return new FakeNode("#fragment", 11); },
      addEventListener(): void {},
    };
    g.matchMedia = (q: string): AnyRec => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
    g.getComputedStyle = (): AnyRec => ({ getPropertyValue: (n: string) => n === "--mono" ? "monospace" : "#1c1a16" });
    g.localStorage = { getItem: () => null, setItem() {} };
    g.location = { origin: "https://minga.test" };
    g.navigator = { clipboard: { writeText() {} } };
    const frames: Array<(t: number) => void> = [];
    g.requestAnimationFrame = (cb: (t: number) => void): number => { frames.push(cb); return frames.length; };
    g.MutationObserver = class { observe() {} };
    g.ResizeObserver = class { observe() {} };
    g.window = { devicePixelRatio: 1 };
    g.setTimeout = () => 1;
    g.queueMicrotask = (fn: () => void): void => { fn(); };
    const streams: string[] = [];
    g.EventSource = class {
      constructor(url: string) { streams.push(url); }
      addEventListener(): void {}
      close(): void {}
    };
    const at = new Date().toISOString();
    g.fetch = async () => ({
      ok: true,
      json: async () => ({
        project: { name: "boot", goal: "goal", scope: "", check: "", paths: [], headAgent: "aaaa", rules: { width: 2 } },
        seq: 7, now: at,
        totals: {
          agents: 1, activeAgents: 1, tasks: 1, openTasks: 1, liveAttempts: 1,
          queuedSubmissions: 0, checkingSubmissions: 0, submissions: 0, accepted: 0, notes: 0, events: 7,
        },
        tasks: [{ id: "T-1", title: "boot task", body: "body", parent: null, children: [], status: "open", points: 1, postedAt: at, attemptCount: 1, noteCount: 0, liveCount: 1 }],
        attempts: [{ id: "A-1", task: "T-1", agent: "aaaa", role: "build", approach: "x", model: "hy4-flash", startedAt: at, leaseUntil: new Date(Date.now() + 60000).toISOString(), lastBeatAt: at }],
        agents: [{ id: "aaaa", publicKey: "", model: "hy4-flash", harness: "opencode", joinedAt: at, lastSeenAt: at, banned: false, points: 0, accepted: 0, submissions: 0 }],
        notes: [], submissions: [], proposals: [],
        leaderboard: { agents: [], models: [] },
      }),
    });
    delete g.__MINGA_UI_TEST__;
    try {
      new Function(script)();
      await Bun.sleep(10);
      const frame = frames[0];
      expect(frame).toBeTruthy();
      frame!(16);
      expect(streams).toEqual(["/api/stream?after=7"]);
      expect(g.document.title).toBe("Minga — boot");
      expect(drawn.join("\n")).toContain("boot task");
      expect(byId.get("rAttempts")?.textContent).toBe("1");
    } finally {
      for (const k of keys) {
        const [present, value] = saved[k] as [boolean, unknown];
        if (present) g[k] = value; else delete g[k];
      }
    }
  });
});

// ------------------------------------------------------------------ dev server tests

describe("dev server", () => {
  let proc: { kill: () => void; exited: Promise<number> } | null = null;
  let origin = "";
  let headSeq = 0;

  beforeAll(async () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const port = probe.port;
    probe.stop(true);
    origin = `http://127.0.0.1:${port}`;

    // process.execPath, not "bun": on Windows "bun" can resolve to an npm shim, and killing the shim leaks the server.
    proc = Bun.spawn([process.execPath, join(root, "src", "ui", "dev-server.ts"),
      "--port", String(port), "--agents", "30", "--tasks", "60", "--rate", "8"], {
      cwd: root,
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(origin + "/api/view");
        if (res.ok) {
          const body = await res.json() as { seq: number };
          headSeq = body.seq;
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
    expect(body).toContain("<title>Minga —");
  });

  test("serves a valid ViewResponse at /api/view", async () => {
    const res = await fetch(origin + "/api/view");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    const body = await res.json() as AnyRec;
    expect(Object.keys(body).sort()).toEqual([
      "agents", "attempts", "leaderboard", "notes", "now", "project", "proposals", "seq", "submissions", "tasks", "totals",
    ]);
    expect(typeof body.seq).toBe("number");
    expect(Number.isNaN(Date.parse(String(body.now)))).toBe(false);
    const project = body.project as AnyRec;
    for (const k of ["name", "goal", "scope", "check", "headAgent"]) expect(typeof project[k]).toBe("string");
    expect(typeof project.rules).toBe("object");
    expect(Array.isArray(project.paths)).toBe(true);
    const totals = body.totals as AnyRec;
    for (const k of ["agents", "activeAgents", "tasks", "openTasks", "liveAttempts", "queuedSubmissions",
      "checkingSubmissions", "submissions", "accepted", "notes", "events"]) {
      expect(typeof totals[k]).toBe("number");
    }
    for (const k of ["tasks", "attempts", "agents", "notes", "submissions", "proposals"]) {
      expect(Array.isArray(body[k])).toBe(true);
    }
    expect((body.tasks as unknown[]).length).toBeGreaterThan(0);
    expect((body.agents as unknown[]).length).toBeGreaterThan(0);
    const task = (body.tasks as AnyRec[])[0]!;
    for (const k of ["id", "title", "body", "status", "points", "postedAt", "attemptCount", "noteCount", "liveCount"]) {
      expect(k in task).toBe(true);
    }
    const leaderboard = body.leaderboard as AnyRec;
    expect(Array.isArray(leaderboard.agents)).toBe(true);
    expect(Array.isArray(leaderboard.models)).toBe(true);
  });

  test("streams real event shapes with ascending seq, honoring ?after and Last-Event-ID", async () => {
    const controller = new AbortController();
    const res = await fetch(origin + "/api/stream?after=" + Math.max(0, headSeq - 1), {
      signal: controller.signal,
      headers: { "last-event-id": String(headSeq) },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    const reader = res.body?.getReader();
    expect(reader).toBeTruthy();

    let text = "";
    const deadline = Date.now() + 5000;
    let matched: RegExpMatchArray | null = null;
    while (Date.now() < deadline) {
      const chunk = await reader!.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
      matched = text.match(/id: (\d+)\nevent: ([\w.]+)\ndata: (\{[\s\S]*?\})\n\n/);
      if (matched) break;
    }
    expect(matched).toBeTruthy();
    expect(Number(matched![1])).toBeGreaterThan(headSeq);
    const event = JSON.parse(matched![3]!) as AnyRec;
    expect(event.seq).toBe(Number(matched![1]));
    expect(event.type).toBe(matched![2]);
    for (const k of ["seq", "at", "type", "actor", "data"]) expect(k in event).toBe(true);
    await reader!.cancel();
    controller.abort();
  }, 10000);

  test("serves /join as plain text", async () => {
    const res = await fetch(origin + "/join");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/plain");
    expect(await res.text()).toContain("/kit/minga.mjs");
  });
});
