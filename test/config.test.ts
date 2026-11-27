import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  loadProject,
  parseAcceptPolicy,
  parseProject,
  parseReviewPolicy,
  pathAllowed,
  pathProtected,
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
    expect(cfg.checkConcurrency).toBe(0);
    expect(cfg.checkKeep).toEqual([]);
    expect(cfg.recheck).toBe("on-overlap");
    expect(cfg.rules).toEqual({
      width: 3,
      leaseMinutes: 45,
      maxAttemptsPerAgent: 1,
      accept: { mode: "head-or-votes", votes: 3 },
      defaultPoints: 10,
      roles: { explore: 2, build: 5, attack: 2, distill: 1, plan: 0 },
    });
    expect(cfg.seedTasks).toEqual([]);
    expect(cfg.protect).toEqual(["project.toml"]);
    expect(cfg.gates).toEqual({ maxFiles: 0, maxChangedLines: 0, forbid: [], warn: [] });
    expect(cfg.review).toEqual({ mode: "none" });
    expect(cfg.holdout).toBeUndefined();
    expect(cfg.sandbox).toEqual({ mode: "none" });
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

  test("parses check_concurrency, check_keep and recheck", () => {
    const cfg = parseProject(
      baseToml() +
        'check_concurrency = 4\ncheck_keep = [".lake", "build/cache", "node_modules"]\nrecheck = "on-overlap"\n',
    );
    expect(cfg.checkConcurrency).toBe(4);
    expect(cfg.checkKeep).toEqual([".lake", "build/cache", "node_modules"]);
    expect(cfg.recheck).toBe("on-overlap");
  });

  test("check_concurrency is an integer >= 0", () => {
    for (const value of ["-1", "1.5", '"2"', "true"]) {
      expect(() => parseProject(baseToml() + `check_concurrency = ${value}\n`))
        .toThrow(/check_concurrency must be an integer >= 0/);
    }
    expect(parseProject(baseToml() + "check_concurrency = 0\n").checkConcurrency).toBe(0);
  });

  test("check_keep must be an array", () => {
    expect(() => parseProject(baseToml() + 'check_keep = ".lake"\n'))
      .toThrow(/check_keep must be an array/);
    expect(() => parseProject(baseToml() + "check_keep = 1\n"))
      .toThrow(/check_keep must be an array/);
  });

  test("check_keep entries must be non-empty strings", () => {
    expect(() => parseProject(baseToml() + 'check_keep = [""]\n'))
      .toThrow(/check_keep\[0\] must be a non-empty string/);
    expect(() => parseProject(baseToml() + 'check_keep = ["   "]\n'))
      .toThrow(/check_keep\[0\] must be a non-empty string/);
    expect(() => parseProject(baseToml() + "check_keep = [3]\n"))
      .toThrow(/check_keep\[0\] must be a non-empty string/);
    expect(() => parseProject(baseToml() + 'check_keep = [".lake", ""]\n'))
      .toThrow(/check_keep\[1\] must be a non-empty string/);
  });

  test("check_keep rejects glob characters", () => {
    for (const entry of ["*", "cache/*", "cache?", "cache/[ab]", "cache]x"]) {
      expect(() => parseProject(baseToml() + `check_keep = ["${entry}"]\n`))
        .toThrow(/check_keep\[0\] must not contain glob characters/);
    }
  });

  test("check_keep rejects absolute, backslash and traversal paths", () => {
    for (const entry of ["/cache", "cache\\x", "../cache", "cache/../x", "cache//x"]) {
      expect(() => parseProject(baseToml() + `check_keep = ["${entry.replaceAll("\\", "\\\\")}"]\n`))
        .toThrow(/check_keep\[0\]/);
    }
  });

  test("check_keep rejects .git and .minga", () => {
    for (const entry of [".git", ".git/config", ".minga", ".minga/agent.json"]) {
      expect(() => parseProject(baseToml() + `check_keep = ["${entry}"]\n`))
        .toThrow(/check_keep\[0\] must not be inside \.git or \.minga/);
    }
  });

  test("recheck accepts only always and on-overlap", () => {
    expect(parseProject(baseToml() + 'recheck = "always"\n').recheck).toBe("always");
    expect(() => parseProject(baseToml() + 'recheck = "sometimes"\n'))
      .toThrow(/recheck must be "always" or "on-overlap"/);
    expect(() => parseProject(baseToml() + "recheck = 1\n"))
      .toThrow(/recheck must be "always" or "on-overlap"/);
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

  test("parses seed task paths (files and directory prefixes)", () => {
    const cfg = parseProject(
      baseToml() +
        `[[task]]
title = "root"
key = "root"
paths = ["src/", "lib/a.ts"]

[[task]]
title = "child"
under = "root"
`,
    );
    expect(cfg.seedTasks[0]!.paths).toEqual(["src/", "lib/a.ts"]);
    expect(cfg.seedTasks[1]!.paths).toBeUndefined();
  });

  test("validates seed task paths", () => {
    const task = (paths: string) => baseToml() + `[[task]]\ntitle = "a"\npaths = ${paths}\n`;
    expect(() => parseProject(task('"src/**"'))).toThrow(/paths must be an array/);
    expect(() => parseProject(task('["/abs.ts"]'))).toThrow(/task\[0\]\.paths\[0\] must not start with/);
    expect(() => parseProject(task('["../secret"]'))).toThrow(/task\[0\]\.paths\[0\] must be a normalized/);
    expect(() => parseProject(task('["a\\\\b"]'))).toThrow(/task\[0\]\.paths\[0\] must not contain a backslash/);
    expect(() => parseProject(task('["src//x"]'))).toThrow(/task\[0\]\.paths\[0\] must be a normalized/);
    expect(() => parseProject(task(`["${"x".repeat(301)}"]`))).toThrow(/longer than 300/);
    expect(() => parseProject(task(`[${Array.from({ length: 51 }, () => '"x"').join(",")}]`))).toThrow(/at most 50/);
    expect(parseProject(task('["src/a.ts", "lib/"]')).seedTasks[0]!.paths).toEqual(["src/a.ts", "lib/"]);
  });
});

describe("protect", () => {
  test("parses globs and always includes project.toml once", () => {
    const cfg = parseProject(
      baseToml() + 'protect = ["test/**", "project.toml", "src/config.ts"]\n',
    );
    expect(cfg.protect).toEqual(["project.toml", "test/**", "src/config.ts"]);
    expect(parseProject(baseToml() + 'protect = ["test/**"]\n').protect).toEqual([
      "project.toml",
      "test/**",
    ]);
  });

  test("rejects invalid forms naming the key", () => {
    expect(() => parseProject(baseToml() + 'protect = "test/**"\n')).toThrow(
      /protect must be an array of globs/,
    );
    expect(() => parseProject(baseToml() + "protect = [3]\n")).toThrow(
      /protect\[0\] must be a non-empty string glob/,
    );
    expect(() => parseProject(baseToml() + 'protect = ["  "]\n')).toThrow(
      /protect\[0\] must be a non-empty string glob/,
    );
    expect(() => parseProject(baseToml() + 'protect = ["test/**", ""]\n')).toThrow(
      /protect\[1\] must be a non-empty string glob/,
    );
  });
});

describe("parseReviewPolicy", () => {
  test("parses every accepted form, in the file and directly", () => {
    const cases = [
      ["none", { mode: "none" }],
      ["head", { mode: "head" }],
      ["votes:2", { mode: "votes", votes: 2 }],
      ["head-or-votes:5", { mode: "head-or-votes", votes: 5 }],
      [" head ", { mode: "head" }],
    ] as const;
    for (const [text, expected] of cases) {
      expect(parseReviewPolicy(text)).toEqual(expected);
    }
    expect(parseProject(baseToml() + 'review = "head-or-votes:5"\n').review).toEqual({
      mode: "head-or-votes",
      votes: 5,
    });
  });

  test("rejects invalid policies naming review", () => {
    for (const bad of ["", "maybe", "votes", "votes:0", "votes:1.5", "votes:999999999999999999999", "unknown:2"]) {
      expect(() => parseReviewPolicy(bad)).toThrow(/review/);
    }
    expect(() => parseProject(baseToml() + "review = 5\n")).toThrow(/review must be a string/);
    expect(() => parseProject(baseToml() + '[review]\nmode = "head"\n')).toThrow(/review/);
  });
});

describe("gates", () => {
  test("parses numbers, string rules and table rules", () => {
    const cfg = parseProject(
      baseToml() +
        `[gates]
max_files = 5
max_changed_lines = 200
forbid = [{ pattern = "TODO", paths = ["src/**"], reason = "no TODOs" }, "console\\\\.log"]
warn = ["skip\\\\("]
`,
    );
    expect(cfg.gates).toEqual({
      maxFiles: 5,
      maxChangedLines: 200,
      forbid: [
        { pattern: "TODO", paths: ["src/**"], reason: "no TODOs" },
        { pattern: "console\\.log" },
      ],
      warn: [{ pattern: "skip\\(" }],
    });
  });

  test("rejects invalid numbers and unknown keys", () => {
    expect(() => parseProject(baseToml() + "[gates]\nmax_files = -1\n")).toThrow(
      /gates\.max_files must be an integer >= 0/,
    );
    expect(() => parseProject(baseToml() + '[gates]\nmax_changed_lines = "x"\n')).toThrow(
      /gates\.max_changed_lines must be an integer >= 0/,
    );
    expect(() => parseProject(baseToml() + "[gates]\nbogus = 1\n")).toThrow(
      /gates\.bogus is not a known key/,
    );
    expect(() => parseProject(baseToml() + 'gates = "strict"\n')).toThrow(/gates must be a table/);
  });

  test("validates rule shapes naming the rule index", () => {
    expect(() => parseProject(baseToml() + '[gates]\nforbid = "TODO"\n')).toThrow(
      /gates\.forbid must be an array/,
    );
    expect(() => parseProject(baseToml() + "[gates]\nforbid = [3]\n")).toThrow(
      /gates\.forbid\[0\] must be a string or a table/,
    );
    expect(() =>
      parseProject(baseToml() + '[gates]\nforbid = [{ pattern = "TODO", bogus = 1 }]\n'),
    ).toThrow(/gates\.forbid\[0\] has unknown key "bogus"/);
    expect(() => parseProject(baseToml() + '[gates]\nforbid = [{ paths = ["src/**"] }]\n')).toThrow(
      /gates\.forbid\[0\]\.pattern/,
    );
    expect(() =>
      parseProject(baseToml() + '[gates]\nforbid = [{ pattern = "TODO", paths = [3] }]\n'),
    ).toThrow(/gates\.forbid\[0\]\.paths\[0\]/);
    expect(() =>
      parseProject(baseToml() + '[gates]\nforbid = [{ pattern = "TODO", reason = 3 }]\n'),
    ).toThrow(/gates\.forbid\[0\]\.reason must be a string/);
  });

  test("rejects regexes that do not compile", () => {
    expect(() => parseProject(baseToml() + '[gates]\nforbid = ["("]\n')).toThrow(
      /gates\.forbid\[0\].*regex/,
    );
    expect(() => parseProject(baseToml() + '[gates]\nwarn = [{ pattern = "[" }]\n')).toThrow(
      /gates\.warn\[0\]\.pattern.*regex/,
    );
  });
});

describe("holdout", () => {
  test("parses a holdout table", () => {
    const cfg = parseProject(
      baseToml() + '[holdout]\ncommand = "bun test --private"\ndir = "/tmp/minga-holdout"\n',
    );
    expect(cfg.holdout).toEqual({
      command: "bun test --private",
      dir: "/tmp/minga-holdout",
    });
  });

  test("requires command and dir and rejects unsafe dirs", () => {
    expect(() => parseProject(baseToml() + '[holdout]\ncommand = "x"\n')).toThrow(
      /holdout\.dir/,
    );
    expect(() => parseProject(baseToml() + '[holdout]\ndir = "tests"\n')).toThrow(
      /holdout\.command/,
    );
    expect(() =>
      parseProject(baseToml() + '[holdout]\ncommand = ""\ndir = "tests"\n'),
    ).toThrow(/holdout\.command/);
    for (const dir of ["..", "a/../b", ".git", ".git/hooks", "tests/.git/x"]) {
      expect(() =>
        parseProject(baseToml() + `[holdout]\ncommand = "x"\ndir = "${dir}"\n`),
      ).toThrow(/holdout\.dir/);
    }
    expect(() =>
      parseProject(baseToml() + '[holdout]\ncommand = "x"\ndir = "."\n'),
    ).toThrow(/holdout\.dir/);
  });

  test("rejects unknown keys", () => {
    expect(() => parseProject(baseToml() + '[holdout]\ncommand = "x"\ndir = "d"\nbogus = 1\n')).toThrow(
      /holdout\.bogus is not a known key/,
    );
    expect(() => parseProject(baseToml() + 'holdout = "x"\n')).toThrow(/holdout must be a table/);
  });
});

describe("sandbox", () => {
  test("parses docker with defaults and explicit values", () => {
    expect(
      parseProject(baseToml() + '[sandbox]\nmode = "docker"\nimage = "oven/bun:1"\n').sandbox,
    ).toEqual({
      mode: "docker",
      image: "oven/bun:1",
      network: "none",
      memory: "2g",
      cpus: 2,
      pids: 512,
    });
    expect(
      parseProject(
        baseToml() +
          `[sandbox]
mode = "docker"
image = "oven/bun:1"
network = "bridge"
memory = "512m"
cpus = 1.5
pids = 128
`,
      ).sandbox,
    ).toEqual({
      mode: "docker",
      image: "oven/bun:1",
      network: "bridge",
      memory: "512m",
      cpus: 1.5,
      pids: 128,
    });
    expect(parseProject(baseToml() + '[sandbox]\nmode = "none"\n').sandbox).toEqual({
      mode: "none",
    });
  });

  test("rejects invalid modes, values and keys", () => {
    expect(() => parseProject(baseToml() + '[sandbox]\nmode = "podman"\n')).toThrow(
      /sandbox\.mode/,
    );
    expect(() => parseProject(baseToml() + '[sandbox]\nimage = "x"\n')).toThrow(
      /sandbox\.image is only valid/,
    );
    expect(() => parseProject(baseToml() + '[sandbox]\nmode = "docker"\n')).toThrow(
      /sandbox\.image/,
    );
    expect(() =>
      parseProject(baseToml() + '[sandbox]\nmode = "docker"\nimage = "x"\nnetwork = "host"\n'),
    ).toThrow(/sandbox\.network/);
    expect(() =>
      parseProject(baseToml() + '[sandbox]\nmode = "docker"\nimage = "x"\nmemory = "2gb"\n'),
    ).toThrow(/sandbox\.memory/);
    for (const cpus of ["0", "-1", '"2"']) {
      expect(() =>
        parseProject(baseToml() + `[sandbox]\nmode = "docker"\nimage = "x"\ncpus = ${cpus}\n`),
      ).toThrow(/sandbox\.cpus must be a number > 0/);
    }
    for (const pids of ["15", "1.5"]) {
      expect(() =>
        parseProject(baseToml() + `[sandbox]\nmode = "docker"\nimage = "x"\npids = ${pids}\n`),
      ).toThrow(/sandbox\.pids must be an integer >= 16/);
    }
    expect(() => parseProject(baseToml() + "[sandbox]\nbogus = 1\n")).toThrow(
      /sandbox\.bogus is not a known key/,
    );
    expect(() => parseProject(baseToml() + 'sandbox = "none"\n')).toThrow(
      /sandbox must be a table/,
    );
  });
});

describe("pathProtected", () => {
  const cfg = parseProject(baseToml() + 'protect = ["test/**"]\n');

  test("always protects project.toml", () => {
    expect(pathProtected(cfg, "project.toml")).toBe(true);
    expect(pathProtected(parseProject(baseToml()), "project.toml")).toBe(true);
  });

  test("matches protect globs and nothing else", () => {
    expect(pathProtected(cfg, "test/config.test.ts")).toBe(true);
    expect(pathProtected(cfg, "test/unit/helpers.test.ts")).toBe(true);
    expect(pathProtected(cfg, "src/config.ts")).toBe(false);
    expect(pathProtected(cfg, "tests/config.test.ts")).toBe(false);
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
    expect(cfg.checkKeep).toEqual([".lake"]);
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
