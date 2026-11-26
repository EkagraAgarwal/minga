/**
 * Verifies signed requests (scheme in core/protocol.ts) and rate-limits agents.
 */
import { HEADER, MAX_CLOCK_SKEW_MS } from "../core/protocol.ts";
import type { AgentId } from "../core/types.ts";
import { agentIdFromPublicKey, canonicalRequest, verifyMessage } from "../identity/keys.ts";

export class HttpError extends Error {
  constructor(public status: number, message: string, public detail?: string) {
    super(message);
  }
}

/** Remembers nonces for the skew window so a captured request cannot be replayed. */
export class NonceCache {
  // Insertion order is expiry order (every entry lives the same time), so pruning only
  // ever looks at the oldest entries: amortized O(1) per request at any scale.
  private seen = new Map<string, number>();
  check(agent: string, nonce: string, nowMs: number): boolean {
    this.prune(nowMs);
    const key = `${agent}:${nonce}`;
    if (this.seen.has(key)) return false;
    this.seen.set(key, nowMs + 2 * MAX_CLOCK_SKEW_MS);
    return true;
  }
  prune(nowMs: number): void {
    for (const [k, exp] of this.seen) {
      if (exp > nowMs) break;
      this.seen.delete(k);
    }
  }
  get size(): number { return this.seen.size; }
}

/** Simple token bucket per agent: `perMinute` requests, burst of the same size. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private perMinute: number) {}
  take(key: string, nowMs: number): boolean {
    const b = this.buckets.get(key) ?? { tokens: this.perMinute, at: nowMs };
    b.tokens = Math.min(this.perMinute, b.tokens + ((nowMs - b.at) / 60_000) * this.perMinute);
    b.at = nowMs;
    if (b.tokens < 1) { this.buckets.set(key, b); return false; }
    b.tokens -= 1;
    this.buckets.set(key, b);
    return true;
  }
}

export interface AuthInput {
  req: Request;
  body: string;
  nowMs: number;
  nonces: NonceCache;
  /** Public key for a known agent id, or undefined. */
  lookup: (agent: AgentId) => string | undefined;
  /** For /api/join: the public key the body claims. */
  claimedPublicKey?: string;
}

/** Returns the verified agent id or throws HttpError(401). */
export function authenticate({ req, body, nowMs, nonces, lookup, claimedPublicKey }: AuthInput): AgentId {
  const agent = req.headers.get(HEADER.agent);
  const ts = req.headers.get(HEADER.ts);
  const nonce = req.headers.get(HEADER.nonce);
  const sig = req.headers.get(HEADER.sig);
  if (!agent || !ts || !nonce || !sig) throw new HttpError(401, "unsigned request", "send x-minga-agent, -ts, -nonce and -sig headers");
  if (!/^[0-9a-f]{16}$/.test(agent)) throw new HttpError(401, "bad agent id");
  if (!/^[0-9a-f]{16}$/.test(nonce)) throw new HttpError(401, "bad nonce");
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(nowMs - tsNum) > MAX_CLOCK_SKEW_MS) throw new HttpError(401, "clock skew too large", "check your system clock");

  let publicKey: string | undefined;
  if (claimedPublicKey !== undefined) {
    let derived: string;
    try { derived = agentIdFromPublicKey(claimedPublicKey); } catch { throw new HttpError(400, "bad public key"); }
    if (derived !== agent) throw new HttpError(401, "agent id does not match public key");
    publicKey = claimedPublicKey;
  } else {
    publicKey = lookup(agent);
    if (!publicKey) throw new HttpError(401, "unknown agent", "run join first");
  }

  const path = new URL(req.url).pathname;
  if (!verifyMessage(publicKey, canonicalRequest(req.method, path, ts, nonce, body), sig)) throw new HttpError(401, "bad signature");
  if (!nonces.check(agent, nonce, nowMs)) throw new HttpError(401, "replayed request");
  return agent;
}
