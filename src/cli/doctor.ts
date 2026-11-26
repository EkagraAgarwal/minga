/**
 * `minga doctor`: one line per check, with a fix for every problem.
 * Every external command goes through the injectable RuntimeDeps runner.
 */
import { findPackageRoot } from "./runtime.ts";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CommandResult } from "./commands.ts";
import { bunInfo, defaultSyncRunner, type RuntimeDeps } from "./runtime.ts";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface DoctorOutput {
  checks: DoctorCheck[];
}

export interface DoctorInput {
  dir: string;
  repo?: string;
  packageRoot?: string | null;
}

export function doctorCommand(input: DoctorInput, deps: RuntimeDeps = {}): CommandResult<DoctorOutput> {
  const runner = deps.syncRunner ?? defaultSyncRunner;
  const checks: DoctorCheck[] = [];
  const add = (check: DoctorCheck): void => { checks.push(check); };

  const nodeMajor = Number(process.versions.node.split(".")[0] ?? 0);
  add(nodeMajor >= 20
    ? { name: "node", ok: true, detail: process.version }
    : {
      name: "node", ok: false, detail: process.version,
      fix: "Install Node 20 or newer: https://nodejs.org",
    });

  const bun = bunInfo(deps);
  add(bun.ok
    ? { name: "bun", ok: true, detail: bun.version ?? bun.detail }
    : { name: "bun", ok: false, detail: bun.detail, ...(bun.fix !== undefined ? { fix: bun.fix } : {}) });

  const git = runner("git", ["--version"]);
  add(git.status === 0
    ? { name: "git", ok: true, detail: git.stdout.trim() || git.stderr.trim() }
    : {
      name: "git", ok: false, detail: git.stderr.trim() || git.stdout.trim() || "not found",
      fix: "Install git: https://git-scm.com",
    });

  const repoDir = resolve(input.repo ?? input.dir);
  const isRepo = existsSync(join(repoDir, ".git"));
  add(isRepo
    ? { name: "repo", ok: true, detail: repoDir }
    : { name: "repo", ok: false, detail: `${repoDir} is not a git repository`, fix: `git init ${repoDir}` });

  const tomlPath = join(repoDir, "project.toml");
  const hasToml = existsSync(tomlPath);
  add(hasToml
    ? { name: "project.toml", ok: true, detail: tomlPath }
    : {
      name: "project.toml", ok: false, detail: `${tomlPath} is missing`,
      fix: `minga init ${repoDir} --name "<name>" --goal "<goal>" --scope "<scope>" --check "<check>" --paths "<glob>"`,
    });

  // The server owns TOML parsing (Bun.TOML / Bun.Glob); ask it to validate.
  if (bun.ok) {
    const root = input.packageRoot === undefined
      ? (deps.packageRoot === undefined ? findPackageRoot() : deps.packageRoot)
      : input.packageRoot;
    if (root === null) {
      add({
        name: "config", ok: false, detail: "cannot find the minga package root",
        fix: 'run "minga doctor" from the installed "minga" package or the minga repo',
      });
    } else {
      const worker = join(root, "src", "server", "main.ts");
      const dry = runner(deps.bunPath ?? "bun", [worker, "--repo", repoDir, "--dry-run"]);
      const detail = dry.stdout.trim() || dry.stderr.trim() || `exit ${dry.status}`;
      add(dry.status === 0
        ? { name: "config", ok: true, detail }
        : { name: "config", ok: false, detail, fix: "fix project.toml and re-run minga doctor" });
    }
  }

  const text = checks.map((check) => [
    check.ok ? "ok" : "problem",
    check.name,
    check.detail,
    ...(check.fix !== undefined && !check.ok ? [`(fix: ${check.fix})`] : []),
  ].join("  ")).join("\n");

  return { text, data: { checks } };
}
