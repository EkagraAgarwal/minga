/**
 * Package/runtime helpers for `minga serve` and `minga doctor`.
 *
 * node:child_process and node:fs only: no Bun APIs, so this module survives
 * `bun build --target=node` into dist/minga.mjs. Every external command is
 * injectable so the behaviour can be tested on any host.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandResult } from "./commands.ts";

export const BUN_MISSING_MESSAGE =
  "Minga's server runs on Bun. Install it: npm install -g bun (or see https://bun.sh), then re-run this command.";

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Minimal synchronous command runner (spawnSync by default). */
export type SyncRunner = (command: string, args: string[], opts?: { cwd?: string }) => RunResult;

export interface SpawnedProcess {
  on(event: "exit", cb: (code: number | null, signal: string | null) => void): void;
  kill(signal: string): boolean | void;
}

/** Minimal streaming spawn (node:child_process.spawn by default). */
export type SpawnFn = (command: string, args: string[], opts: { stdio: "inherit" }) => SpawnedProcess;

export interface RuntimeDeps {
  bunPath?: string;
  syncRunner?: SyncRunner;
  spawn?: SpawnFn;
  /** Override package-root detection (null means "not installed as a package"). */
  packageRoot?: string | null;
  /** ESM URL to walk up from when packageRoot is not given. */
  fromUrl?: string;
}

export interface ServeOutput {
  bun: string;
  root: string;
  args: string[];
  code: number;
}

export const defaultSyncRunner: SyncRunner = (command, args, opts) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
  });
  return {
    status: result.status ?? -1,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
};

const defaultSpawn: SpawnFn = (command, args, opts) =>
  spawn(command, args, opts) as unknown as SpawnedProcess;

/** Walk up from `fromUrl` to the closest package.json whose name is "minga-swarm". */
export function findPackageRoot(fromUrl: string = import.meta.url): string | null {
  let dir: string;
  try {
    dir = dirname(fileURLToPath(fromUrl));
  } catch {
    return null;
  }
  for (;;) {
    const file = join(dir, "package.json");
    if (existsSync(file)) {
      try {
        const value = JSON.parse(readFileSync(file, "utf8")) as { name?: unknown };
        if ((value.name === "minga-swarm" || (value.name === "minga-swarm" || value.name === "minga"))) return dir;
      } catch {
        // Unreadable package.json: keep walking upwards.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** package.json version, or the published fallback when the kit runs standalone. */
export function packageVersion(root: string | null = findPackageRoot()): string {
  if (root !== null) {
    try {
      const value = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        version?: unknown;
      };
      if (typeof value.version === "string" && value.version.length > 0) return value.version;
    } catch {
      // fall through
    }
  }
  return "0.2.0";
}

function parseVersion(text: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!match || !match[1] || !match[2] || !match[3]) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(version: [number, number, number], min: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    const a = version[i] ?? 0;
    const b = min[i] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

export interface BunInfo {
  ok: boolean;
  version?: string;
  detail: string;
  fix?: string;
}

/** `bun --version`: presence and minimum version (1.3). */
export function bunInfo(deps: RuntimeDeps = {}): BunInfo {
  const bun = deps.bunPath ?? "bun";
  const runner = deps.syncRunner ?? defaultSyncRunner;
  let result: RunResult;
  try {
    result = runner(bun, ["--version"]);
  } catch {
    return { ok: false, detail: "not found", fix: BUN_MISSING_MESSAGE };
  }
  if (result.status !== 0) {
    return { ok: false, detail: "not found", fix: BUN_MISSING_MESSAGE };
  }
  const text = result.stdout.trim().split("\n").pop()?.trim() ?? "";
  const version = parseVersion(text);
  if (version === null || !versionAtLeast(version, [1, 3, 0])) {
    return {
      ok: false,
      version: text || undefined,
      detail: text.length > 0 ? `Bun ${text} is too old` : "could not read the Bun version",
      fix: `Minga's server needs Bun 1.3 or newer (found ${text}). Upgrade with: npm install -g bun, then re-run this command.`,
    };
  }
  return { ok: true, version: text, detail: text };
}

/** Strip this CLI's own flags; everything else goes to the Bun server. */
export function serveArgs(raw: string[]): string[] {
  const boolFlags = new Set(["json", "help"]);
  const valueFlags = new Set(["dir", "url"]);
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i] ?? "";
    if (arg === "-h") continue;
    if (arg.startsWith("--")) {
      const name = arg.slice(2).split("=", 1)[0] ?? "";
      if (boolFlags.has(name)) continue;
      if (valueFlags.has(name)) {
        if (!arg.includes("=")) i++;
        continue;
      }
    }
    out.push(arg);
  }
  return out;
}

/** Spawn `bun <root>/src/server/main.ts ...args` and forward signals and exit code. */
export async function serveCommand(raw: string[], deps: RuntimeDeps = {}): Promise<CommandResult<ServeOutput>> {
  const bun = deps.bunPath ?? "bun";
  const info = bunInfo(deps);
  if (!info.ok) throw new Error(info.fix ?? BUN_MISSING_MESSAGE);

  const root = deps.packageRoot === undefined ? findPackageRoot(deps.fromUrl) : deps.packageRoot;
  if (root === null) {
    throw new Error(
      'cannot find the minga package root; run this command from the installed "minga-swarm" package or the minga repo',
    );
  }

  const args = [join(root, "src", "server", "main.ts"), ...serveArgs(raw)];
  const spawnFn = deps.spawn ?? defaultSpawn;
  const code = await new Promise<number>((resolve, reject) => {
    let child: SpawnedProcess;
    try {
      child = spawnFn(bun, args, { stdio: "inherit" });
    } catch (err) {
      reject(err);
      return;
    }
    const onInt = () => { try { child.kill("SIGINT"); } catch { /* already gone */ } };
    const onTerm = () => { try { child.kill("SIGTERM"); } catch { /* already gone */ } };
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    child.on("exit", (exitCode) => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      resolve(exitCode ?? 0);
    });
  });

  return {
    text: `server exited with code ${code}`,
    data: { bun, root, args, code },
  };
}
