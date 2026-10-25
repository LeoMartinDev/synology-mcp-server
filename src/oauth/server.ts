import { OAuthClientMetadataSchema } from "@modelcontextprotocol/core";
import {
  type AuthInfo,
  type OAuthClientMetadata,
  OAuthError,
  OAuthErrorCode,
  type OAuthMetadata,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import type { DsmAccounts } from "./accounts";
import { SignInError } from "./accounts";
import { errorPage, signInPage } from "./page";
import { SlidingWindowLimiter } from "./ratelimit";
import type { OAuthStore, StoredClient } from "./store";
import { hashToken, newToken, safeEqual, verifyPkce } from "./tokens";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const ACCESS_TTL = 60 * MINUTE;
const REFRESH_TTL = 30 * DAY;
/** However often it is refreshed, a sign-in ends after this: people sign in again with DSM (and 2FA). */
const FAMILY_TTL = 90 * DAY;
const CODE_TTL = MINUTE;
const PENDING_TTL = 10 * MINUTE;
/** A refresh token presented again within this delay is refused without revoking its family (client retries). */
const REUSE_GRACE = 30_000;

// Bounds on what unauthenticated requests can make the server hold.
const MAX_CLIENTS = 200;
const MAX_PENDING = 1000;
const MAX_REGISTRATION_BYTES = 16 * 1024;
const MAX_REDIRECT_URIS = 10;
const MAX_STATE_LENGTH = 512;
const MAX_ATTEMPTS_PER_REQUEST = 5;

export const SCOPE = "mcp";

const AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"];
const GRANT_TYPES = ["authorization_code", "refresh_token"];
const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

export interface AuthorizationServerOptions {
  /** Public base URL, e.g. https://nas.example.com:8443 */
  issuer: URL;
  /** The protected MCP endpoint, the only resource tokens are issued for. */
  resource: URL;
  store: OAuthStore;
  accounts: DsmAccounts;
  /** Allowed redirect URIs; a pattern ending in `:*` accepts any port (and path) on that scheme and host. */
  redirectUris: string[];
  /** Failed sign-ins allowed across all accounts per 5 minutes; 0 disables this limit. */
  globalSignInLimit: number;
  now?: () => number;
}

interface PendingAuthorization {
  client: StoredClient;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  scope: string;
  attempts: number;
  expiresAt: number;
}

class TokenError extends Error {
  constructor(
    readonly error: string,
    description: string,
    readonly status = 400,
  ) {
    super(description);
  }
}

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", pragma: "no-cache" } });

const tokenError = (err: TokenError) => {
  const res = json({ error: err.error, error_description: err.message }, err.status);
  if (err.status === 401) res.headers.set("www-authenticate", 'Basic realm="oauth"');
  return res;
};

/** Attacker-controlled text in log lines: quoted (no forged lines) and short. */
const forLog = (value: string) => JSON.stringify(value.slice(0, 64));

/**
 * OAuth 2.1 authorization server for the MCP endpoint: dynamic client registration (RFC 7591), authorization
 * code with mandatory PKCE S256, rotating refresh tokens with reuse detection, revocation (RFC 7009).
 * People sign in with their DSM account; tokens are opaque and stored hashed.
 */
export class AuthorizationServer {
  private readonly pending = new Map<string, PendingAuthorization>();
  // All sign-ins reach DSM from this server's address. DSM's auto-block (10 failures in 5 minutes by
  // default) would then lock everybody out, the service account included: the global limit stays below it
  // unless that address is on DSM's allow list.
  private readonly failuresPerIp = new SlidingWindowLimiter(5, 15 * MINUTE);
  private readonly failuresPerAccount = new SlidingWindowLimiter(5, 15 * MINUTE);
  private readonly failuresOverall: SlidingWindowLimiter | undefined;
  private readonly registrations = new SlidingWindowLimiter(20, 60 * MINUTE);
  private readonly authorizations = new SlidingWindowLimiter(60, 10 * MINUTE);
  /** Sign-ins run one at a time, so parallel attempts cannot all pass the limits before any is counted. */
  private signInQueue: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly options: AuthorizationServerOptions) {
    this.now = options.now ?? Date.now;
    this.failuresOverall =
      options.globalSignInLimit > 0 ? new SlidingWindowLimiter(options.globalSignInLimit, 5 * MINUTE) : undefined;
  }

  private url(path: string): string {
    return new URL(path, this.options.issuer).href;
  }

  /** The issuer identifier, without the trailing slash URL.href adds (RFC 8414 examples, most clients). */
  private get issuerId(): string {
    return this.options.issuer.origin;
  }

  metadata(): OAuthMetadata {
    return {
      issuer: this.issuerId,
      authorization_endpoint: this.url("/oauth/authorize"),
      token_endpoint: this.url("/oauth/token"),
      registration_endpoint: this.url("/oauth/register"),
      revocation_endpoint: this.url("/oauth/revoke"),
      response_types_supported: ["code"],
      grant_types_supported: GRANT_TYPES,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: AUTH_METHODS,
      revocation_endpoint_auth_methods_supported: AUTH_METHODS,
      scopes_supported: [SCOPE],
      authorization_response_iss_parameter_supported: true,
    } as OAuthMetadata;
  }

  /** Checks access tokens for the MCP endpoint; the user and level travel in `extra`. */
  readonly verifier: OAuthTokenVerifier = {
    verifyAccessToken: async (token) => {
      const grant = this.options.store.findAccess(token);
      if (!grant) throw new OAuthError(OAuthErrorCode.InvalidToken, "Unknown, expired or revoked access token");
      const info: AuthInfo = {
        token,
        clientId: grant.clientId,
        scopes: grant.scope.split(" ").filter(Boolean),
        expiresAt: Math.floor(grant.expiresAt / 1000),
        resource: this.options.resource,
        extra: { user: grant.user },
      };
      return info;
    },
  };

  /** Serves the /oauth/* endpoints; undefined for any other path. */
  async handle(request: Request, clientIp: string): Promise<Response | undefined> {
    const url = new URL(request.url);
    const method = request.method;
    try {
      if (url.pathname === "/oauth/register" && method === "POST") return await this.register(request, clientIp);
      if (url.pathname === "/oauth/authorize" && method === "GET") return this.authorize(url.searchParams, clientIp);
      if (url.pathname === "/oauth/authorize" && method === "POST") return await this.signIn(request, clientIp);
      if (url.pathname === "/oauth/token" && method === "POST") return await this.token(request);
      if (url.pathname === "/oauth/revoke" && method === "POST") return await this.revoke(request);
    } catch (err) {
      if (err instanceof TokenError) return tokenError(err);
      throw err;
    }
    if (url.pathname.startsWith("/oauth/")) return new Response("Method not allowed", { status: 405 });
    return undefined;
  }

  isAllowedRedirect(uri: string): boolean {
    let target: URL;
    try {
      target = new URL(uri);
    } catch {
      return false;
    }
    if (target.hash) return false;
    return this.options.redirectUris.some((pattern) => {
      if (!pattern.endsWith(":*")) return pattern === uri;
      const allowed = new URL(pattern.slice(0, -2));
      return target.protocol === allowed.protocol && target.hostname === allowed.hostname;
    });
  }

  // --- Dynamic client registration ---

  private async register(request: Request, clientIp: string): Promise<Response> {
    const invalid = (description: string, status = 400) =>
      json({ error: "invalid_client_metadata", error_description: description }, status);
    if (this.registrations.blocked(clientIp)) return invalid("Too many registrations, retry later", 429);
    const body = await request.text();
    if (body.length > MAX_REGISTRATION_BYTES) return invalid("Registration request too large", 413);

    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      return invalid("Body must be JSON");
    }
    const parsed = OAuthClientMetadataSchema.safeParse(raw);
    if (!parsed.success) return invalid(parsed.error.message);
    const requested = parsed.data;
    if (requested.redirect_uris.length > MAX_REDIRECT_URIS) return invalid(`At most ${MAX_REDIRECT_URIS} redirect URIs`);
    const refused = requested.redirect_uris.find((uri) => !this.isAllowedRedirect(uri));
    if (refused) {
      return json(
        { error: "invalid_redirect_uri", error_description: `Redirect URI not allowed by this server: ${refused.slice(0, 200)}` },
        400,
      );
    }
    const authMethod = requested.token_endpoint_auth_method ?? "none";
    if (!AUTH_METHODS.includes(authMethod)) return invalid(`Unsupported auth method ${authMethod.slice(0, 40)}`);
    if (requested.grant_types?.some((g) => !GRANT_TYPES.includes(g)) || requested.response_types?.some((r) => r !== "code")) {
      return invalid("Only authorization_code is supported");
    }

    this.registrations.record(clientIp);
    this.evictUnusedClients();
    // Only what the server uses is kept: the state file stays small whatever clients send.
    const metadata: OAuthClientMetadata = {
      redirect_uris: requested.redirect_uris,
      client_name: requested.client_name?.slice(0, 100),
      token_endpoint_auth_method: authMethod,
      grant_types: requested.grant_types ?? GRANT_TYPES,
      response_types: ["code"],
    };
    const secret = authMethod === "none" ? undefined : newToken();
    const client: StoredClient = {
      client_id: newToken(16),
      secret_hash: secret && hashToken(secret),
      client_id_issued_at: Math.floor(this.now() / 1000),
      metadata,
    };
    this.options.store.clients.set(client.client_id, client);
    await this.options.store.save();
    return json(
      {
        ...metadata,
        client_id: client.client_id,
        client_id_issued_at: client.client_id_issued_at,
        ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      },
      201,
    );
  }

  /** Registration is open, so cap the stored clients by dropping the oldest ones that hold no token. */
  private evictUnusedClients(): void {
    const { clients, refreshGrants } = this.options.store;
    if (clients.size < MAX_CLIENTS) return;
    const inUse = new Set([...refreshGrants.values()].map((g) => g.clientId));
    const unused = [...clients.values()].filter((c) => !inUse.has(c.client_id));
    unused.sort((a, b) => a.client_id_issued_at - b.client_id_issued_at);
    for (const c of unused.slice(0, clients.size - MAX_CLIENTS + 1)) clients.delete(c.client_id);
  }

  // --- Authorization endpoint ---

  private authorize(params: URLSearchParams, clientIp: string): Response {
    if (this.authorizations.blocked(clientIp)) return errorPage("Trop de demandes : réessaie dans quelques minutes.", 429);
    this.authorizations.record(clientIp);

    // Until the client and its redirect URI are known good, errors are shown here, never redirected.
    const client = this.options.store.clients.get(params.get("client_id") ?? "");
    if (!client) return errorPage("Application inconnue : supprime-la puis ajoute-la à nouveau dans ton client MCP.");
    const registered = client.metadata.redirect_uris;
    const redirectUri = params.get("redirect_uri") ?? (registered.length === 1 ? registered[0] : undefined);
    if (!redirectUri || !registered.includes(redirectUri) || !this.isAllowedRedirect(redirectUri)) {
      return errorPage("Adresse de retour invalide pour cette application.");
    }

    const rawState = params.get("state") ?? undefined;
    const state = rawState && rawState.length <= MAX_STATE_LENGTH ? rawState : undefined;
    const fail = (error: string, description: string) =>
      this.redirect(redirectUri, { error, error_description: description, state, iss: this.issuerId });
    if (rawState !== state) return fail("invalid_request", `state longer than ${MAX_STATE_LENGTH} characters`);
    if (params.get("response_type") !== "code") return fail("unsupported_response_type", "Only response_type=code");
    const codeChallenge = params.get("code_challenge");
    if (!codeChallenge || !CODE_CHALLENGE.test(codeChallenge) || params.get("code_challenge_method") !== "S256") {
      return fail("invalid_request", "PKCE with code_challenge_method=S256 is required");
    }
    const resource = params.get("resource");
    if (resource && !this.isOurResource(resource)) return fail("invalid_target", "Unknown resource");
    const scope = params.get("scope") ?? SCOPE;
    if (scope.split(" ").some((s) => s && s !== SCOPE)) return fail("invalid_scope", `Only the "${SCOPE}" scope exists`);

    this.prunePending();
    if (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
    const requestId = newToken();
    this.pending.set(requestId, {
      client,
      redirectUri,
      state,
      codeChallenge,
      scope: SCOPE,
      attempts: 0,
      expiresAt: this.now() + PENDING_TTL,
    });
    return signInPage({ requestId, clientName: clientName(client), redirectHost: new URL(redirectUri).host });
  }

  private async signIn(request: Request, clientIp: string): Promise<Response> {
    const form = await request.formData().catch(() => undefined);
    const field = (name: string) => {
      const value = form?.get(name);
      return typeof value === "string" ? value : "";
    };
    const requestId = field("request_id");
    const pending = this.pending.get(requestId);
    if (!pending || pending.expiresAt <= this.now()) {
      this.pending.delete(requestId);
      return errorPage("Cette demande de connexion a expiré : recommence depuis ton application.");
    }
    if (field("action") === "deny") {
      this.pending.delete(requestId);
      return this.redirect(pending.redirectUri, {
        error: "access_denied",
        error_description: "Refused",
        state: pending.state,
        iss: this.issuerId,
      });
    }

    const account = field("account").trim();
    const show = (error: string, status: number) =>
      signInPage(
        { requestId, clientName: clientName(pending.client), redirectHost: new URL(pending.redirectUri).host, account, error },
        status,
      );
    const result = await this.serialized(() => this.checkSignIn(pending, account, field("password"), field("otp"), clientIp));
    if ("error" in result) {
      if (pending.attempts >= MAX_ATTEMPTS_PER_REQUEST) {
        this.pending.delete(requestId);
        return errorPage("Trop de tentatives pour cette demande : recommence depuis ton application.", 429);
      }
      return show(result.error, result.status);
    }

    this.pending.delete(requestId);
    const code = newToken();
    this.options.store.codes.set(hashToken(code), {
      family: newToken(16),
      familyExpiresAt: this.now() + FAMILY_TTL,
      clientId: pending.client.client_id,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      user: result.user,
      scope: pending.scope,
      expiresAt: this.now() + CODE_TTL,
    });
    console.error(
      `[oauth] ${forLog(result.user)} signed in for ${forLog(clientName(pending.client))} from ${clientIp}`,
    );
    return this.redirect(pending.redirectUri, { code, state: pending.state, iss: this.issuerId });
  }

  /** Limits, DSM check and failure counting, as one step that never overlaps another sign-in. */
  private async checkSignIn(
    pending: PendingAuthorization,
    account: string,
    password: string,
    otp: string,
    clientIp: string,
  ): Promise<{ user: string } | { error: string; status: number }> {
    const accountKey = account.toLowerCase();
    if (
      this.failuresPerIp.blocked(clientIp) ||
      this.failuresPerAccount.blocked(accountKey) ||
      this.failuresOverall?.blocked("all")
    ) {
      return { error: "Trop de tentatives échouées : réessaie dans quelques minutes.", status: 429 };
    }
    pending.attempts++;
    try {
      return { user: await this.options.accounts.signIn(account, password, otp.replace(/\s/g, "")) };
    } catch (err) {
      if (!(err instanceof SignInError)) {
        console.error(`[oauth] sign-in of ${forLog(account)} failed: ${(err as Error).message}`);
        return { error: "Le NAS ne répond pas pour le moment : réessaie dans quelques minutes.", status: 503 };
      }
      if (err.countsAsFailure) {
        this.failuresPerIp.record(clientIp);
        this.failuresPerAccount.record(accountKey);
        this.failuresOverall?.record("all");
      }
      console.error(`[oauth] sign-in refused for ${forLog(account)} from ${clientIp}: ${err.message}`);
      return { error: err.message, status: 401 };
    }
  }

  private serialized<T>(run: () => Promise<T>): Promise<T> {
    const next = this.signInQueue.then(run, run);
    this.signInQueue = next.catch(() => {});
    return next;
  }

  private redirect(redirectUri: string, params: Record<string, string | undefined>): Response {
    const target = new URL(redirectUri);
    for (const [key, value] of Object.entries(params)) if (value !== undefined) target.searchParams.set(key, value);
    return new Response(null, { status: 302, headers: { location: target.href, "cache-control": "no-store" } });
  }

  private prunePending(): void {
    const now = this.now();
    for (const [id, p] of this.pending) if (p.expiresAt <= now) this.pending.delete(id);
  }

  private isOurResource(resource: string): boolean {
    const strip = (u: string) => u.replace(/#.*$/, "").replace(/\/$/, "");
    return strip(resource) === strip(this.options.resource.href);
  }

  // --- Token endpoint ---

  private async token(request: Request): Promise<Response> {
    const body = new URLSearchParams(await request.text());
    const client = this.authenticateClient(request, body);
    const resource = body.get("resource");
    if (resource && !this.isOurResource(resource)) throw new TokenError("invalid_target", "Unknown resource");

    switch (body.get("grant_type")) {
      case "authorization_code":
        return this.exchangeCode(client, body);
      case "refresh_token":
        return this.refresh(client, body);
      default:
        throw new TokenError("unsupported_grant_type", "Use authorization_code or refresh_token");
    }
  }

  /** Client authentication: client_secret_basic, client_secret_post, or none for public PKCE clients. */
  private authenticateClient(request: Request, body: URLSearchParams): StoredClient {
    let clientId = body.get("client_id") ?? undefined;
    let secret = body.get("client_secret") ?? undefined;
    const header = request.headers.get("authorization");
    if (header?.startsWith("Basic ")) {
      const decoded = Buffer.from(header.slice(6), "base64").toString();
      const colon = decoded.indexOf(":");
      if (colon < 0) throw new TokenError("invalid_client", "Malformed Basic credentials", 401);
      try {
        clientId = decodeURIComponent(decoded.slice(0, colon));
        secret = decodeURIComponent(decoded.slice(colon + 1));
      } catch {
        throw new TokenError("invalid_client", "Malformed Basic credentials", 401);
      }
    }
    const client = clientId ? this.options.store.clients.get(clientId) : undefined;
    if (!client) throw new TokenError("invalid_client", "Unknown client", 401);
    if (client.secret_hash && !(secret && safeEqual(hashToken(secret), client.secret_hash))) {
      throw new TokenError("invalid_client", "Invalid client secret", 401);
    }
    return client;
  }

  private async exchangeCode(client: StoredClient, body: URLSearchParams): Promise<Response> {
    const { codes } = this.options.store;
    const key = hashToken(body.get("code") ?? "");
    const code = codes.get(key);
    codes.delete(key); // single use, whatever happens next
    if (!code || code.expiresAt <= this.now()) throw new TokenError("invalid_grant", "Unknown or expired code");
    if (code.clientId !== client.client_id) throw new TokenError("invalid_grant", "Code issued to another client");
    if (body.get("redirect_uri") && body.get("redirect_uri") !== code.redirectUri) {
      throw new TokenError("invalid_grant", "redirect_uri does not match the authorization request");
    }
    if (!verifyPkce(body.get("code_verifier") ?? "", code.codeChallenge)) {
      throw new TokenError("invalid_grant", "PKCE verification failed");
    }
    return this.issue(client, code.family, code.familyExpiresAt, code.user, code.scope);
  }

  private async refresh(client: StoredClient, body: URLSearchParams): Promise<Response> {
    const { store } = this.options;
    const grant = store.findRefresh(body.get("refresh_token") ?? "");
    if (!grant || grant.clientId !== client.client_id) throw new TokenError("invalid_grant", "Unknown or expired refresh token");
    if (grant.usedAt !== undefined) {
      // A rotated token came back: unless it is a quick retry, someone else holds a copy.
      if (this.now() - grant.usedAt > REUSE_GRACE) {
        store.revokeFamily(grant.family);
        await store.save();
        console.error(`[oauth] refresh token reused for ${forLog(grant.user)}; all of that sign-in's tokens revoked`);
      }
      throw new TokenError("invalid_grant", "Refresh token already used");
    }
    // Marked used before any await, so two concurrent refreshes with one token cannot both succeed.
    grant.usedAt = this.now();

    // The account is checked again at every refresh: disabling it in DSM, or removing it from allowed_users,
    // locks the user out within the access token's lifetime.
    let access: Awaited<ReturnType<DsmAccounts["check"]>>;
    try {
      access = await this.options.accounts.check(grant.user);
    } catch (err) {
      // DSM unreachable: refuse this refresh but keep the token usable for a later retry.
      grant.usedAt = undefined;
      console.error(`[oauth] cannot check ${forLog(grant.user)}'s access: ${(err as Error).message}`);
      throw new TokenError("temporarily_unavailable", "The NAS cannot be reached, retry later", 503);
    }
    if ("refused" in access) {
      store.revokeFamily(grant.family);
      await store.save();
      throw new TokenError("invalid_grant", "This account no longer has access");
    }
    return this.issue(client, grant.family, grant.familyExpiresAt, access.user, grant.scope);
  }

  private async issue(
    client: StoredClient,
    family: string,
    familyExpiresAt: number,
    user: string,
    scope: string,
  ): Promise<Response> {
    const { store } = this.options;
    const now = this.now();
    const accessToken = newToken();
    const refreshToken = newToken();
    const accessExpiresAt = Math.min(now + ACCESS_TTL, familyExpiresAt);
    store.accessGrants.set(hashToken(accessToken), {
      family,
      clientId: client.client_id,
      user,
      scope,
      expiresAt: accessExpiresAt,
    });
    store.refreshGrants.set(hashToken(refreshToken), {
      hash: hashToken(refreshToken),
      family,
      familyExpiresAt,
      clientId: client.client_id,
      user,
      scope,
      expiresAt: Math.min(now + REFRESH_TTL, familyExpiresAt),
    });
    await store.save();
    return json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.round((accessExpiresAt - now) / 1000),
      refresh_token: refreshToken,
      scope,
    });
  }

  // --- Revocation ---

  private async revoke(request: Request): Promise<Response> {
    const body = new URLSearchParams(await request.text());
    const client = this.authenticateClient(request, body);
    const token = body.get("token") ?? "";
    const { store } = this.options;
    const grant = store.findRefresh(token) ?? store.findAccess(token);
    if (grant && grant.clientId === client.client_id) {
      store.revokeFamily(grant.family);
      await store.save();
    }
    // RFC 7009: the answer is the same whether or not the token existed.
    return new Response(null, { status: 200 });
  }
}

const clientName = (client: StoredClient) => client.metadata.client_name || "Une application sans nom";
