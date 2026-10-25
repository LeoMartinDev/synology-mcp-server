import { type Config, DEFAULT_REDIRECT_URIS } from "../src/config";
import { DOMAINS, type Domain, type Permission, type Permissions, type PermissionsSource } from "../src/permissions";
import type { ApiInfo, FetchLike } from "../src/synology/client";

type DsmReply = { success: boolean; data?: unknown; error?: { code: number; errors?: unknown } };
/** Answers one "API.method"; a Response is sent as-is (e.g. a file download). */
export type Route = (params: URLSearchParams, files: File[]) => DsmReply | Response;

const entry = (maxVersion: number, requestFormat?: string): ApiInfo => ({
  path: "entry.cgi",
  minVersion: 1,
  maxVersion,
  ...(requestFormat ? { requestFormat } : {}),
});

export const DEFAULT_APIS: Record<string, ApiInfo> = {
  "SYNO.API.Auth": { path: "entry.cgi", minVersion: 1, maxVersion: 7 },
  "SYNO.Docker.Container": entry(1, "JSON"),
  "SYNO.Docker.Image": entry(1, "JSON"),
  "SYNO.FileStation.List": entry(2),
  "SYNO.FileStation.Delete": entry(2),
  "SYNO.FileStation.CopyMove": entry(3),
  "SYNO.FileStation.DirSize": entry(2),
  "SYNO.FileStation.Search": entry(2),
  "SYNO.FileStation.Download": entry(2),
  "SYNO.FileStation.Upload": { path: "entry.cgi", minVersion: 2, maxVersion: 3, requestFormat: "JSON" },
  "SYNO.Core.Package": entry(2, "JSON"),
  "SYNO.Core.Package.Control": entry(1, "JSON"),
  "SYNO.Core.Storage.Volume": entry(1, "JSON"),
  "SYNO.Core.Storage.Pool": entry(1, "JSON"),
  "SYNO.Core.Storage.Disk": entry(1, "JSON"),
  "SYNO.Core.Share": entry(1, "JSON"),
  "SYNO.Core.Share.Permission": entry(1, "JSON"),
};

/** Every part at one permission, with optional overrides: perms("ro", { files: "rw" }). */
export function perms(all: Permission, overrides: Partial<Record<Domain, Permission>> = {}): Record<Domain, Permission> {
  return { ...(Object.fromEntries(DOMAINS.map((d) => [d, all])) as Record<Domain, Permission>), ...overrides };
}

/** An in-memory permissions file, editable by tests. */
export function memoryPermissions(initial: Permissions): PermissionsSource & { current: Permissions } {
  const source = { path: "memory", current: initial, load: async () => source.current };
  return source;
}

export function testConfig(): Config {
  return {
    url: "https://nas.test:5001",
    username: "agent",
    password: "s3cret",
    deviceName: "SynologyMCP",
    session: "webui",
    insecureTls: false,
    timeoutMs: 5_000,
    debug: false,
    transport: "stdio",
    dataDir: "unused",
    permissionsFile: "unused/permissions.yml",
    http: {
      publicUrl: "https://mcp.nas.test",
      host: "127.0.0.1",
      port: 8080,
      redirectUris: DEFAULT_REDIRECT_URIS,
      trustProxy: false,
      globalSignInLimit: 8,
    },
  };
}

/** DSM accounts other than the service account, checked at login (DSM error 400 / 403 / 404). */
export type FakeUsers = Record<string, { password: string; otp?: string }>;

/** An in-memory DSM: answers SYNO.API.Info and Auth itself, other calls through `routes`. */
export function fakeNas(routes: Record<string, Route> = {}, apis = DEFAULT_APIS, users: FakeUsers = {}) {
  const calls: { params: URLSearchParams; files: File[]; headers: Record<string, string>; url: string }[] = [];
  let logins = 0;
  const loginParams: URLSearchParams[] = [];

  const state = { down: false };
  const fetchImpl: FetchLike = async (url, init) => {
    if (state.down) throw new Error("connection refused");
    if (url.includes("/webapi/query.cgi")) return Response.json({ success: true, data: apis });

    // Parameters may come in the query string, a urlencoded body, or a multipart form with files.
    const [path, query] = url.split("?");
    const params = new URLSearchParams(query);
    const files: File[] = [];
    if (init.body instanceof FormData) {
      init.body.forEach((v, k) => (typeof v === "string" ? params.append(k, v) : files.push(v)));
    } else {
      for (const [k, v] of new URLSearchParams(init.body as URLSearchParams)) params.append(k, v);
    }
    const key = `${params.get("api")}.${params.get("method")}`;
    if (key === "SYNO.API.Auth.login") {
      const user = users[params.get("account") ?? ""];
      if (user) {
        loginParams.push(params);
        // A device token from an earlier 2FA login replaces the code.
        const trusted = params.get("device_id") === `device-${params.get("account")}`;
        const needsOtp = user.otp && !trusted;
        const code =
          params.get("passwd") !== user.password ? 400 : needsOtp && !params.get("otp_code") ? 403 : needsOtp && params.get("otp_code") !== user.otp ? 404 : 0;
        if (code) return Response.json({ success: false, error: { code } });
        const did = params.get("enable_device_token") === "yes" ? { device_id: `device-${params.get("account")}` } : {};
        return Response.json({ success: true, data: { sid: `user-sid-${params.get("account")}`, ...did } });
      }
      logins++;
      loginParams.push(params);
      const did = params.get("enable_device_token") === "yes" ? { device_id: "device-1" } : {};
      return Response.json({ success: true, data: { sid: `sid-${logins}`, synotoken: `token-${logins}`, ...did } });
    }
    calls.push({ params, files, headers: init.headers as Record<string, string>, url: path! });
    if (key === "SYNO.API.Auth.logout") return Response.json({ success: true });
    const reply = routes[key]?.(params, files) ?? { success: false, error: { code: 103 } };
    return reply instanceof Response ? reply : Response.json(reply);
  };

  return {
    fetchImpl,
    calls,
    loginParams,
    get logins() {
      return logins;
    },
    /** Simulates an unreachable NAS. */
    get down() {
      return state.down;
    },
    set down(value: boolean) {
      state.down = value;
    },
    /** Calls made to a given "API.method". */
    callsTo: (key: string) => calls.filter((c) => `${c.params.get("api")}.${c.params.get("method")}` === key),
  };
}
