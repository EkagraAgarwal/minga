import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  loadProject,
  parseAcceptPolicy,
  parseProject,
  pathAllowed,
} from "../src/project/config.ts";
import { formatHeadKey, generateKeyPair, parseHeadKey } from "../src/identity/keys.ts";

const HEAD = formatHeadKey(generateKeyPair().publicKey);

const REQUIRED_FIELDS: Record<string, string> = {
  name: 'name = "demo"',
  goal: 'goal = "solve the problem"',
  scope: 'scope = "stay inside proofs/"',
  check: 'check = "true"',
  paths: 'paths = ["proofs/**/*.lean"]',
  head: `head = "${HEAD}"`,
};

function baseToml(): string {
  return Object.values(REQUIRED_FIELDS).join("\n") + "\n";
}

function tomlWithout(key: string): string {
  return Object.entries(REQUIRED_FIELDS)
    .filter(([name]) => name !== key)
    .map(([, line]) => line)
    .join("\n");
}

describe("parseProject", () => {
  test("applies all defaults", () => {
    const cfg = parseProject(baseToml());
    expect(cfg.name).toBe("demo");
    expect(cfg.checkTimeoutSeconds).toBe(600);
    expect(cfg.branch).toBe("main");
    expect(cfg.head).toBe(HEAD);
    expect(cfg.rules).toEqual({
      width: 3,
      leaseMinutes: 45,
      maxAttemptsPerAgent: 1,
      accept: { mode: "head-or-votes", votes: 3 },
      defaultPoints: 10,
      roles: { explore: 2, build: 5, attack: 2, distill: 1, plan: 0 },
    });
    expect(cfg.seedTasks).toEqual([]);
  });

  for (const key of Object.keys(REQUIRED_FIELDS)) {
    test(`requires ${key}`, () => {
      expect(() => parseProject(tomlWithout(key))).toThrow(new RegExp(key));
    });
  }

  test("rejects unknown top-level keys", () => {
    expect(() => parseProject(baseToml() + 'mystery = 1\n')).toThrow(
      /unknown top-level key "mystery"/,
    );
  });

  test("parses explicit scalar overrides", () => {
    const cfg = parseProject(
      baseToml() + 'check_timeout_seconds = 30\nbranch = "work"\n',
    );
    expect(cfg.checkTimeoutSeconds).toBe(30);
    expect(cfg.branch).toBe("work");
  });

  test("applies a partial [rules] table over defaults", () => {
    const cfg = parseProject(
      baseToml() +
        `[rules]
width = 5
accept = "votes:2"

[rules.roles]
build = 9
explore = 0
`,
    );
    expect(cfg.rules.width).toBe(5);
    expect(cfg.rules.leaseMinutes).toBe(45);
    expect(cfg.rules.maxAttemptsPerAgent).toBe(1);
    expect(cfg.rules.accept).toEqual({ mode: "votes", votes: 2 });
    expect(cfg.rules.defaultPoints).toBe(10);
    expect(cfg.rules.roles).toEqual({
      explore: 0,
      build: 9,
      attack: 2,
      distill: 1,
      plan: 0,
    });
  });

  test("validates rule numbers", () => {
    expect(() => parseProject(baseToml() + "[rules]\nwidth = 0\n")).toThrow(
      /rules\.width must be an integer >= 1/,
    );
    expect(() => parseProject(baseToml() + "[rules]\nwidth = 1.5\n")).toThrow(
      /rules\.width must be an integer >= 1/,
    );
    expect(() => parseProject(baseToml() + "[rules]\nlease_minutes = 0\n")).toThrow(
      /rules\.lease_minutes must be an integer >= 1/,
    );
    expect(() =>
      parseProject(baseToml() + "[rules]\nmax_attempts_per_agent = 0\n"),
    ).toThrow(/rules\.max_attempts_per_agent must be an integer >= 1/);
    expect(() => parseProject(baseToml() + "[rules]\ndefault_points = -1\n")).toThrow(
      /rules\.default_points must be an integer >= 0/,
    );
    expect(() => parseProject(baseToml() + "check_timeout_seconds = 0\n")).toThrow(
      /check_timeout_seconds must be an integer >= 1/,
    );
  });

  test("validates rules keys and role weights", () => {
    expect(() => parseProject(baseToml() + "[rules]\nfrobnicate = 1\n")).toThrow(
      /rules\.frobnicate is not a known key/,
    );
    expect(() => parseProject(baseToml() + "[rules.roles]\nwizard = 3\n")).toThrow(
      /rules\.roles\.wizard is not a known role/,
    );
    expect(() => parseProject(baseToml() + "[rules.roles]\nbuild = -1\n")).toThrow(
      /rules\.roles\.build must be a number >= 0/,
    );
    expect(() =>
      parseProject(
        baseToml() +
          `[rules.roles]
explore = 0
build = 0
attack = 0
distill = 0
plan = 0
`,
      ),
    ).toThrow(/rules\.roles must have at least one weight > 0/);
  });

  test("rejects a malformed head key", () => {
    const text = baseToml().replace(`head = "${HEAD}"`, 'head = "ed25519:short"');
    expect(() => parseProject(text)).toThrow(/head/);
  });

  test("rejects invalid accept policies in the file", () => {
    expect(() => parseProject(baseToml() + '[rules]\naccept = "majority"\n')).toThrow(
      /rules\.accept/,
    );
    expect(() => parseProject(baseToml() + '[rules]\naccept = "votes:0"\n')).toThrow(
      /rules\.accept/,
    );
  });

  test("parses seed tasks with defaults and nesting", () => {
    const cfg = parseProject(
      baseToml() +
        `[[task]]
title = "root"
key = "root"

[[task]]
title = "child"
body = "do the work"
under = "root"
points = 3
`,
    );
    expect(cfg.seedTasks).toEqual([
      { title: "root", body: "", key: "root" },
      { title: "child", body: "do the work", under: "root", points: 3 },
    ]);
  });

  test("validates seed tasks", () => {
    expect(() => parseProject(baseToml() + '[[task]]\nbody = "no title"\n')).toThrow(
      /task\[0\]\.title/,
    );
    expect(() =>
      parseProject(
        baseToml() +
          `[[task]]
title = "a"
key = "dup"

[[task]]
title = "b"
key = "dup"
`,
      ),
    ).toThrow(/not unique/);
    expect(() =>
      parseProject(baseToml() + '[[task]]\ntitle = "a"\nunder = "missing"\n'),
    ).toThrow(/under references unknown or later key "missing"/);
    expect(() =>
      parseProject(
        baseToml() +
          `[[task]]
title = "a"
key = "a"
under = "b"

[[task]]
title = "b"
key = "b"
`,
      ),
    ).toThrow(/under references unknown or later key "b"/);
    expect(() =>
      parseProject(baseToml() + '[[task]]\ntitle = "a"\nbogus = 1\n'),
    ).toThrow(/unknown key "bogus"/);
    expect(() =>
      parseProject(baseToml() + '[[task]]\ntitle = "a"\npoints = -1\n'),
    ).toThrow(/points must be an integer >= 0/);
    expect(() =>
      parseProject(baseToml() + '[[task]]\ntitle = "a"\npoints = 1.5\n'),
    ).toThrow(/points must be an integer >= 0/);
  });
});

describe("parseAcceptPolicy", () => {
  test("parses the three accepted forms", () => {
    expect(parseAcceptPolicy("head")).toEqual({ mode: "head" });
    expect(parseAcceptPolicy("votes:3")).toEqual({ mode: "votes", votes: 3 });
    expect(parseAcceptPolicy("head-or-votes:2")).toEqual({
      mode: "head-or-votes",
      votes: 2,
    });
    expect(parseAcceptPolicy(" head-or-votes:7 ")).toEqual({
      mode: "head-or-votes",
      votes: 7,
    });
  });

  test("rejects everything else", () => {
    for (const bad of ["", "head or 3 votes", "votes", "votes:0", "votes:1.5", "votes:-1", "unknown:2"]) {
      expect(() => parseAcceptPolicy(bad)).toThrow();
    }
  });
});

describe("pathAllowed", () => {
  const cfg = parseProject(baseToml());

  test("accepts matching repo-relative POSIX paths", () => {
    expect(pathAllowed(cfg, "proofs/Basic.lean")).toBe(true);
    expect(pathAllowed(cfg, "proofs/PvsNP/Statement.lean")).toBe(true);
  });

  test("rejects paths outside the globs", () => {
    expect(pathAllowed(cfg, "src/Main.lean")).toBe(false);
    expect(pathAllowed(cfg, "proofs/notes.txt")).toBe(false);
  });

  test("rejects empty, absolute, backslash, and traversal paths", () => {
    expect(pathAllowed(cfg, "")).toBe(false);
    expect(pathAllowed(cfg, "/proofs/Basic.lean")).toBe(false);
    expect(pathAllowed(cfg, "proofs\\Basic.lean")).toBe(false);
    expect(pathAllowed(cfg, "proofs/../Basic.lean")).toBe(false);
    expect(pathAllowed(cfg, "proofs/./Basic.lean")).toBe(false);
    expect(pathAllowed(cfg, "../proofs/Basic.lean")).toBe(false);
    expect(pathAllowed(cfg, "proofs//Basic.lean")).toBe(false);
    expect(pathAllowed(cfg, "proofs/Basic.lean/")).toBe(false);
  });

  test("rejects anything under .git even with a broad glob", () => {
    const broad = parseProject(baseToml().replace('paths = ["proofs/**/*.lean"]', 'paths = ["**/*"]'));
    expect(pathAllowed(broad, ".git/config")).toBe(false);
    expect(pathAllowed(broad, ".git/hooks/pre-commit")).toBe(false);
    expect(pathAllowed(broad, "other/file.lean")).toBe(true);
  });
});

describe("loadProject", () => {
  test("loads the pnp-lean example", async () => {
    const dir = join(import.meta.dir, "..", "examples", "pnp-lean");
    const cfg = await loadProject(dir);

    expect(cfg.name).toContain("P vs NP");
    expect(cfg.check).toBe("lake build");
    expect(cfg.paths).toEqual(["proofs/**/*.lean"]);
    expect(cfg.rules.accept).toEqual({ mode: "head-or-votes", votes: 3 });
    expect(cfg.seedTasks.length).toBeGreaterThanOrEqual(4);

    expect(() => parseHeadKey(cfg.head)).not.toThrow();

    const keys = new Set<string>();
    for (const task of cfg.seedTasks) {
      expect(task.title.length).toBeGreaterThan(0);
      if (task.under !== undefined) expect(keys.has(task.under)).toBe(true);
      if (task.key !== undefined) {
        expect(keys.has(task.key)).toBe(false);
        keys.add(task.key);
      }
    }
    // A catch-all glob still never exposes the agent key folder.
    expect(pathAllowed({ ...cfg, paths: ["**"] }, ".minga/agent.json")).toBe(false);
    expect(pathAllowed({ ...cfg, paths: ["**"] }, "proofs/x.lean")).toBe(true);
    // Areas carry keys; leaf tasks nest under them and need none.
    expect(keys.size).toBeGreaterThanOrEqual(2);
    expect(cfg.seedTasks.filter((t) => t.under !== undefined).length).toBeGreaterThanOrEqual(4);
  });
});
