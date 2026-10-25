import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** An unguessable opaque token (256 bits by default). */
export const newToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** Tokens are stored by hash only, so a leaked state file grants nothing. */
export const hashToken = (token: string) => createHash("sha256").update(token).digest("base64url");

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

/** RFC 7636, S256 method: BASE64URL(SHA256(code_verifier)) must equal the code_challenge. */
export function verifyPkce(verifier: string, challenge: string): boolean {
  return VERIFIER.test(verifier) && safeEqual(createHash("sha256").update(verifier).digest("base64url"), challenge);
}
