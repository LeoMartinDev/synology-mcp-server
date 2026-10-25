import { z } from "zod";
import { PublicUrlSchema } from "../config";
import { FAMILY_TTL, REFRESH_TTL } from "../oauth/server";
import { DOMAINS, PERMISSIONS, type PermissionsFile } from "../permissions";
import { VERSION } from "../version";
import type { AdminAuthenticator } from "./auth";
import { AccountError, type McpService } from "./service";
import type { SettingsFile } from "./settings";

/** Where DSM's web server forwards the app's requests (see package/target/nginx). */
export const ADMIN_PREFIX = "/synology-mcp/api";

const MAX_BODY = 64 * 1024;
const AUDIT_TAIL_BYTES = 512 * 1024;

const AccountSchema = z.object({
  username: z.string().trim().min(1).max(64),
  /** Left out to keep the saved password (same account). */
  password: z.string().min(1).max(256).optional(),
  otpCode: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Le code de validation en deux étapes a 6 chiffres.")
    .optional()
    .or(z.literal("").transform(() => undefined)),
});

const PublicUrlBody = z.object({ publicUrl: PublicUrlSchema });

const PermissionsBody = z.object({
  domains: z.object(Object.fromEntries(DOMAINS.map((d) => [d, z.enum(PERMISSIONS)]))),
  allowedUsers: z.array(z.string().trim().min(1).max(64)).max(100).optional(),
});

export interface AdminOptions {
  auth: AdminAuthenticator;
  service: McpService;
  settings: SettingsFile;
  permissions: PermissionsFile;
  now?: () => number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });

async function readBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  // A JSON content type cannot be sent by a plain HTML form: another site cannot post here.
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new HttpError(415, "JSON attendu.");
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, "Requête trop grande.");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new HttpError(400, "JSON invalide.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => i.message).join(" "));
  return parsed.data;
}

/**
 * The API of the DSM app (package/target/ui): status, service account, public address, rights, sessions,
 * audit log. Reached only through DSM's web server, for DSM administrators.
 */
export function createAdminApp(options: AdminOptions) {
  const { auth, service, settings, permissions } = options;
  const now = options.now ?? Date.now;

  const state = async () => {
    const saved = await settings.load();
    return {
      version: VERSION,
      status: service.status,
      account: saved.username ? { username: saved.username, twoFactor: Boolean(saved.deviceId) } : null,
      publicUrl: saved.publicUrl ?? null,
      mcpUrl: saved.publicUrl ? `${saved.publicUrl}/mcp` : null,
      backendPort: service.port,
    };
  };

  const routes: Record<string, (request: Request, user: string, rest: string) => Promise<Response>> = {
    "GET /state": async () => json(await state()),

    "PUT /account": async (request, user) => {
      const body = await readBody(request, AccountSchema);
      const saved = await settings.load();
      const sameAccount = saved.username?.toLowerCase() === body.username.toLowerCase();
      const password = body.password ?? (sameAccount ? saved.password : undefined);
      if (!password) throw new HttpError(400, "Saisissez le mot de passe du compte.");
      const deviceId = await service.verifyAccount(
        body.username,
        password,
        body.otpCode,
        sameAccount ? saved.deviceId : undefined,
      );
      await settings.update({ username: body.username, password, deviceId });
      console.error(`[package] ${user} set the service account to ${body.username}`);
      await service.restart();
      return json(await state());
    },

    "PUT /public-url": async (request, user) => {
      const { publicUrl } = await readBody(request, PublicUrlBody);
      await settings.update({ publicUrl });
      console.error(`[package] ${user} set the public address to ${publicUrl}`);
      await service.restart();
      return json(await state());
    },

    "POST /restart": async () => {
      await service.restart();
      return json(await state());
    },

    "GET /permissions": async () => json(await permissions.load()),

    "PUT /permissions": async (request, user) => {
      const body = await readBody(request, PermissionsBody);
      const allowedUsers = body.allowedUsers?.length ? [...new Set(body.allowedUsers)] : undefined;
      await permissions.save({ domains: body.domains as never, allowedUsers });
      console.error(`[package] ${user} changed the rights`);
      return json(await permissions.load());
    },

    "GET /sessions": async () => {
      const store = service.store;
      if (!store) return json([]);
      const families = new Map<string, { family: string; user: string; client: string; signedInAt: number; lastUsedAt: number; endsAt: number }>();
      for (const grant of store.refreshGrants.values()) {
        if (grant.usedAt || grant.expiresAt <= now()) continue;
        const client = store.clients.get(grant.clientId)?.metadata.client_name ?? grant.clientId;
        const lastUsedAt = grant.expiresAt - REFRESH_TTL;
        const known = families.get(grant.family);
        if (known && known.lastUsedAt >= lastUsedAt) continue;
        families.set(grant.family, {
          family: grant.family,
          user: grant.user,
          client,
          signedInAt: grant.familyExpiresAt - FAMILY_TTL,
          lastUsedAt,
          endsAt: Math.min(grant.familyExpiresAt, grant.expiresAt),
        });
      }
      return json([...families.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt));
    },

    "DELETE /sessions/": async (_request, user, family) => {
      const store = service.store;
      if (!store || !family) throw new HttpError(404, "Session inconnue.");
      store.revokeFamily(family);
      await store.save();
      console.error(`[package] ${user} revoked a session`);
      return json({ ok: true });
    },

    "GET /audit": async (request) => {
      const limit = Math.min(Math.max(Number(new URL(request.url).searchParams.get("limit")) || 200, 1), 1000);
      return json(await auditTail(service.auditFile, limit));
    },
  };

  return {
    async fetch(request: Request, remoteIp: string): Promise<Response> {
      const { pathname } = new URL(request.url);
      if (!pathname.startsWith(`${ADMIN_PREFIX}/`)) return json({ error: "Introuvable." }, 404);
      const path = pathname.slice(ADMIN_PREFIX.length);
      const match =
        routes[`${request.method} ${path}`] ??
        Object.entries(routes).find(([key]) => key.endsWith("/") && `${request.method} ${path}`.startsWith(key))?.[1];
      if (!match) return json({ error: "Introuvable." }, 404);

      const who = await auth.check(request, remoteIp);
      if ("refused" in who) {
        return who.refused === "not-admin"
          ? json({ error: "Réservé aux administrateurs DSM." }, 403)
          : json({ error: "Session DSM expirée : reconnectez-vous à DSM." }, 401);
      }
      const rest = decodeURIComponent(path.slice(path.indexOf("/", 1) + 1));
      try {
        return await match(request, who.user, rest);
      } catch (err) {
        if (err instanceof HttpError) return json({ error: err.message }, err.status);
        if (err instanceof AccountError) return json({ error: err.message }, 400);
        console.error(`[package] ${request.method} ${path}: ${(err as Error).stack ?? err}`);
        return json({ error: (err as Error).message }, 500);
      }
    },
  };
}

/** The last lines of the audit log, newest first. */
async function auditTail(file: string, limit: number): Promise<unknown[]> {
  const handle = Bun.file(file);
  if (!(await handle.exists())) return [];
  const size = handle.size;
  const text = await handle.slice(Math.max(0, size - AUDIT_TAIL_BYTES), size).text();
  const lines = text.split("\n").filter(Boolean);
  if (size > AUDIT_TAIL_BYTES) lines.shift(); // the first one is cut
  const entries: unknown[] = [];
  for (const line of lines.slice(-limit).reverse()) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A line cut by a crash: skip it.
    }
  }
  return entries;
}
