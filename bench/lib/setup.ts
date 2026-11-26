/**
 * Setup and teardown for the load test: a temporary git repo with a valid
 * project.toml, a checked-in check script, and a CPU-pinned server process.
 * Resolve all paths from this file's location, never from process.cwd().
 */

import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatHeadKey, generateKeyPair, type KeyPair } from "../../src/identity/keys.ts";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * check.ts reads repo-relative paths from MINGA_FILES (space separated) and
 * exits 0 only when every file contains a line that is exactly "ok".
 */
export const CHECK_SCRIPT = `// check.ts — every submitted file must contain the line "ok".
import { existsSync } from "node:fs";

const files = (process.env.MINGA_FILES ?? "")
  .split(/[\\s,]+/)
  .map((s) => s.trim())
  .filter(Boolean);

if (files.length === 0) {
  console.error("MINGA_FILES is empty: nothing to check");
  process.exit(1);
}

let ok = true;
for (const file of files) {
  if (!existsSync(file)) {
    console.error(file + ": missing file");
    ok = false;
    continue;
  }
  const text = await Bun.file(file).text();
  if (!text.split(/\\r?\\n/).includes("ok")) {
    console.error(file + ': no line "ok"');
    ok = false;
  }
}
process.exit(ok ? 0 : 1);
`;

/** project.toml for the generated repo. check_concurrency is left at auto. */
export function projectToml(headPublicKey: string, taskCount: number): string {
  const lines: string[] = [
    'name = "Minga swarm load test"',
    'goal = "Prove the coordinator serves hundreds to thousands of agents"',
    'scope = "Only files under work/ may change."',
    'check = "bun check.ts"',
    'paths = ["work/**/*.txt"]',
    `head = "${formatHeadKey(headPublicKey)}"`,
    "",
    "[rules]",
    "width = 3",
    "lease_minutes = 2",
    "",
  ];
  for (let i = 1; i <= taskCount; i++) {
    lines.push(
      "[[task]]",
      `title = "Load task ${i}"`,
      `body = "Write work/<task>.txt containing a line ok."`,
      "points = 10",
      "",
    );
  }
  return lines.join("\n");
}

export interface TempRepo {
  dir: string;
  head: KeyPair;
}

function syncText(value: Buffer | string | null | undefined): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : value.toString("utf8");
}

function git(dir: string, args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdin: "ignore" });
  if ((result.exitCode ?? -1) !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${syncText(result.stderr || result.stdout).trim()}`);
  }
}

/** Create the temp repo with an initial commit on branch main. */
export async function createTempRepo(taskCount: number): Promise<TempRepo> {
  const dir = await mkdtemp(join(tmpdir(), "minga-swarm-"));
  try {
    const head = generateKeyPair();
    await writeFile(join(dir, "check.ts"), CHECK_SCRIPT);
    await writeFile(join(dir, "project.toml"), projectToml(head.publicKey, taskCount));

    const init = Bun.spawnSync(["git", "-C", dir, "init", "-b", "main"], { stdin: "ignore" });
    if ((init.exitCode ?? -1) !== 0) {
      // Older git has no -b flag.
      git(dir, ["init"]);
      git(dir, ["checkout", "-b", "main"]);
    }
    git(dir, ["config", "user.email", "swarm@example.com"]);
    git(dir, ["config", "user.name", "Minga Swarm"]);
    git(dir, ["config", "core.autocrlf", "false"]);
    git(dir, ["add", "check.ts", "project.toml"]);
    git(dir, ["commit", "-m", "load test seed"]);
    return { dir, head };
  } catch (error) {
    await removeDir(dir);
    throw error;
  }
}

/** Best-effort delete; Windows can keep file handles open for a moment. */
export async function removeDir(dir: string): Promise<void> {
  if (!existsSync(dir)) return;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await sleep(150);
    }
  }
  console.warn(`bench: could not remove temp repo ${dir} (Windows file locks?)`);
}

async function pinProcess(pid: number, cores: number): Promise<string> {
  const n = Math.max(1, Math.floor(cores));
  if (process.platform === "darwin") {
    console.log("bench: CPU pinning is unsupported on macOS; continuing without affinity.");
    return "unsupported (macOS)";
  }
  try {
    if (process.platform === "win32") {
      const mask = ((1n << BigInt(n)) - 1n).toString();
      const command = `(Get-Process -Id ${pid}).ProcessorAffinity = ${mask}`;
      const result = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command], {
        stdin: "ignore",
      });
      if ((result.exitCode ?? -1) !== 0) throw new Error(syncText(result.stderr || result.stdout || "unknown error").trim());
      return `cores 0..${n - 1} (mask ${mask})`;
    }
    const result = Bun.spawnSync(["taskset", "-cp", `0-${n - 1}`, String(pid)], { stdin: "ignore" });
    if ((result.exitCode ?? -1) !== 0) throw new Error(syncText(result.stderr || result.stdout || "unknown error").trim());
    return `cores 0..${n - 1}`;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`bench: could not pin server to ${n} cores: ${detail}`);
    return `failed: ${detail}`;
  }
}

export interface RunningServer {
  proc: ReturnType<typeof Bun.spawn>;
  url: string;
  pinNote: string;
  logs(): Promise<{ stdout: string; stderr: string }>;
  stop(): Promise<void>;
}

/** Start src/server/main.ts, pin it to `cores`, wait until /api/project answers. */
export async function startServer(repoDir: string, port: number, cores: number): Promise<RunningServer> {
  const projectRoot = join(import.meta.dir, "..", "..");
  const entry = join(projectRoot, "src", "server", "main.ts");
  const proc = Bun.spawn(
    [process.execPath, entry, "--repo", repoDir, "--port", String(port), "--join-limit", "0"],
    { cwd: projectRoot, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );

  const stdoutPromise = proc.stdout ? new Response(proc.stdout).text() : Promise.resolve("");
  const stderrPromise = proc.stderr ? new Response(proc.stderr).text() : Promise.resolve("");
  let cachedLogs: Promise<{ stdout: string; stderr: string }> | undefined;

  const pinNote = await pinProcess(proc.pid, cores);
  const url = `http://127.0.0.1:${port}`;
  const getLogs = () => cachedLogs ??= Promise.all([stdoutPromise, stderrPromise]).then(([stdout, stderr]) => ({ stdout, stderr }));
  try {
    await waitForProject(url, proc, getLogs);
  } catch (error) {
    const detail = await getLogs();
    try { proc.kill(); } catch { /* already gone */ }
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n` +
      `--- server stdout ---\n${detail.stdout.slice(-2000)}\n--- server stderr ---\n${detail.stderr.slice(-2000)}`,
    );
  }

  return {
    proc,
    url,
    pinNote,
    logs: () => cachedLogs ?? Promise.all([stdoutPromise, stderrPromise]).then(([stdout, stderr]) => ({ stdout, stderr })),
    stop: async () => {
      try {
        proc.kill();
      } catch {
        // already gone
      }
      await Promise.race([proc.exited.catch(() => undefined), sleep(3000)]);
    },
  };
}

/** Poll GET /api/project until the server is ready or the deadline expires. */
export async function waitForProject(
  url: string,
  proc?: ReturnType<typeof Bun.spawn>,
  logs?: () => Promise<{ stdout: string; stderr: string }>,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";
  while (Date.now() < deadline) {
    if (proc && proc.exitCode !== null) {
      const detail = logs ? await logs() : { stdout: "", stderr: "" };
      throw new Error(`server exited with code ${proc.exitCode}: ${detail.stderr.slice(-2000)}`);
    }
    try {
      const res = await fetch(`${url}/api/project`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(200);
  }
  throw new Error(`server did not answer GET /api/project within ${timeoutMs} ms (${lastError})`);
}
