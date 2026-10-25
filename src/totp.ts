// RFC 6238 time-based one-time passwords (SHA-1, 30 s, 6 digits: what DSM uses).

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(input: string): Uint8Array<ArrayBuffer> {
  const clean = input.toUpperCase().replace(/[\s=-]/g, "");
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error("TOTP secret is not valid base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

/** Accepts a bare base32 secret or an otpauth:// URI (as encoded in the 2FA QR code). */
export function parseTotpSecret(input: string): string {
  if (!input.startsWith("otpauth://")) return input;
  const secret = new URL(input).searchParams.get("secret");
  if (!secret) throw new Error("otpauth URI has no secret parameter");
  return secret;
}

export async function totp(secret: string, now = Date.now(), digits = 6, stepSeconds = 30): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    base32Decode(parseTotpSecret(secret)),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const counter = new DataView(new ArrayBuffer(8));
  counter.setBigUint64(0, BigInt(Math.floor(now / 1000 / stepSeconds)));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter.buffer));
  const offset = mac[mac.length - 1]! & 0x0f;
  const code =
    ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(code % 10 ** digits).padStart(digits, "0");
}
