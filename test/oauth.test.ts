import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Permissions } from "../src/permissions";
import { createHttpApp } from "../src/http";
import { OAuthStore } from "../src/oauth/store";
import { SynologyClient } from "../src/synology/client";
import { AuditLog } from "../src/tools/toolbox";
import { DEFAULT_APIS, fakeNas, memoryPermissions, perms, testConfig } from "./fake-nas";

const BASE = "https://mcp.nas.test";
const REDIRECT = "http://localhost:33418/callback";
const VERIFIER = "a".repeat(20) + "-verifier-with-enough-entropy-1234567890";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

const APIS = {
  ...DEFAULT_APIS,
  "SYNO.Core.User": { path: "entry.cgi", minVersion: 1, maxVersion: 1, requestFormat: "JSON" },
};
const DAY = 24 * 60 * 60_000;

interface Setup {
  permissions?: Permissions;
  /** DSM `expired` value per user; "normal" when absent. */
  status?: Record<string, string>;
}

async function setup({ permissions = { domains: perms("rw") }, status = {} }: Setup = {}) {
  // Starts at the real time: the SDK checks token expiry against Date.now().
  let clock = Date.now();
  const now = () => clock;
  const nas = fakeNas(
    {
      "SYNO.Core.User.get": (params) => {
        const name = JSON.parse(params.get("name")!);
        return { success: true, data: { users: [{ name, expired: status[name] ?? "normal" }] } };
      },
    },
    APIS,
    { leo: { password: "pw", otp: "123456" }, alice: { password: "pw2" }, agent: { password: "s3cret" } },
  );
  const config = testConfig();
  const client = new SynologyClient(config, nas.fetchImpl);
  const store = await OAuthStore.open(undefined, now);
  const rights = memoryPermissions(permissions);
  const app = createHttpApp(config, client, new AuditLog(), store, rights, now);

  const fetchApp = (path: string, init?: RequestInit) => app.fetch(new Request(BASE + path, init), "203.0.113.7");
  const form = (fields: Record<string, string>) => ({
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });

  const register = async (metadata: Record<string, unknown> = {}) =>
    fetchApp("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "Claude Code", token_endpoint_auth_method: "none", ...metadata }),
    });

  const authorize = async (clientId: string) => {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      state: "xyz",
      resource: `${BASE}/mcp`,
    });
    const res = await fetchApp(`/oauth/authorize?${params}`);
    const html = await res.text();
    return { res, html, requestId: html.match(/name="request_id" value="([^"]+)"/)?.[1] };
  };

  const signIn = (requestId: string, account: string, password: string, otp = "") =>
    fetchApp("/oauth/authorize", form({ request_id: requestId, account, password, otp, action: "allow" }));

  /** Registers, signs in as leo and exchanges the code: the happy path most tests start from. */
  const login = async (account = "leo", password = "pw", otp = "123456") => {
    const { client_id } = (await (await register()).json()) as { client_id: string };
    const { requestId } = await authorize(client_id);
    const redirect = await signIn(requestId!, account, password, otp);
    const code = new URL(redirect.headers.get("location")!).searchParams.get("code")!;
    const tokens = (await (
      await fetchApp(
        "/oauth/token",
        form({ grant_type: "authorization_code", code, code_verifier: VERIFIER, client_id, redirect_uri: REDIRECT }),
      )
    ).json()) as { access_token: string; refresh_token: string };
    return { client_id, ...tokens };
  };

  const toolNames = async (accessToken: string) => {
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      fetch: (url, init) => app.fetch(new Request(url.toString(), init), "203.0.113.7"),
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    });
    const mcp = new Client({ name: "test", version: "test" });
    await mcp.connect(transport);
    const names = (await mcp.listTools()).tools.map((t) => t.name);
    await mcp.close();
    return names;
  };

  return {
    app,
    nas,
    rights,
    store,
    fetchApp,
    form,
    register,
    authorize,
    signIn,
    login,
    toolNames,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("discovery", () => {
  test("serves protected resource and authorization server metadata", async () => {
    const { fetchApp } = await setup();
    const resource = (await (await fetchApp("/.well-known/oauth-protected-resource/mcp")).json()) as Record<string, unknown>;
    expect(resource.resource).toBe(`${BASE}/mcp`);
    expect(resource.authorization_servers).toEqual([BASE]);

    const as = (await (await fetchApp("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
    expect(as.authorization_endpoint).toBe(`${BASE}/oauth/authorize`);
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
  });

  test("the MCP endpoint challenges unauthenticated requests", async () => {
    const { fetchApp } = await setup();
    const res = await fetchApp("/mcp", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("/.well-known/oauth-protected-resource/mcp");
  });
});

describe("registration", () => {
  test("accepts claude.ai and local redirect URIs", async () => {
    const { register } = await setup();
    expect((await register()).status).toBe(201);
    expect((await register({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] })).status).toBe(201);
  });

  test("keeps only the fields it uses and refuses oversized requests", async () => {
    const { register, store } = await setup();
    const { client_id } = (await (await register({ jwks: { keys: ["x"] }, client_name: "n".repeat(500) })).json()) as {
      client_id: string;
    };
    const stored = store.clients.get(client_id)!.metadata;
    expect(stored.jwks).toBeUndefined();
    expect(stored.client_name).toHaveLength(100);
    expect((await register({ contacts: ["x".repeat(20_000)] })).status).toBe(413);
  });

  test("refuses redirect URIs outside the allowlist", async () => {
    const { register } = await setup();
    const res = await register({ redirect_uris: ["https://evil.example/callback"] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_redirect_uri");
  });
});

describe("authorization", () => {
  test("shows the client and where it redirects, never redirecting for an unknown client", async () => {
    const { register, authorize } = await setup();
    const { client_id } = (await (await register()).json()) as { client_id: string };
    const { res, html } = await authorize(client_id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(html).toContain("Claude Code");
    expect(html).toContain("localhost:33418");

    const unknown = await authorize("nope");
    expect(unknown.res.status).toBe(400);
    expect(unknown.res.headers.get("location")).toBeNull();
  });

  test("requires PKCE", async () => {
    const { register, fetchApp } = await setup();
    const { client_id } = (await (await register()).json()) as { client_id: string };
    const res = await fetchApp(`/oauth/authorize?response_type=code&client_id=${client_id}&redirect_uri=${REDIRECT}&state=s`);
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
  });

  test("checks the password and the 2FA code with DSM, then redirects with a code", async () => {
    const { register, authorize, signIn } = await setup();
    const { client_id } = (await (await register()).json()) as { client_id: string };
    const { requestId } = await authorize(client_id);

    const wrong = await signIn(requestId!, "leo", "bad");
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain("Identifiant ou mot de passe incorrect");

    const noOtp = await signIn(requestId!, "leo", "pw");
    expect(await noOtp.text()).toContain("code de validation");

    const ok = await signIn(requestId!, "leo", "pw", "123 456");
    expect(ok.status).toBe(302);
    const location = new URL(ok.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(REDIRECT);
    expect(location.searchParams.get("state")).toBe("xyz");
    expect(location.searchParams.get("iss")).toBe(BASE);
    expect(location.searchParams.get("code")).toBeTruthy();
  });

  test("allowed_users restricts who can sign in", async () => {
    const { register, authorize, signIn } = await setup({ permissions: { domains: perms("rw"), allowedUsers: ["LEO"] } });
    const { client_id } = (await (await register()).json()) as { client_id: string };
    const { requestId } = await authorize(client_id);
    const res = await signIn(requestId!, "alice", "pw2");
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("allowed_users");
    expect((await signIn(requestId!, "leo", "pw", "123456")).status).toBe(302);
  });

  test("blocks an account after five failed attempts", async () => {
    const { register, authorize, signIn } = await setup();
    const { client_id } = (await (await register()).json()) as { client_id: string };
    const { requestId } = await authorize(client_id);
    for (let i = 0; i < 5; i++) await signIn(requestId!, "leo", `bad${i}`);
    // A new request: the first one is used up after five attempts.
    const res = await signIn((await authorize(client_id)).requestId!, "leo", "pw", "123456");
    expect(res.status).toBe(429);
  });

  test("parallel attempts cannot get more failures past the limits", async () => {
    const { register, authorize, signIn, nas } = await setup();
    const { client_id } = (await (await register()).json()) as { client_id: string };
    const ids = await Promise.all(Array.from({ length: 6 }, async () => (await authorize(client_id)).requestId!));
    await Promise.all(ids.flatMap((id) => Array.from({ length: 5 }, (_, i) => signIn(id, i % 2 ? "leo" : "alice", "bad"))));
    // 5 failures per IP in 15 minutes: everything after reaches nobody.
    expect(nas.loginParams.length).toBe(5);
  });

  test("a request id allows five attempts", async () => {
    const { register, authorize, signIn } = await setup();
    const { client_id } = (await (await register()).json()) as { client_id: string };
    const { requestId } = await authorize(client_id);
    for (let i = 0; i < 4; i++) await signIn(requestId!, "leo", "pw"); // 2FA code missing: not a failure
    const fifth = await signIn(requestId!, "leo", "pw");
    expect(fifth.status).toBe(429);
    expect((await signIn(requestId!, "leo", "pw", "123456")).status).toBe(400);
  });

  test("the service account cannot sign in, and DSM never sees the attempt", async () => {
    const { register, authorize, signIn, nas } = await setup();
    const { client_id } = (await (await register()).json()) as { client_id: string };
    const { requestId } = await authorize(client_id);
    const res = await signIn(requestId!, "Agent", "s3cret");
    expect(await res.text()).toContain("ne peut pas se connecter ici");
    expect(nas.loginParams).toHaveLength(0);
  });

  test("disabled DSM accounts are refused", async () => {
    const { register, authorize, signIn } = await setup({ status: { leo: "now" } });
    const { client_id } = (await (await register()).json()) as { client_id: string };
    const { requestId } = await authorize(client_id);
    expect((await signIn(requestId!, "leo", "pw", "123456")).status).toBe(401);
  });

  test("refuses malformed PKCE challenges and oversized state", async () => {
    const { register, fetchApp } = await setup();
    const { client_id } = (await (await register()).json()) as { client_id: string };
    const go = async (challenge: string, state: string) => {
      const params = new URLSearchParams({
        response_type: "code",
        client_id,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
      });
      const res = await fetchApp(`/oauth/authorize?${params}`);
      return new URL(res.headers.get("location")!).searchParams;
    };
    expect((await go("x".repeat(5000), "s")).get("error")).toBe("invalid_request");
    const longState = await go(CHALLENGE, "s".repeat(600));
    expect(longState.get("error")).toBe("invalid_request");
    expect(longState.get("iss")).toBe(BASE);
  });

  test("deny sends access_denied back", async () => {
    const { register, authorize, fetchApp, form } = await setup();
    const { client_id } = (await (await register()).json()) as { client_id: string };
    const { requestId } = await authorize(client_id);
    const res = await fetchApp("/oauth/authorize", form({ request_id: requestId!, action: "deny" }));
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
  });
});

describe("tokens", () => {
  test("the code works once, with the right PKCE verifier", async () => {
    const { register, authorize, signIn, fetchApp, form } = await setup();
    const { client_id } = (await (await register()).json()) as { client_id: string };
    const { requestId } = await authorize(client_id);
    const redirect = await signIn(requestId!, "leo", "pw", "123456");
    const code = new URL(redirect.headers.get("location")!).searchParams.get("code")!;
    const exchange = (verifier: string) =>
      fetchApp("/oauth/token", form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id }));

    const bad = await exchange("b".repeat(50));
    expect(bad.status).toBe(400);
    // The failed attempt consumed the code.
    expect(((await (await exchange(VERIFIER)).json()) as { error: string }).error).toBe("invalid_grant");
  });

  test("the access token opens the MCP endpoint with the tools the file allows", async () => {
    const { login, toolNames } = await setup({ permissions: { domains: perms("ro", { files: "rw" }) } });
    const names = await toolNames((await login()).access_token);
    expect(names).toContain("file_write");
    expect(names).toContain("system_info");
    expect(names).not.toContain("system_reboot");
  });

  test("a change of the permissions file applies to the next request, without signing in again", async () => {
    const { login, toolNames, rights } = await setup({ permissions: { domains: perms("ro") } });
    const { access_token } = await login();
    expect(await toolNames(access_token)).not.toContain("file_write");
    rights.current = { domains: perms("ro", { files: "rw" }) };
    expect(await toolNames(access_token)).toContain("file_write");
  });

  test("refresh tokens rotate, and a reused one revokes the whole sign-in", async () => {
    const { login, fetchApp, form, advance, toolNames } = await setup();
    const first = await login();
    const refresh = async (token: string) =>
      fetchApp("/oauth/token", form({ grant_type: "refresh_token", refresh_token: token, client_id: first.client_id }));

    const second = (await (await refresh(first.refresh_token)).json()) as { access_token: string; refresh_token: string };
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(await toolNames(second.access_token)).toContain("file_read");

    advance(60_000);
    expect((await refresh(first.refresh_token)).status).toBe(400);
    expect((await refresh(second.refresh_token)).status).toBe(400);
    const res = await fetchApp("/mcp", { method: "POST", headers: { authorization: `Bearer ${second.access_token}` }, body: "{}" });
    expect(res.status).toBe(401);
  });

  test("removing the user from allowed_users blocks the next refresh", async () => {
    const { login, fetchApp, form, rights } = await setup();
    const { refresh_token, client_id } = await login();
    rights.current = { domains: perms("rw"), allowedUsers: ["alice"] };
    const res = await fetchApp("/oauth/token", form({ grant_type: "refresh_token", refresh_token, client_id }));
    expect(((await res.json()) as { error_description: string }).error_description).toContain("no longer has access");
  });

  test("a DSM outage during refresh keeps the session", async () => {
    const { login, fetchApp, form, nas } = await setup();
    const { refresh_token, client_id } = await login();
    const refresh = () => fetchApp("/oauth/token", form({ grant_type: "refresh_token", refresh_token, client_id }));
    nas.down = true;
    expect((await refresh()).status).toBe(503);
    nas.down = false;
    expect((await refresh()).status).toBe(200);
  });

  test("disabling the DSM account blocks the next refresh", async () => {
    const status: Record<string, string> = {};
    const { login, fetchApp, form } = await setup({ status });
    const { refresh_token, client_id } = await login();
    status.leo = "now";
    const res = await fetchApp("/oauth/token", form({ grant_type: "refresh_token", refresh_token, client_id }));
    expect(res.status).toBe(400);
  });

  test("a sign-in lasts 90 days at most, however often it is refreshed", async () => {
    const { login, fetchApp, form, advance } = await setup();
    let { refresh_token, client_id } = await login();
    const refresh = () => fetchApp("/oauth/token", form({ grant_type: "refresh_token", refresh_token, client_id }));
    for (let day = 25; day < 90; day += 25) {
      advance(25 * DAY);
      const res = await refresh();
      expect(res.status).toBe(200);
      refresh_token = ((await res.json()) as { refresh_token: string }).refresh_token;
    }
    advance(16 * DAY);
    expect((await refresh()).status).toBe(400);
  });

  test("two concurrent refreshes with one token: only one succeeds", async () => {
    const { login, fetchApp, form } = await setup();
    const { refresh_token, client_id } = await login();
    const refresh = () => fetchApp("/oauth/token", form({ grant_type: "refresh_token", refresh_token, client_id }));
    const statuses = (await Promise.all([refresh(), refresh()])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 400]);
  });

  test("a malformed Basic header is an invalid client, not a crash", async () => {
    const { fetchApp } = await setup();
    const res = await fetchApp("/oauth/token", {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from("%E0%A4%A:x").toString("base64")}` },
      body: "grant_type=refresh_token",
    });
    expect(res.status).toBe(401);
  });

  test("access tokens expire after an hour", async () => {
    const { login, fetchApp, advance } = await setup();
    const { access_token } = await login();
    advance(61 * 60_000);
    const res = await fetchApp("/mcp", { method: "POST", headers: { authorization: `Bearer ${access_token}` }, body: "{}" });
    expect(res.status).toBe(401);
  });

  test("revocation ends the sign-in", async () => {
    const { login, fetchApp, form } = await setup();
    const { access_token, refresh_token, client_id } = await login();
    expect((await fetchApp("/oauth/revoke", form({ token: refresh_token, client_id }))).status).toBe(200);
    const res = await fetchApp("/mcp", { method: "POST", headers: { authorization: `Bearer ${access_token}` }, body: "{}" });
    expect(res.status).toBe(401);
  });

  test("confidential clients must present their secret", async () => {
    const { register, fetchApp, form } = await setup();
    const client = (await (await register({ token_endpoint_auth_method: "client_secret_post" })).json()) as {
      client_id: string;
      client_secret: string;
    };
    expect(client.client_secret).toBeTruthy();
    const res = await fetchApp("/oauth/token", form({ grant_type: "refresh_token", refresh_token: "x", client_id: client.client_id }));
    expect(res.status).toBe(401);
  });
});

test("clients and refresh tokens survive a restart, stored hashed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "synology-mcp-"));
  try {
    const store = await OAuthStore.open(dir);
    store.clients.set("c1", { client_id: "c1", client_id_issued_at: 1, metadata: { redirect_uris: [REDIRECT] } });
    store.refreshGrants.set("hash-of-token", {
      hash: "hash-of-token",
      family: "f",
      familyExpiresAt: Date.now() + 60_000,
      clientId: "c1",
      user: "leo",
      scope: "mcp",
      expiresAt: Date.now() + 60_000,
    });
    await store.save();
    const reopened = await OAuthStore.open(dir);
    expect(reopened.clients.get("c1")?.metadata.redirect_uris).toEqual([REDIRECT]);
    expect(reopened.refreshGrants.get("hash-of-token")?.user).toBe("leo");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
