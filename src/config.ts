import { join } from "node:path";
import { z } from "zod";
import { base32Decode, parseTotpSecret } from "./totp";

/** The project's data folder, so a server launched from any directory (stdio) finds the same files. */
const DEFAULT_DATA_DIR = join(import.meta.dir, "..", "data");

const flag = (fallback: boolean) =>
  z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .optional()
    .transform((v) => (v === undefined ? fallback : ["true", "1", "yes"].includes(v)));

const isValidTotpSecret = (value: string) => {
  try {
    return base32Decode(parseTotpSecret(value)).length > 0;
  } catch {
    return false;
  }
};

/**
 * Where OAuth clients may send users back to: claude.ai's connector callback, and any local port for
 * Claude Code. A trailing `*` matches any port; anything else must match exactly.
 */
export const DEFAULT_REDIRECT_URIS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
  "http://localhost:*",
  "http://127.0.0.1:*",
];

const list = (fallback: string[]) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? fallback : v.split(",").map((s) => s.trim()).filter(Boolean)));

/** The public address of the HTTP server: an origin (OAuth discovery lives at the root), https unless local. */
export const PublicUrlSchema = z
  .url({ protocol: /^https?$/ })
  .refine((u) => new URL(u).pathname === "/", "must be an origin without a path, e.g. https://nas.example.com:8443")
  .refine((u) => {
    const { protocol, hostname } = new URL(u);
    return protocol === "https:" || hostname === "localhost" || hostname === "127.0.0.1";
  }, "must use https (plain http is only accepted for localhost, to try the server out)")
  .transform((u) => u.replace(/\/+$/, ""));

const EnvSchema = z.object({
  SYNO_URL: z.url().transform((u) => u.replace(/\/+$/, "")),
  SYNO_USERNAME: z.string({ error: "set SYNO_USERNAME or SYNO_USERNAME_COMMAND" }).min(1),
  SYNO_PASSWORD: z.string({ error: "set SYNO_PASSWORD or SYNO_PASSWORD_COMMAND" }).min(1),
  SYNO_DEVICE_ID: z.string().optional(),
  SYNO_OTP_COMMAND: z.string().optional(),
  SYNO_TOTP_SECRET: z
    .string()
    .refine(isValidTotpSecret, "must be a base32 secret or an otpauth:// URI")
    .optional(),
  SYNO_DEVICE_NAME: z.string().default("SynologyMCP"),
  SYNO_SESSION: z.string().default("webui"),
  SYNO_INSECURE_TLS: flag(false),
  SYNO_AUDIT_LOG: z.string().optional(),
  SYNO_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  SYNO_DEBUG: flag(false),
  SYNO_TRANSPORT: z.enum(["stdio", "http"]).default("stdio"),
  SYNO_PUBLIC_URL: PublicUrlSchema.optional(),
  SYNO_HTTP_HOST: z.string().default("0.0.0.0"),
  SYNO_HTTP_PORT: z.coerce.number().int().min(0).max(65535).default(8080), // 0: any free port (tests)
  SYNO_DATA_DIR: z.string().default(DEFAULT_DATA_DIR),
  SYNO_PERMISSIONS_FILE: z.string().optional(),
  SYNO_OAUTH_REDIRECT_URIS: list(DEFAULT_REDIRECT_URIS),
  SYNO_TRUST_PROXY: flag(false),
  SYNO_SIGNIN_GLOBAL_LIMIT: z.coerce.number().int().min(0).default(8),
}).refine((e) => e.SYNO_TRANSPORT !== "http" || e.SYNO_PUBLIC_URL, {
  path: ["SYNO_PUBLIC_URL"],
  message: "required with SYNO_TRANSPORT=http: the public HTTPS address of the server",
});

export interface Config {
  url: string;
  username: string;
  password: string;
  deviceId?: string;
  /** Command printing a fresh 2FA code, run at each login that has no device token. */
  otpCommand?: string;
  /** Base32 TOTP secret (or otpauth:// URI) from which 2FA codes are computed locally. */
  totpSecret?: string;
  deviceName: string;
  session: string;
  insecureTls: boolean;
  auditLog?: string;
  timeoutMs: number;
  debug: boolean;
  /** stdio: one local client launches the server; http: remote clients sign in with OAuth. */
  transport: "stdio" | "http";
  /** Holds the permissions file and, over HTTP, the OAuth state. */
  dataDir: string;
  /** What each part of the server may do (see src/permissions.ts). */
  permissionsFile: string;
  /** SYNO_ACCESS was set: it no longer does anything, the permissions file replaced it. */
  legacyAccess?: string;
  http: HttpConfig;
}

export interface HttpConfig {
  /** Public base URL clients reach the server at, e.g. https://nas.example.com:8443 (http transport only). */
  publicUrl?: string;
  host: string;
  port: number;
  redirectUris: string[];
  /** Take the client IP from X-Real-IP / X-Forwarded-For, set by the reverse proxy in front. */
  trustProxy: boolean;
  /**
   * Failed sign-ins allowed across all accounts per 5 minutes, below DSM's auto-block threshold;
   * 0 disables it, once the server's address is on DSM's auto-block allow list.
   */
  globalSignInLimit: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // Treat empty variables as unset so a blank line in .env falls back to the default.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}\nSee .env.example.`);
  }
  const e = parsed.data;
  return {
    url: e.SYNO_URL,
    username: e.SYNO_USERNAME,
    password: e.SYNO_PASSWORD,
    deviceId: e.SYNO_DEVICE_ID,
    otpCommand: e.SYNO_OTP_COMMAND,
    totpSecret: e.SYNO_TOTP_SECRET,
    deviceName: e.SYNO_DEVICE_NAME,
    session: e.SYNO_SESSION,
    insecureTls: e.SYNO_INSECURE_TLS,
    auditLog: e.SYNO_AUDIT_LOG,
    timeoutMs: e.SYNO_TIMEOUT_MS,
    debug: e.SYNO_DEBUG,
    transport: e.SYNO_TRANSPORT,
    dataDir: e.SYNO_DATA_DIR,
    permissionsFile: e.SYNO_PERMISSIONS_FILE ?? join(e.SYNO_DATA_DIR, "permissions.yml"),
    legacyAccess: cleaned.SYNO_ACCESS,
    http: {
      publicUrl: e.SYNO_PUBLIC_URL,
      host: e.SYNO_HTTP_HOST,
      port: e.SYNO_HTTP_PORT,
      redirectUris: e.SYNO_OAUTH_REDIRECT_URIS,
      trustProxy: e.SYNO_TRUST_PROXY,
      globalSignInLimit: e.SYNO_SIGNIN_GLOBAL_LIMIT,
    },
  };
}
