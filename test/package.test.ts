import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionsFile } from "../src/permissions";
import { ADMIN_PREFIX, createAdminApp } from "../src/package/admin";
import { type AdminAuthenticator, type AdminCheck, DsmSessionAuth, type Runner } from "../src/package/auth";
import { McpService } from "../src/package/service";
import { SettingsFile } from "../src/package/settings";
import { fakeNas } from "./fake-nas";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Lets every request in as `leo`, unless the test says otherwise. */
function fakeAuth(result: AdminCheck = { user: "leo" }): AdminAuthenticator & { result: AdminCheck } {
  const auth = { result, check: async () => auth.result };
  return auth;
}

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), "synology-mcp-package-"));
  const nas = fakeNas({}, undefined, { svc: { password: "pw" }, svc2fa: { password: "pw", otp: "123456" } });
  const settings = new SettingsFile(join(dataDir, "settings.json"));
  const permissions = new PermissionsFile(join(dataDir, "permissions.yml"));
  await permissions.open();
  const service = new McpService({
    dataDir,
    settings,
    permissions,
    env: { SYNO_HTTP_PORT: "0", SYNO_URL: "https://nas.test:5001" },
    fetchImpl: nas.fetchImpl,
    retryMs: 60_000,
  });
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }), () => service.stop());
  const auth = fakeAuth();
  const app = createAdminApp({ auth, service, settings, permissions });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.fetch(
      new Request(`https://nas.test:5001${ADMIN_PREFIX}${path}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      "192.168.1.10",
    );
    return { status: res.status, body: (await res.json()) as any };
  };
  return { dataDir, nas, settings, permissions, service, auth, call };
}

describe("DSM app API", () => {
  test("is for DSM administrators only", async () => {
    const { auth, call } = await setup();
    auth.result = { refused: "signed-out" };
    expect((await call("GET", "/state")).status).toBe(401);
    auth.result = { refused: "not-admin" };
    expect((await call("GET", "/state")).status).toBe(403);
    expect((await call("GET", "/nope")).status).toBe(404);
  });

  test("walks through the setup: service account, public address, then the server runs", async () => {
    const { call, settings } = await setup();
    expect((await call("GET", "/state")).body.status).toEqual({ state: "needs-account" });

    const wrong = await call("PUT", "/account", { username: "svc", password: "bad" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toContain("mot de passe incorrect");
    expect(await settings.load()).toEqual({});

    const ok = await call("PUT", "/account", { username: "svc", password: "pw" });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toEqual({ state: "needs-public-url" });
    expect(ok.body.account).toEqual({ username: "svc", twoFactor: false });

    const insecure = await call("PUT", "/public-url", { publicUrl: "http://mcp.example.com" });
    expect(insecure.status).toBe(400);
    const running = await call("PUT", "/public-url", { publicUrl: "https://mcp.example.com/" });
    expect(running.body.status.state).toBe("running");
    expect(running.body.mcpUrl).toBe("https://mcp.example.com/mcp");
    expect((await settings.load()).publicUrl).toBe("https://mcp.example.com");
  });

  test("a 2FA account needs a code once, then keeps a device token", async () => {
    const { call, settings } = await setup();
    const missing = await call("PUT", "/account", { username: "svc2fa", password: "pw" });
    expect(missing.body.error).toContain("deux étapes");
    expect((await call("PUT", "/account", { username: "svc2fa", password: "pw", otpCode: "12" })).status).toBe(400);

    const ok = await call("PUT", "/account", { username: "svc2fa", password: "pw", otpCode: "123456" });
    expect(ok.body.account).toEqual({ username: "svc2fa", twoFactor: true });
    expect((await settings.load()).deviceId).toBe("device-svc2fa");

    // Same account, password left blank: the saved password and device token are kept.
    const again = await call("PUT", "/account", { username: "svc2fa" });
    expect(again.status).toBe(200);
    expect((await settings.load()).password).toBe("pw");
  });

  test("a password is required to switch accounts", async () => {
    const { call } = await setup();
    await call("PUT", "/account", { username: "svc", password: "pw" });
    expect((await call("PUT", "/account", { username: "svc2fa" })).status).toBe(400);
  });

  test("edits the rights file", async () => {
    const { call, permissions } = await setup();
    const current = (await call("GET", "/permissions")).body;
    expect(current.domains.files).toBe("ro");

    const domains = { ...current.domains, files: "rw", system: "off" };
    expect((await call("PUT", "/permissions", { domains: { ...domains, files: "all" } })).status).toBe(400);
    const saved = await call("PUT", "/permissions", { domains, allowedUsers: ["leo", "leo", "alice"] });
    expect(saved.body).toEqual({ domains, allowedUsers: ["leo", "alice"] });
    expect((await permissions.load()).domains.files).toBe("rw");
    expect(await Bun.file(permissions.path).text()).toContain("# File Station");
  });

  test("refuses writes that are not JSON, so other sites cannot post forms here", async () => {
    const { dataDir } = await setup();
    const service = new McpService({ dataDir, settings: new SettingsFile(join(dataDir, "s.json")), permissions: new PermissionsFile(join(dataDir, "permissions.yml")) });
    const app = createAdminApp({ auth: fakeAuth(), service, settings: new SettingsFile(join(dataDir, "s.json")), permissions: new PermissionsFile(join(dataDir, "permissions.yml")) });
    const res = await app.fetch(
      new Request(`https://nas.test${ADMIN_PREFIX}/public-url`, {
        method: "PUT",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "publicUrl=https://evil.example",
      }),
      "1.2.3.4",
    );
    expect(res.status).toBe(415);
  });

  test("lists and revokes the OAuth sessions", async () => {
    const { call, service } = await setup();
    await call("PUT", "/account", { username: "svc", password: "pw" });
    await call("PUT", "/public-url", { publicUrl: "https://mcp.example.com" });
    const store = service.store!;
    const now = Date.now();
    store.clients.set("c1", { client_id: "c1", client_id_issued_at: 0, metadata: { client_name: "Claude", redirect_uris: [] } as never });
    const grant = { family: "f1", clientId: "c1", user: "leo", scope: "mcp", familyExpiresAt: now + 1e9 };
    store.refreshGrants.set("old", { ...grant, hash: "old", expiresAt: now + 1000, usedAt: now });
    store.refreshGrants.set("new", { ...grant, hash: "new", expiresAt: now + 2000 });

    const sessions = (await call("GET", "/sessions")).body;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ family: "f1", user: "leo", client: "Claude" });

    expect((await call("DELETE", "/sessions/f1")).status).toBe(200);
    expect((await call("GET", "/sessions")).body).toEqual([]);
  });

  test("shows the audit log, newest first", async () => {
    const { call, service } = await setup();
    const line = (tool: string) => `${JSON.stringify({ time: "2026-10-25T10:00:00Z", user: "leo", tool, outcome: "ok" })}\n`;
    await appendFile(service.auditFile, line("file_delete") + "{broken\n" + line("container_stop"));
    const entries = (await call("GET", "/audit?limit=10")).body;
    expect(entries.map((e: { tool: string }) => e.tool)).toEqual(["container_stop", "file_delete"]);
  });
});

describe("McpService", () => {
  test("waits for DSM when it cannot be reached, without losing the account", async () => {
    const { call, nas, settings } = await setup();
    await call("PUT", "/account", { username: "svc", password: "pw" });
    nas.down = true;
    const res = await call("POST", "/restart");
    expect(res.body.status.state).toBe("error");
    expect((await settings.load()).username).toBe("svc");
  });
});

describe("DsmSessionAuth", () => {
  const request = (headers: Record<string, string>) => new Request("https://nas.test/synology-mcp/api/state", { headers });
  const signedIn = { cookie: "id=abc", "x-syno-token": "tok" };

  function runner(users: Record<string, string>, groups: Record<string, string>): Runner & { calls: string[][] } {
    const calls: string[][] = [];
    const run = (async (cmd: string[], env: Record<string, string>) => {
      calls.push(cmd);
      if (cmd[0] === "id") return groups[cmd[2]!];
      return users[`${env.HTTP_COOKIE}|${env.HTTP_X_SYNO_TOKEN}|${env.REMOTE_ADDR}`] ?? "";
    }) as Runner & { calls: string[][] };
    run.calls = calls;
    return run;
  }

  test("asks DSM who the session belongs to, then checks the administrators group", async () => {
    const run = runner({ "id=abc|tok|10.0.0.2": "leo\n", "id=def|tok|10.0.0.2": "alice\n" }, { leo: "users administrators\n", alice: "users\n" });
    const auth = new DsmSessionAuth(run, "/authenticate.cgi");
    expect(await auth.check(request(signedIn), "10.0.0.2")).toEqual({ user: "leo" });
    expect(await auth.check(request({ cookie: "id=def", "x-syno-token": "tok" }), "10.0.0.2")).toEqual({ refused: "not-admin" });
    expect(await auth.check(request(signedIn), "10.0.0.9")).toEqual({ refused: "signed-out" });
  });

  test("needs both the session cookie and the SynoToken", async () => {
    const run = runner({}, {});
    const auth = new DsmSessionAuth(run, "/authenticate.cgi");
    expect(await auth.check(request({ cookie: "id=abc" }), "10.0.0.2")).toEqual({ refused: "signed-out" });
    expect(run.calls).toEqual([]);
  });

  test("never passes a suspicious user name to id", async () => {
    const run = runner({ "id=abc|tok|10.0.0.2": "-n root" }, {});
    expect(await new DsmSessionAuth(run, "/authenticate.cgi").check(request(signedIn), "10.0.0.2")).toEqual({ refused: "signed-out" });
    expect(run.calls.some((c) => c[0] === "id")).toBe(false);
  });

  test("caches answers briefly", async () => {
    let clock = 0;
    const run = runner({ "id=abc|tok|10.0.0.2": "leo" }, { leo: "administrators" });
    const auth = new DsmSessionAuth(run, "/authenticate.cgi", () => clock);
    await auth.check(request(signedIn), "10.0.0.2");
    await auth.check(request(signedIn), "10.0.0.2");
    expect(run.calls).toHaveLength(2);
    clock = 31_000;
    await auth.check(request(signedIn), "10.0.0.2");
    expect(run.calls).toHaveLength(4);
  });
});

describe("SettingsFile", () => {
  test("keeps the password readable by the package only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "synology-mcp-settings-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const file = new SettingsFile(join(dir, "settings.json"));
    await file.update({ username: "svc", password: "pw" });
    expect(await file.load()).toEqual({ username: "svc", password: "pw" });
    if (process.platform !== "win32") expect((await stat(file.path)).mode & 0o777).toBe(0o600);
  });
});
