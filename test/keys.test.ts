import { describe, expect, test } from "bun:test";
import {
  agentIdFromPublicKey, canonicalRequest, formatHeadKey, generateKeyPair, parseHeadKey,
  signMessage, signRequest, verifyMessage,
} from "../src/identity/keys.ts";
import { HEADER } from "../src/core/protocol.ts";

describe("keys", () => {
  test("ids are stable 16-hex and differ per key", () => {
    const a = generateKeyPair(), b = generateKeyPair();
    expect(agentIdFromPublicKey(a.publicKey)).toMatch(/^[0-9a-f]{16}$/);
    expect(agentIdFromPublicKey(a.publicKey)).toBe(agentIdFromPublicKey(a.publicKey));
    expect(agentIdFromPublicKey(a.publicKey)).not.toBe(agentIdFromPublicKey(b.publicKey));
  });

  test("sign and verify round trip, tamper fails", () => {
    const k = generateKeyPair();
    const sig = signMessage(k.privateKey, "hello");
    expect(verifyMessage(k.publicKey, "hello", sig)).toBe(true);
    expect(verifyMessage(k.publicKey, "hellO", sig)).toBe(false);
    expect(verifyMessage(generateKeyPair().publicKey, "hello", sig)).toBe(false);
    expect(verifyMessage(k.publicKey, "hello", "garbage")).toBe(false);
  });

  test("signed request headers verify against the canonical string", () => {
    const k = generateKeyPair();
    const body = JSON.stringify({ a: 1 });
    const h = signRequest(k, "post", "/api/next", body, 1_700_000_000_000);
    expect(h[HEADER.agent]).toBe(agentIdFromPublicKey(k.publicKey));
    const canon = canonicalRequest("POST", "/api/next", h[HEADER.ts]!, h[HEADER.nonce]!, body);
    expect(verifyMessage(k.publicKey, canon, h[HEADER.sig]!)).toBe(true);
    const other = canonicalRequest("POST", "/api/next", h[HEADER.ts]!, h[HEADER.nonce]!, body + " ");
    expect(verifyMessage(k.publicKey, other, h[HEADER.sig]!)).toBe(false);
  });

  test("head key format round trips and rejects junk", () => {
    const k = generateKeyPair();
    expect(parseHeadKey(formatHeadKey(k.publicKey))).toBe(k.publicKey);
    expect(() => parseHeadKey("rsa:abc")).toThrow();
    expect(() => parseHeadKey("ed25519:short")).toThrow();
  });
});
