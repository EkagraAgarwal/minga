/**
 * Agent identity: ed25519 keys, agent ids, request signing.
 * Uses node:crypto only, so the CLI kit can be bundled for plain Node.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { HEADER } from "../core/protocol.ts";
import type { AgentId } from "../core/types.ts";

export interface KeyPair {
  /** base64url of the raw 32-byte public key. */
  publicKey: string;
  /** base64url of the PKCS#8 DER private key. */
  privateKey: string;
}

/** DER prefix of an SPKI-wrapped ed25519 public key; the raw 32 bytes follow it. */
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const b64u = (buf: Uint8Array): string => Buffer.from(buf).toString("base64url");
const fromB64u = (s: string): Buffer => Buffer.from(s, "base64url");

export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return {
    publicKey: b64u(spki.subarray(SPKI_PREFIX.length)),
    privateKey: b64u(privateKey.export({ format: "der", type: "pkcs8" })),
  };
}

function publicKeyObject(publicKey: string) {
  const raw = fromB64u(publicKey);
  if (raw.length !== 32) throw new Error("public key must be 32 raw bytes (base64url)");
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

/** Throws when the string is not a valid base64url ed25519 public key. */
export function assertPublicKey(publicKey: string): void {
  publicKeyObject(publicKey);
}

export function agentIdFromPublicKey(publicKey: string): AgentId {
  const raw = fromB64u(publicKey);
  if (raw.length !== 32) throw new Error("public key must be 32 raw bytes (base64url)");
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

export function signMessage(privateKey: string, message: string): string {
  const key = createPrivateKey({ key: fromB64u(privateKey), format: "der", type: "pkcs8" });
  return b64u(sign(null, Buffer.from(message, "utf8"), key));
}

export function verifyMessage(publicKey: string, message: string, signature: string): boolean {
  try {
    return verify(null, Buffer.from(message, "utf8"), publicKeyObject(publicKey), fromB64u(signature));
  } catch {
    return false;
  }
}

export function sha256Hex(body: string | Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

export function canonicalRequest(method: string, path: string, ts: string, nonce: string, body: string): string {
  return `${method.toUpperCase()}\n${path}\n${ts}\n${nonce}\n${sha256Hex(body)}`;
}

/** Headers for a signed request. `path` is the URL pathname only. */
export function signRequest(keys: KeyPair, method: string, path: string, body: string, now: number = Date.now()): Record<string, string> {
  const ts = String(now);
  const nonce = randomBytes(8).toString("hex");
  return {
    [HEADER.agent]: agentIdFromPublicKey(keys.publicKey),
    [HEADER.ts]: ts,
    [HEADER.nonce]: nonce,
    [HEADER.sig]: signMessage(keys.privateKey, canonicalRequest(method, path, ts, nonce, body)),
  };
}

/** "ed25519:<base64url>" -> base64url raw public key. Throws on a bad prefix or key. */
export function parseHeadKey(text: string): string {
  const m = /^ed25519:([A-Za-z0-9_-]{43})$/.exec(text.trim());
  if (!m || !m[1]) throw new Error('head must look like "ed25519:<43 base64url chars>"');
  assertPublicKey(m[1]);
  return m[1];
}

export function formatHeadKey(publicKey: string): string {
  return `ed25519:${publicKey}`;
}
