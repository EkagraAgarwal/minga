/**
 * Read-only git over HTTP for the project repository, so volunteers can
 *   git clone <server>/repo.git && git pull
 * and work on the real files (check script, tests, code) before submitting.
 *
 * Wraps `git http-backend` (smart HTTP, CGI). Only fetch is served: git-upload-pack.
 * Pushes (git-receive-pack) are refused — accepted work reaches the branch only through
 * the check queue. `.minga/` is git-ignored, so server state never leaves the machine.
 */
const PREFIX = "/repo.git";

export function isGitRequest(pathname: string): boolean {
  return pathname === PREFIX || pathname.startsWith(`${PREFIX}/`);
}

const forbidden = (msg: string) => new Response(`${msg}\n`, { status: 403, headers: { "content-type": "text/plain" } });

export async function serveGit(req: Request, repoDir: string): Promise<Response> {
  const url = new URL(req.url);
  const rest = url.pathname.slice(PREFIX.length) || "/";
  const service = url.searchParams.get("service");
  if (service === "git-receive-pack" || rest.endsWith("/git-receive-pack")) {
    return forbidden("this repository is read-only: submit work with `minga submit`");
  }
  const allowed = (rest === "/info/refs" && service === "git-upload-pack") || (rest === "/git-upload-pack" && req.method === "POST");
  if (!allowed) return forbidden("only smart-HTTP fetch is served (git clone / git fetch)");

  const body = req.method === "POST" ? new Uint8Array(await req.arrayBuffer()) : undefined;
  const proc = Bun.spawn(["git", "http-backend"], {
    cwd: repoDir,
    stdin: body ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? process.env.Path ?? "",
      ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
      GIT_PROJECT_ROOT: repoDir,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: `/.git${rest}`,
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: req.method,
      CONTENT_TYPE: req.headers.get("content-type") ?? "",
      CONTENT_LENGTH: body ? String(body.byteLength) : "",
      HTTP_CONTENT_ENCODING: req.headers.get("content-encoding") ?? "",
      GIT_PROTOCOL: req.headers.get("git-protocol") ?? "",
      REMOTE_ADDR: "127.0.0.1",
    },
  });
  const out = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  await proc.exited;

  // CGI output: headers, a blank line, then the body.
  let split = -1;
  for (let i = 0; i + 3 < out.length; i++) {
    if (out[i] === 13 && out[i + 1] === 10 && out[i + 2] === 13 && out[i + 3] === 10) { split = i; break; }
  }
  let sep = 4;
  if (split < 0) {
    for (let i = 0; i + 1 < out.length; i++) if (out[i] === 10 && out[i + 1] === 10) { split = i; sep = 2; break; }
  }
  if (split < 0) {
    const err = await new Response(proc.stderr).text();
    return new Response(`git http-backend failed: ${err.slice(0, 500)}\n`, { status: 500 });
  }
  const headers = new Headers();
  let status = 200;
  for (const line of new TextDecoder().decode(out.subarray(0, split)).split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const name = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (name.toLowerCase() === "status") status = Number.parseInt(value, 10) || 200;
    else headers.append(name, value);
  }
  return new Response(out.subarray(split + sep), { status, headers });
}
