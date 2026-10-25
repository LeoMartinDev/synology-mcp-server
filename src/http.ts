import {
  type AuthInfo,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  McpServer,
  oauthMetadataResponse,
  requireBearerAuth,
} from "@modelcontextprotocol/server";
import type { Config } from "./config";
import { DsmAccounts } from "./oauth/accounts";
import { AuthorizationServer, SCOPE } from "./oauth/server";
import { OAuthStore } from "./oauth/store";
import type { PermissionsSource } from "./permissions";
import type { SynologyClient } from "./synology/client";
import { registerAllTools } from "./tools";
import { type AuditLog, Toolbox } from "./tools/toolbox";
import { VERSION } from "./version";

export interface HttpApp {
  fetch(request: Request, socketIp: string): Promise<Response>;
  authorizationServer: AuthorizationServer;
}

/**
 * The remote server: OAuth discovery documents, the authorization server (/oauth/*), and the MCP
 * endpoint (/mcp), where each request gets the tools the permissions file allows at that moment.
 */
export function createHttpApp(
  config: Config,
  client: SynologyClient,
  audit: AuditLog,
  store: OAuthStore,
  permissions: PermissionsSource,
  now?: () => number,
): HttpApp {
  const issuer = new URL(config.http.publicUrl!);
  const resource = new URL("/mcp", issuer);
  const accounts = new DsmAccounts(client, config.username, () => permissions.load());
  const authorizationServer = new AuthorizationServer({
    issuer,
    resource,
    store,
    accounts,
    redirectUris: config.http.redirectUris,
    globalSignInLimit: config.http.globalSignInLimit,
    now,
  });

  const metadataOptions = {
    oauthMetadata: authorizationServer.metadata(),
    resourceServerUrl: resource,
    scopesSupported: [SCOPE],
    resourceName: "Synology NAS",
    dangerouslyAllowInsecureIssuerUrl: issuer.protocol === "http:",
  };
  const requireToken = requireBearerAuth({
    verifier: authorizationServer.verifier,
    expectedResource: resource,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource),
  });

  const mcp = createMcpHandler(
    async ({ authInfo }) => {
      const user = principal(authInfo);
      const server = new McpServer({ name: "synology", version: VERSION }, { capabilities: { tools: {} } });
      const { domains } = await permissions.load();
      registerAllTools(new Toolbox({ server, client, permissions: domains, audit, user }));
      return server;
    },
    { onerror: (err) => console.error(`[mcp] ${err.message}`) },
  );

  const clientIp = (request: Request, socketIp: string) => {
    if (!config.http.trustProxy) return socketIp;
    const forwarded = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
    return request.headers.get("x-real-ip") ?? forwarded ?? socketIp;
  };

  return {
    authorizationServer,
    async fetch(request, socketIp) {
      const { pathname } = new URL(request.url);
      // Readable from any origin: the DSM app checks the public address answers.
      if (pathname === "/health") return new Response("ok", { headers: { "access-control-allow-origin": "*" } });

      const metadata = oauthMetadataResponse(request, metadataOptions);
      if (metadata) return metadata;

      const oauth = await authorizationServer.handle(request, clientIp(request, socketIp));
      if (oauth) return oauth;

      if (pathname === "/mcp") {
        const auth = await requireToken(request);
        if (auth instanceof Response) return auth;
        return mcp.fetch(request, { authInfo: auth });
      }
      return new Response("Not found", { status: 404 });
    },
  };
}

function principal(authInfo: AuthInfo | undefined): string {
  const user = authInfo?.extra?.user;
  if (typeof user !== "string") throw new Error("MCP request without a verified user");
  return user;
}

export interface RunningHttpServer {
  store: OAuthStore;
  stop(): Promise<void>;
}

export async function serveHttp(
  config: Config,
  client: SynologyClient,
  audit: AuditLog,
  permissions: PermissionsSource,
): Promise<RunningHttpServer> {
  const store = await OAuthStore.open(config.dataDir);
  const app = createHttpApp(config, client, audit, store, permissions);
  const server = Bun.serve({
    hostname: config.http.host,
    port: config.http.port,
    // Long tool calls (dir_size, file_search) answer only when done; 255 s is Bun's maximum.
    idleTimeout: 255,
    // Above the MCP handler's own 4 MiB limit (file_write content), well below Bun's 128 MiB default.
    maxRequestBodySize: 8 * 1024 * 1024,
    fetch: (request, srv) => app.fetch(request, srv.requestIP(request)?.address ?? "unknown"),
    error: (err) => {
      console.error(`[http] ${err.stack ?? err.message}`);
      return new Response("Internal error", { status: 500 });
    },
  });
  console.error(
    `[synology] ${config.url} — OAuth MCP server on ${server.url} (public: ${config.http.publicUrl}/mcp), rights from ${permissions.path}`,
  );
  return {
    store,
    async stop() {
      await server.stop(true);
      await store.save();
    },
  };
}
