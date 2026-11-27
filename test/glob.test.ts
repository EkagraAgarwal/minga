import { describe, expect, test } from "bun:test";

import { expandBraces, globMatch, isProtectedPath } from "../src/cli/glob.ts";

/**
 * The kit's matcher must agree with the server's Bun.Glob on the protect globs
 * projects actually use. Expected values are computed with Bun.Glob (tests may
 * use Bun APIs; the CLI bundle may not).
 */
const patterns = [
  "project.toml",
  "test/**",
  "src/**",
  "**/*.test.*",
  "*.ts",
  "a/*.ts",
  "a/**/*.ts",
  "a/**/b",
  "**",
  "**/x",
  "**/*",
  "?",
  "?.ts",
  "[abc].ts",
  "[!abc].ts",
  "[a-c].ts",
  "{a,b}.ts",
  "{src,test}/**/*.ts",
  "{a,{b,c}}.ts",
  "a{b,c}d",
  ".github/**",
  "**/.minga/**",
  "a**b",
  "a\\*b",
  "test/**/*.test.ts",
  "package.json",
  "bun.lock",
  "tsconfig.json",
  "",
  "a/**",
  "a/**/",
];

const paths = [
  "project.toml",
  "a/project.toml",
  "test/a.test.ts",
  "test/a/b.test.ts",
  "test/",
  "test",
  "src/a.ts",
  "src/deep/a.ts",
  "a.ts",
  "a/b.ts",
  "a/b/c.ts",
  "a/b",
  "a/x/b",
  "a/x/y/b",
  "x",
  "a/x",
  "a/b/x",
  "a.test.ts",
  "b.test.js",
  "ab.ts",
  "a.ts",
  "b.ts",
  "d.ts",
  "abd",
  "acd",
  "axd",
  "a*b",
  "axb",
  ".github/workflows/ci.yml",
  "a/.minga/agent.json",
  ".hidden.ts",
  "a/.hidden.ts",
  "package.json",
  "bun.lock",
  "tsconfig.json",
  "",
  "a/",
  "a/b/",
];

describe("glob matcher", () => {
  test("agrees with Bun.Glob on every pattern/path pair", () => {
    let checked = 0;
    for (const pattern of patterns) {
      for (const path of paths) {
        const expected = new Bun.Glob(pattern).match(path);
        expect(`${pattern} ~ ${path}: ${globMatch(pattern, path)}`).toBe(
          `${pattern} ~ ${path}: ${expected}`,
        );
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(40);
  });

  test("handles the protect globs used by the safety docs", () => {
    const protect = ["project.toml", "test/**", "package.json", "bun.lock", "tsconfig.json", ".github/**"];
    for (const path of ["project.toml", "test/a.test.ts", "test/new/x.ts", "package.json", "bun.lock", "tsconfig.json", ".github/workflows/x.yml"]) {
      expect(isProtectedPath(path, protect)).toBe(true);
    }
    for (const path of ["src/a.ts", "test-new/a.ts", "README.md", "a/.github/x"]) {
      expect(isProtectedPath(path, protect)).toBe(false);
    }
    expect(isProtectedPath("./test/a.ts", ["test/**"])).toBe(true);
    expect(isProtectedPath("test\\a.ts", ["test/**"])).toBe(true);
  });

  test("expands nested and empty brace alternatives", () => {
    expect(expandBraces("a{b,c}d")).toEqual(["abd", "acd"]);
    expect(expandBraces("{a,{b,c}}.ts")).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(expandBraces("{a,}.ts")).toContain(".ts");
    expect(expandBraces("plain.ts")).toEqual(["plain.ts"]);
  });
});
