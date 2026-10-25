import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PermissionsFile } from "../permissions";
import { createAdminApp } from "./admin";
import { DsmSessionAuth } from "./auth";
import { McpService } from "./service";
import { SettingsFile } from "./settings";

/** The SYNO_* variables of the environment, which override the package's defaults. */
export function synoOverrides(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((e): e is [string, string] => e[0].startsWith("SYNO_") && Boolean(e[1])),
  );
}

export function packageDataDir(env: Record<string, string | undefined>): string {
  const dir = env.SYNO_DATA_DIR ?? env.SYNOPKG_PKGVAR;
  if (!dir) throw new Error("SYNO_DATA_DIR (or SYNOPKG_PKGVAR) must name the package's data folder");
  return dir;
}

/**
 * `synology-mcp package`, started by the Synology package: the DSM app's API on localhost (behind DSM's
 * web server), and the MCP server once the service account and the public address are set.
 */
export async function runPackage(env: Record<string, string | undefined> = process.env): Promise<void> {
  const dataDir = packageDataDir(env);
  await mkdir(dataDir, { recursive: true });
  // Holds the service account's password and the OAuth state: for the package's own user only.
  await chmod(dataDir, 0o700).catch(() => {});

  const settings = new SettingsFile(join(dataDir, "settings.json"));
  const permissions = new PermissionsFile(join(dataDir, "permissions.yml"));
  await permissions.open();
  const overrides = synoOverrides(env);
  const service = new McpService({ dataDir, settings, permissions, env: overrides });
  const admin = createAdminApp({
    auth: new DsmSessionAuth(),
    service,
    settings,
    permissions,
  });

  const port = Number(env.SYNO_ADMIN_PORT || 8090);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    // Only DSM's web server reaches this port: it sets X-Real-IP, which authenticate.cgi checks.
    fetch: (request, srv) => admin.fetch(request, request.headers.get("x-real-ip") ?? srv.requestIP(request)?.address ?? ""),
    error: (err) => {
      console.error(`[package] ${err.stack ?? err.message}`);
      return new Response("Internal error", { status: 500 });
    },
  });
  console.error(`[package] DSM app API on ${server.url}, data in ${dataDir}`);

  const status = await service.restart();
  console.error(`[package] MCP server: ${status.state}${"error" in status && status.error ? ` (${status.error})` : ""}`);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      await service.stop().catch(() => {});
      await server.stop(true);
      process.exit(0);
    });
  }
}
