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
    expect(html).toContain("--paper:#f6f6f4");
    expect(html).toContain("--ink:#161616");
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

  test("paints rows with only the spec fonts, after webfonts load", () => {
    expect(script).toContain('"IBM Plex Sans"');
    expect(script).toContain('"IBM Plex Mono"');
    expect(script).toContain('"500 13px " + FONT_SANS');
    expect(script).toContain('"400 13px " + FONT_SANS');
    expect(script).toContain('"400 12px " + FONT_MONO');
    expect(script).toContain("document.fonts.ready");
    expect(script).toContain('"loadingdone"');
    expect(html).not.toMatch(/font\s*=\s*["']bold/);
  });

  test("defaults to light with dark gated by preference or an explicit choice", () => {
    expect(html).toMatch(/:root\{[^}]*--paper:#f6f6f4[^}]*color-scheme:light/);
    expect(html).toContain("@media (prefers-color-scheme: dark)");
    expect(html).toContain(":root:not([data-theme=light])");
    expect(html).toContain(":root[data-theme=dark]");
    expect(html).toContain("prefers-reduced-motion");
  });

  test("uses the exact neutral light and dark palettes", () => {
    const light = [
      "--paper:#f6f6f4", "--paper-2:#ececea", "--ink:#161616", "--ink-2:#4d4d4d",
      "--ink-3:#8a8a8a", "--rule:#d9d9d6", "--accent:#c8381c",
    ];
    const dark = [
      "--paper:#111111", "--paper-2:#1a1a1a", "--ink:#ececec", "--ink-2:#b0b0b0",
      "--ink-3:#767676", "--rule:#2e2e2e", "--accent:#ff6b45",
    ];
    for (const token of [...light, ...dark]) expect(html).toContain(token);
    // Each dark block is self-contained: both the media-query branch and the explicit override.
    for (const block of html.match(/--paper:#111111;[^}]*}/g) ?? []) {
      for (const token of dark) expect(block).toContain(token);
    }
  });

  test("does not use Newsreader or any serif family", () => {
    expect(html).not.toContain("Newsreader");
    expect(html).not.toContain("--serif");
    expect(html).not.toMatch(/Georgia|Times New Roman|var\(--serif\)/);
    const link = html.match(/<link rel="stylesheet" href="([^"]+)"/)?.[1] ?? "";
    expect(link).toContain("family=IBM+Plex+Sans");
    expect(link).toContain("family=IBM+Plex+Mono");
    expect(link).not.toContain("Newsreader");
  });

  test("uses Plex Sans for titles, goals, sections and captions", () => {
    expect(html).toContain(".masthead h1{font:600 32px/1.1 var(--sans); letter-spacing:-0.01em");
    expect(html).toContain(".goal{font:400 15px/1.45 var(--sans); color:var(--ink-2)");
    expect(html).toContain(".section{font:500 15px/1.3 var(--sans)");
    expect(html).toContain(".caption{font:500 15px/1.4 var(--sans); color:var(--ink)");
    expect(html).toContain(".caption.note,.caption .note{font:400 13px/1.5 var(--sans); color:var(--ink-2)}");
    expect(html).toContain("caption{text-align:left; font:400 13px/1.4 var(--sans); color:var(--ink-2)");
    expect(html).not.toMatch(/font:[^;}]*italic/);
  });

  test("tables size to content with a visible pass-rate track and narrow rank", () => {
    expect(html).toContain("table-layout:auto");
    expect(html).toContain("white-space:nowrap");
    expect(html).toContain("td.trunc{max-width:28ch");
    expect(html).toContain('setAttribute("title", text)');
    expect(html).toContain(".track{display:block; width:80px; height:1px; background:var(--rule)}");
    expect(html).toContain(".bar{display:block; height:2px; max-width:80px; background:var(--ink)}");
    expect(html).toContain("th.rank,tbody td.rank{width:3.5em; text-align:right}");
    expect(script).toContain('Math.round(N(r.passRate) * 100) + "%"');
  });

  test("has a fixed scroll viewport, caption controls and a log transition", () => {
    expect(html).toContain("height:min(70vh,900px)");
    expect(html).toContain('id="rowCount"');
    expect(html).toContain('id="collapseAll"');
    expect(html).toContain('id="expandAll"');
    expect(html).toContain(".logline.fresh{color:var(--accent); transition:color 1.2s linear}");
    expect(html).toContain(".logline time{color:var(--ink-3)}");
    expect(html).not.toContain("@keyframes settle");
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

// ------------------------------------------------------------------ visual review fixes (browser-free)

function mountScript(): AnyRec {
  const g = globalThis as AnyRec;
  const saved: AnyRec = {};
  const keys = ["document", "matchMedia", "getComputedStyle", "localStorage", "location", "navigator",
    "requestAnimationFrame", "MutationObserver", "ResizeObserver", "window", "__MINGA_UI_TEST__"];
  for (const k of keys) saved[k] = [Object.prototype.hasOwnProperty.call(g, k), g[k]];

  allNodes = [];
  drawn.length = 0;
  const byId = new Map<string, FakeNode>();
  const frames: Array<(t: number) => void> = [];
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
  g.getComputedStyle = (): AnyRec => ({ getPropertyValue: () => "#1c1a16" });
  g.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  g.location = { origin: "https://minga.test" };
  g.navigator = { clipboard: { writeText() {} } };
  g.requestAnimationFrame = (cb: (t: number) => void): number => { frames.push(cb); return frames.length; };
  g.MutationObserver = class { observe() {} };
  g.ResizeObserver = class { observe() {} };
  g.window = { devicePixelRatio: 1 };
  let api: AnyRec | null = null;
  g.__MINGA_UI_TEST__ = (hooks: AnyRec): void => { api = hooks; };
  new Function(script)();
  return {
    g, byId, frames, hooks: api!,
    restore(): void {
      for (const k of keys) {
        const [present, value] = saved[k] as [boolean, unknown];
        if (present) g[k] = value; else delete g[k];
      }
    },
  };
}

function bigView(leafCount: number, submissionCount: number): AnyRec {
  const at = new Date().toISOString();
  const task = (id: string, title: string, parent: string | null, children: string[] = []): AnyRec => ({
    id, title, body: "body", parent, children, status: "open", points: 10, postedAt: at,
    attemptCount: 0, noteCount: 0, liveCount: 0,
  });
  const tasks: AnyRec[] = [];
  const areas = ["Circuit lower bounds", "Proof complexity", "Barriers"].map((title, i) => task("T-" + (i + 1), title, null));
  tasks.push(...areas);
  const subAreas = ["Switching and shrinkage", "Width lower bounds", "Relativization desk"].map((title, i) => {
    const t = task("T-" + (4 + i), title, areas[i]!.id);
    areas[i]!.children.push(t.id);
    tasks.push(t);
    return t;
  });
  for (let i = 0; i < leafCount; i += 1) {
    const parent = subAreas[i % subAreas.length]!;
    const t = task("T-" + (7 + i), "Lemma " + (i + 1), parent.id);
    parent.children.push(t.id);
    tasks.push(t);
  }
  const submissions: AnyRec[] = [];
  for (let i = 0; i < submissionCount; i += 1) {
    const checking = i % 3 === 0;
    submissions.push({
      id: "S-" + (i + 1), attempt: "A-" + (i + 1), task: "T-7", agent: "abcdef" + String(i).padStart(10, "0"),
      model: "hy4-flash", claim: "solves", message: "m", files: [], bytes: 0,
      status: checking ? "checking" : "queued", queuedAt: at, runs: checking ? 1 : 0, points: 0,
    });
  }
  return {
    project: { name: "t", goal: "g", scope: "", check: "", paths: [], headAgent: "head", rules: { width: 6 } },
    seq: 9, now: at,
    totals: {
      agents: 1, activeAgents: 1, tasks: tasks.length, openTasks: tasks.length, liveAttempts: 0,
      queuedSubmissions: submissionCount, checkingSubmissions: 0, submissions: submissionCount,
      accepted: 0, notes: 0, events: 9,
    },
    tasks, attempts: [], agents: [], notes: [], submissions, proposals: [],
    leaderboard: { agents: [], models: [] },
  };
}

describe("visual review fixes", () => {
  test("areas are expanded by default: the debug layout has over 100 rows", () => {
    const m = mountScript();
    try {
      m.hooks.applyView(bigView(180, 2));
      m.hooks.flush();
      expect(m.g.window.__minga.rowCount).toBeGreaterThan(100);
      expect(m.g.window.__minga.rowCount).toBe(186);
      expect(m.g.window.__minga.areaCount).toBe(6);
      expect(m.g.window.__minga.leafCount).toBe(180);
      expect(m.g.window.__minga.collapsedCount).toBe(0);
      expect(m.byId.get("rowCount")!.textContent).toBe("186 rows");
    } finally { m.restore(); }
  });

  test("the queue is populated from view.submissions and caps at 12 rows", () => {
    const m = mountScript();
    try {
      m.hooks.applyView(bigView(120, 60));
      m.hooks.flush();
      expect(m.g.window.__minga.queueCount).toBe(60);
      const children = m.byId.get("qlist")!.children;
      expect(children.filter((n: FakeNode) => n.className.startsWith("qrow") && !n.className.includes("more"))).toHaveLength(12);
      expect(children.find((n: FakeNode) => n.className.includes("more"))!.textContent).toBe("+48 more");
      expect(children.some((n: FakeNode) => n.className.includes("checking"))).toBe(true);
      const readout = m.byId.get("rQueue")!.textContent;
      expect(readout).toContain("queued");
      expect(readout).toContain("checking");
      expect(readout).not.toContain("/");
    } finally { m.restore(); }
  });

  test("the queue follows queued, started and checked events", () => {
    const m = mountScript();
    try {
      m.hooks.applyView(bigView(20, 1));
      m.hooks.flush();
      const at = new Date().toISOString();
      const q = (seq: number, id: string) => ({
        seq, at, type: "submission.queued", actor: "abcdef",
        data: {
          submission: id, attempt: "A-x" + seq, task: "T-7", agent: "abcdef",
          model: "hy4-flash", claim: "solves", message: "m", files: [], bytes: 0,
        },
      });
      m.hooks.queueEvent(q(10, "S-x1"));
      m.hooks.flush();
      expect(m.g.window.__minga.queueCount).toBe(2);
      m.hooks.queueEvent({
        seq: 11, at, type: "submission.started", actor: "server",
        data: { submission: "S-x1", base: "abc", round: 1 },
      });
      m.hooks.flush();
      expect(m.g.window.__minga.queueCount).toBe(2);
      expect(m.byId.get("qlist")!.children.some((n: FakeNode) => n.className.includes("checking"))).toBe(true);
      m.hooks.queueEvent({
        seq: 12, at, type: "submission.checked", actor: "server",
        data: {
          submission: "S-x1", attempt: "A-x10", task: "T-7", agent: "abcdef", model: "hy4-flash",
          claim: "solves", files: [], ok: true, exitCode: 0, timedOut: false,
          outputTail: "", durationMs: 1, points: 10,
        },
      });
      m.hooks.flush();
      expect(m.g.window.__minga.queueCount).toBe(1);
      expect(m.byId.get("rQueue")!.textContent).toContain("queued");
    } finally { m.restore(); }
  });

  test("only the newest log line starts in accent, then loses the class", () => {
    const m = mountScript();
    try {
      m.hooks.applyView(bigView(20, 0));
      m.hooks.flush();
      const at = new Date().toISOString();
      for (let i = 0; i < 3; i += 1) {
        m.hooks.queueEvent({
          seq: 10 + i, at, type: "submission.queued", actor: "abcdef",
          data: {
            submission: "S-x" + i, attempt: "A-x" + i, task: "T-7", agent: "abcdef",
            model: "hy4-flash", claim: "solves", message: "m", files: [], bytes: 0,
          },
        });
      }
      m.hooks.flush();
      const lines = m.byId.get("logList")!.children;
      expect(lines).toHaveLength(3);
      expect(lines[0]!.className).toBe("logline fresh");
      expect(lines.filter((n: FakeNode) => n.className.includes("fresh"))).toHaveLength(1);
      while (m.frames.length) { const cb = m.frames.shift() as (t: number) => void; cb(16); }
      expect(m.byId.get("logList")!.children.filter((n: FakeNode) => n.className.includes("fresh"))).toHaveLength(0);
    } finally { m.restore(); }
  });
});

// ------------------------------------------------------------------ final polish (pure helpers)

describe("final polish", () => {
  test("sparkline geometry is empty until three samples, then draws a bounded series", () => {
    const m = mountScript();
    try {
      expect(m.hooks.sparkGeometry([]).points).toBe("");
      expect(m.hooks.sparkGeometry([4, 4]).points).toBe("");
      expect(m.hooks.sparkGeometry([4, 4]).y1).toBe(7);
      expect(m.hooks.sparkGeometry([4, 4]).y2).toBe(7);
      const g = m.hooks.sparkGeometry([4, 5, 9]);
      const points = String(g.points).split(" ");
      expect(points).toHaveLength(3);
      for (const p of points) {
        const y = Number(p.split(",")[1]);
        expect(y).toBeGreaterThanOrEqual(1);
        expect(y).toBeLessThanOrEqual(13);
      }
      expect(String(m.hooks.sparkGeometry([1, 2, 3, 4, 5, 6]).points).split(" ")).toHaveLength(6);
    } finally { m.restore(); }
  });

  test("the first sample lands on load and each series holds at most 60 samples", () => {
    const m = mountScript();
    try {
      m.hooks.applyView(bigView(4, 0));
      m.hooks.flush();
      expect(m.hooks.sampleLengths()).toEqual([1, 1, 1, 1, 1, 1]);
      m.hooks.renderReadouts();
      expect(m.byId.get("spAgents")!.getAttribute("points")).toBe("");
      for (let i = 0; i < 70; i += 1) m.hooks.pushSample();
      expect(m.hooks.sampleLengths()).toEqual([60, 60, 60, 60, 60, 60]);
      m.hooks.renderReadouts();
      expect(String(m.byId.get("spAgents")!.getAttribute("points")).split(" ")).toHaveLength(60);
      expect(script).toContain("SAMPLE_MS = 5000");
    } finally { m.restore(); }
  });

  test("queue layout fits at most 12 rows and an empty queue shows a hint", () => {
    const m = mountScript();
    try {
      expect(m.hooks.queueLayout(0)).toEqual({ shown: 0, extra: 0, rows: 0 });
      expect(m.hooks.queueLayout(8)).toEqual({ shown: 8, extra: 0, rows: 8 });
      expect(m.hooks.queueLayout(60)).toEqual({ shown: 12, extra: 48, rows: 13 });
      m.hooks.applyView(bigView(4, 0));
      m.hooks.flush();
      const kids = m.byId.get("qlist")!.children;
      expect(kids.filter((n: FakeNode) => n.className === "qempty")).toHaveLength(1);
      expect(kids.find((n: FakeNode) => n.className === "qempty")!.textContent).toBe("queue empty");
      expect(kids.some((n: FakeNode) => n.className.startsWith("qrow"))).toBe(false);
      expect(html).toContain(".qlist .qempty{font:400 12px/20px var(--sans); color:var(--ink-3)}");
    } finally { m.restore(); }
  });

  test("area labels clip with an ellipsis before a fixed right-aligned count column", () => {
    const m = mountScript();
    try {
      const measure = (s: string) => s.length * 10;
      expect(m.hooks.clipText("Short", 100, measure)).toBe("Short");
      const clipped = m.hooks.clipText("Contractions and minors (variant 3)", 100, measure);
      expect(String(clipped).endsWith("…")).toBe(true);
      expect(measure(String(clipped))).toBeLessThanOrEqual(100);
      expect(script).toContain("measureText");
      expect(script).toContain('textAlign = "right"');
      expect(script).toContain("X_COUNT = 268");
    } finally { m.restore(); }
  });

  test("the margin note falls back to the busiest open leaf when nothing is hovered", () => {
    const m = mountScript();
    try {
      const tasks = [
        { id: "T-1", title: "root", status: "open", children: ["T-2"] },
        { id: "T-2", title: "leaf one", status: "open", children: [] },
        { id: "T-3", title: "leaf two", status: "open", children: [] },
        { id: "T-4", title: "closed leaf", status: "solved", children: [] },
      ];
      const live = new Map<string, AnyRec[]>([
        ["T-2", [{ id: "A-1" }]], ["T-3", [{ id: "A-2" }, { id: "A-3" }]],
      ]);
      expect(m.hooks.busiestOpenLeaf(tasks, live).id).toBe("T-3");
      expect(m.hooks.busiestOpenLeaf([tasks[0], tasks[3]], new Map())).toBeNull();

      const at = new Date().toISOString();
      const future = new Date(Date.now() + 600000).toISOString();
      const attempt = (id: string, task: string): AnyRec => ({
        id, task, agent: "aa", role: "build", approach: "x", model: "m",
        startedAt: at, leaseUntil: future, lastBeatAt: at,
      });
      const task = (id: string, title: string, parent: string | null, children: string[]): AnyRec => ({
        id, title, body: "body", parent, children, status: "open", points: 1,
        postedAt: at, attemptCount: 0, noteCount: 0, liveCount: 0,
      });
      m.hooks.applyView({
        project: { name: "t", goal: "g", scope: "", check: "", paths: [], headAgent: "head", rules: { width: 6 } },
        seq: 3, now: at,
        totals: {
          agents: 1, activeAgents: 1, tasks: 3, openTasks: 3, liveAttempts: 3,
          queuedSubmissions: 0, checkingSubmissions: 0, submissions: 0, accepted: 0, notes: 0, events: 3,
        },
        tasks: [task("T-1", "root area", null, ["T-2", "T-3"]), task("T-2", "quiet leaf", "T-1", []), task("T-3", "busy leaf", "T-1", [])],
        attempts: [attempt("A-1", "T-2"), attempt("A-2", "T-3"), attempt("A-3", "T-3")],
        agents: [], notes: [], submissions: [], proposals: [],
        leaderboard: { agents: [], models: [] },
      });
      m.hooks.flush();
      expect(m.byId.get("noteTitle")!.textContent).toBe("busy leaf");
    } finally { m.restore(); }
  });

  test("beat and released lines show task and attempt, joined shows model and harness", () => {
    const m = mountScript();
    try {
      expect(m.hooks.logObject("attempt.beat", { attempt: "A-912" }, "abcdef", "T-184")).toBe("T-184 · A-912");
      expect(m.hooks.logObject("attempt.ended", { attempt: "A-912", reason: "released" }, "abcdef", "T-184")).toBe("T-184 · A-912");
      expect(m.hooks.logObject("agent.joined", { model: "hy4-flash", harness: "opencode" }, "abcdef", "")).toBe("hy4-flash · opencode");

      const view = bigView(4, 0);
      view.attempts = [{
        id: "A-7", task: "T-7", agent: "abcdef", role: "build", approach: "x", model: "m",
        startedAt: view.now, leaseUntil: new Date(Date.now() + 600000).toISOString(), lastBeatAt: view.now,
      }];
      m.hooks.applyView(view);
      m.hooks.flush();
      m.hooks.queueEvent({
        seq: 10, at: view.now, type: "attempt.beat", actor: "abcdef",
        data: { attempt: "A-7", leaseUntil: new Date(Date.now() + 600000).toISOString(), model: "m" },
      });
      m.hooks.flush();
      const line = m.byId.get("logList")!.children[0]!;
      expect(line.children[3]!.textContent).toBe("T-7 · A-7");
      expect(line.children[0]!.textContent).toMatch(/^\d\d:\d\d:\d\d$/);
    } finally { m.restore(); }
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

  test("seeds area-like names with two area levels and spread leaves", async () => {
    const res = await fetch(origin + "/api/view");
    const body = await res.json() as AnyRec;
    const tasks = body.tasks as AnyRec[];
    const byId = new Map(tasks.map(t => [t.id, t]));
    const depth = (t: AnyRec): number => {
      let d = 0, p = t.parent;
      while (p && byId.has(p) && d < 6) { d += 1; p = byId.get(p)!.parent; }
      return d;
    };
    const top = tasks.filter(t => depth(t) === 0);
    const knownAreas = new Set([
      "Circuit lower bounds", "Proof complexity", "Barriers",
      "Algebraic methods", "Communication complexity", "Derandomization",
    ]);
    expect(top.length).toBeGreaterThanOrEqual(3);
    expect(top.length).toBeLessThanOrEqual(6);
    for (const t of top) {
      expect(knownAreas.has(t.title)).toBe(true);
      expect(t.title).not.toMatch(/variant|Refinement of|Subarea/i);
    }
    const subs = tasks.filter(t => depth(t) === 1);
    expect(subs.length).toBeGreaterThan(0);
    for (const s of subs) expect(s.title).not.toMatch(/variant|Refinement of|Subarea/i);
    const leaves = tasks.filter(t => depth(t) === 2);
    expect(leaves.length).toBeGreaterThan(40);
    expect(new Set(leaves.map(t => t.parent)).size).toBe(subs.length);
    for (const t of tasks) expect(t.title).not.toMatch(/\(variant \d+\)/i);
    expect(subs.some(s => ["Switching lemmas", "Relativization", "Polynomial method"].includes(s.title))).toBe(true);
    const titles = leaves.map(t => String(t.title));
    expect(new Set(titles).size).toBe(titles.length);
    expect(titles.some(t => t.includes("Formalize Håstad"))).toBe(true);
    expect(titles.some(t => t.includes("Razborov approximators"))).toBe(true);
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
