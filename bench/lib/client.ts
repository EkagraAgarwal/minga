/**
 * Signed, keep-alive HTTP client for the Minga v2 protocol.
 *
 * POST bodies are signed over the exact bytes sent (pathname only, no query),
 * using the same scheme as src/cli/client.ts. This harness talks only to the
 * public protocol: it does not import anything from src/server.
 */

import { signRequest, type KeyPair } from "../../src/identity/keys.ts";

export function sleep(ms: number): Promise<void> {
  const delay = Math.max(0, ms);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

export interface FetchResult<T> {
  status: number;
  ok: boolean;
  body?: T;
  error?: string;
  latencyMs: number;
  retries: number;
}

function retryDelay(header: string | null): number {
  if (header) {
    const seconds = Number(header.trim());
    if (Number.isFinite(seconds)) return Math.min(30_000, Math.max(200, seconds * 1000));
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.min(30_000, Math.max(200, date - Date.now()));
  }
  return 2000;
}

function errorMessage(raw: string, status: number): string {
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; detail?: unknown };
    if (typeof parsed.error === "string" && parsed.error.length > 0) return parsed.error;
    if (typeof parsed.detail === "string" && parsed.detail.length > 0) return parsed.detail;
  } catch {
    // not JSON
  }
  return raw.trim() || `HTTP ${status}`;
}

/**
 * One request, with up to 3 retries on 429 (honouring Retry-After, else 2 s).
 * Transport failures return status 0 instead of throwing so the harness can
 * keep counting errors without losing an agent loop.
 */
export async function apiRequest<T>(
  baseUrl: string,
  keys: KeyPair | undefined,
  method: "GET" | "POST",
  path: string,
  body: unknown = undefined,
  timeoutMs = 60_000,
): Promise<FetchResult<T>> {
  const url = `${baseUrl}${path}`;
  const raw = method === "POST" ? JSON.stringify(body ?? {}) : undefined;
  const started = performance.now();

  for (let attempt = 0; ; attempt++) {
    const headers: Record<string, string> = { connection: "keep-alive" };
    if (method === "POST") {
      headers["content-type"] = "application/json";
      if (!keys) throw new Error("apiRequest: POST requires a key pair");
      Object.assign(headers, signRequest(keys, "POST", new URL(url).pathname, raw ?? ""));
    } else {
      headers.accept = "application/json";
    }

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: raw,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      const latencyMs = performance.now() - started;
      if (res.status === 429 && attempt < 3) {
        await sleep(retryDelay(res.headers.get("retry-after")));
        continue;
      }
      const ok = res.ok;
      let parsed: T | undefined;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text) as T;
        } catch {
          return { status: res.status, ok: false, error: `invalid JSON: ${text.slice(0, 120)}`, latencyMs, retries: attempt };
        }
      }
      return {
        status: res.status,
        ok,
        ...(parsed === undefined ? {} : { body: parsed }),
        ...(ok ? {} : { error: errorMessage(text, res.status) }),
        latencyMs,
        retries: attempt,
      };
    } catch (error) {
      return {
        status: 0,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        latencyMs: performance.now() - started,
        retries: attempt,
      };
    }
  }
}
