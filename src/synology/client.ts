import type { Config } from "../config";
import { SESSION_ERROR_CODES, SynologyError } from "./errors";

export interface ApiInfo {
  path: string;
  minVersion: number;
  maxVersion: number;
  /** "JSON" means every parameter value must be JSON-encoded (strings quoted). */
  requestFormat?: string;
}

/**
 * How parameter values are serialized:
 * - auto: follow the API's `requestFormat` reported by SYNO.API.Info
 * - json: JSON-encode every value (strings are quoted)
 * - raw:  strings as-is, other values JSON-encoded
 */
export type Encoding = "auto" | "json" | "raw";

/** Forces JSON encoding of one value whatever the API's request format (e.g. File Station task ids). */
export class JsonParam {
  constructor(readonly value: unknown) {}
}
export const asJson = (value: unknown) => new JsonParam(value);

export function encodeParams(params: Record<string, unknown>, json: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (value instanceof JsonParam) out[key] = JSON.stringify(value.value);
    else if (typeof value === "string" && !json) out[key] = value;
    else out[key] = JSON.stringify(value);
  }
  return out;
}

export interface CallOptions {
  /** Preferred API version; falls back to the highest supported one when the NAS doesn't offer it. */
  version?: number;
  encoding?: Encoding;
}

/** A file sent with `upload`. */
export interface UploadFile {
  name: string;
  content: string | Uint8Array;
}

/** `anonymous` leaves out the client's own session, for requests made on behalf of another account. */
type SendOptions = CallOptions & { file?: UploadFile; anonymous?: boolean };

/** DSM session name of the throwaway logins made by checkCredentials. */
const CHECK_SESSION = "SynologyMCPSignIn";

export type ClientOptions = Pick<
  Config,
  "url" | "username" | "password" | "deviceId" | "deviceName" | "session" | "insecureTls" | "timeoutMs" | "debug"
> & {
  /** Supplies a fresh 2FA code when logging in without a device token. */
  otp?: () => Promise<string>;
};

type FetchInit = RequestInit & { tls?: { rejectUnauthorized?: boolean } };
export type FetchLike = (url: string, init: FetchInit) => Promise<Response>;

interface DsmResponse<T> {
  success: boolean;
  data?: T;
  error?: { code: number; errors?: unknown };
}

interface LoginData {
  sid: string;
  synotoken?: string;
  // The device token: `did` on DSM 6, `device_id` on DSM 7.
  did?: string;
  device_id?: string;
}

const REDACTED_KEYS = new Set(["passwd", "password", "otp_code", "device_id", "_sid"]);

function parseEnvelope(bytes: Uint8Array): DsmResponse<unknown> | undefined {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

/**
 * Minimal DSM Web API client: discovers APIs through SYNO.API.Info, logs in lazily,
 * and transparently logs in again once when the session expires.
 */
export class SynologyClient {
  private apis?: Record<string, ApiInfo>;
  private sid?: string;
  private synoToken?: string;
  private loginInFlight?: Promise<void>;
  private deviceId?: string;

  constructor(
    private readonly options: ClientOptions,
    private readonly fetchImpl: FetchLike = fetch as FetchLike,
  ) {
    this.deviceId = options.deviceId;
  }

  async listApis(): Promise<Record<string, ApiInfo>> {
    if (!this.apis) {
      const res = await this.fetch("/webapi/query.cgi?api=SYNO.API.Info&version=1&method=query&query=all", {
        method: "GET",
      });
      this.apis = await this.unwrap<Record<string, ApiInfo>>("SYNO.API.Info", "query", res);
    }
    return this.apis;
  }

  async call<T = unknown>(
    api: string,
    method: string,
    params: Record<string, unknown> = {},
    options: CallOptions = {},
  ): Promise<T> {
    return this.withSession(() => this.request<T>(api, method, params, options));
  }

  /** Calls a method that answers with the raw bytes of a file instead of a JSON envelope. */
  async download(
    api: string,
    method: string,
    params: Record<string, unknown> = {},
    options: CallOptions = {},
  ): Promise<Uint8Array> {
    return this.withSession(async () => {
      const res = await this.send(api, method, params, options);
      const bytes = new Uint8Array(await res.arrayBuffer());
      // Failures still come back as a JSON envelope.
      if (res.headers.get("content-type")?.includes("json")) {
        const payload = parseEnvelope(bytes);
        if (payload?.success === false) {
          throw new SynologyError(api, method, payload.error?.code ?? 100, payload.error?.errors);
        }
      }
      return bytes;
    });
  }

  /** Sends a file as multipart/form-data, after the other parameters as File Station requires. */
  async upload<T = unknown>(
    api: string,
    method: string,
    params: Record<string, unknown>,
    file: UploadFile,
    options: CallOptions = {},
  ): Promise<T> {
    return this.withSession(() => this.request<T>(api, method, params, { ...options, file }));
  }

  /** Logs in now rather than at the first call, to check the account works. */
  async connect(): Promise<void> {
    await this.ensureSession();
  }

  /** Logs in with a one-time 2FA code and returns a device token that skips 2FA on later logins. */
  async loginWithOtp(otpCode: string): Promise<string> {
    const data = await this.login({ otp_code: otpCode, enable_device_token: "yes" });
    const token = data.device_id ?? data.did;
    if (!token) throw new Error("DSM did not return a device token");
    return token;
  }

  /**
   * Checks another account's password (and 2FA code) with a throwaway DSM session, closed right away.
   * Throws a SynologyError: 400 wrong credentials, 403 2FA code required, 404 wrong 2FA code…
   */
  async checkCredentials(account: string, password: string, otpCode?: string): Promise<void> {
    const anonymous = { anonymous: true };
    const { sid } = await this.request<LoginData>(
      "SYNO.API.Auth",
      "login",
      { account, passwd: password, session: CHECK_SESSION, format: "sid", otp_code: otpCode || undefined },
      anonymous,
    );
    await this.request("SYNO.API.Auth", "logout", { session: CHECK_SESSION, _sid: sid }, anonymous).catch(() => {});
  }

  async logout(): Promise<void> {
    if (!this.sid) return;
    try {
      await this.request("SYNO.API.Auth", "logout", { session: this.options.session });
    } finally {
      this.clearSession();
    }
  }

  /** Runs a request with a session, logging in again once if DSM says the session is gone. */
  private async withSession<T>(run: () => Promise<T>): Promise<T> {
    await this.ensureSession();
    const sid = this.sid;
    try {
      return await run();
    } catch (err) {
      if (!(err instanceof SynologyError) || !SESSION_ERROR_CODES.has(err.code)) throw err;
      if (this.sid === sid) this.clearSession();
      await this.ensureSession();
      return run();
    }
  }

  private async ensureSession(): Promise<void> {
    if (this.sid) return;
    this.loginInFlight ??= this.login()
      .then(() => undefined)
      .finally(() => {
        this.loginInFlight = undefined;
      });
    await this.loginInFlight;
  }

  private async login(extra: Record<string, string> = {}): Promise<LoginData> {
    const { username, password, session, deviceName, otp } = this.options;
    const deviceId = this.deviceId;
    const twoFactor =
      !deviceId && otp && !extra.otp_code ? { otp_code: await otp(), enable_device_token: "yes" } : {};
    const data = await this.request<LoginData>("SYNO.API.Auth", "login", {
      account: username,
      passwd: password,
      session,
      format: "sid",
      enable_syno_token: "yes",
      device_name: deviceName,
      device_id: deviceId,
      ...twoFactor,
      ...extra,
    });
    // Keep the device token so later logins of this process need no new 2FA code.
    if (twoFactor.otp_code || extra.otp_code) this.deviceId = data.device_id ?? data.did ?? this.deviceId;
    this.sid = data.sid;
    this.synoToken = data.synotoken;
    return data;
  }

  private clearSession(): void {
    this.sid = undefined;
    this.synoToken = undefined;
  }

  private async request<T>(
    api: string,
    method: string,
    params: Record<string, unknown>,
    options: SendOptions = {},
  ): Promise<T> {
    const res = await this.send(api, method, params, options);
    return this.unwrap<T>(api, method, res);
  }

  private async send(
    api: string,
    method: string,
    params: Record<string, unknown>,
    options: SendOptions = {},
  ): Promise<Response> {
    const info = (await this.listApis())[api];
    if (!info) throw new SynologyError(api, method, 102);

    const wanted = options.version;
    const version =
      wanted !== undefined && wanted >= info.minVersion && wanted <= info.maxVersion ? wanted : info.maxVersion;
    const encoding = options.encoding ?? "auto";
    const json = encoding === "json" || (encoding === "auto" && info.requestFormat === "JSON");
    const encoded = encodeParams(params, json);

    const sid = options.anonymous ? undefined : this.sid;
    const target = { api, version: String(version), method, ...(sid ? { _sid: sid } : {}) };
    let path = `/webapi/${info.path}`;
    let body: URLSearchParams | FormData;
    if (options.file) {
      // The API selection goes in the query string; the form holds the parameters, then the file.
      path += `?${new URLSearchParams(target)}`;
      body = new FormData();
      for (const [key, value] of Object.entries(encoded)) body.append(key, value);
      body.append("file", new Blob([options.file.content]), options.file.name);
    } else {
      body = new URLSearchParams({ ...target, ...encoded });
    }
    const headers: Record<string, string> = {};
    if (this.synoToken && !options.anonymous) headers["X-SYNO-TOKEN"] = this.synoToken;

    if (this.options.debug) {
      const shown = Object.fromEntries(
        Object.entries(encoded).map(([k, v]) => [k, REDACTED_KEYS.has(k) ? "***" : v]),
      );
      console.error(`[synology] → ${api}.${method} v${version}`, JSON.stringify(shown));
    }

    return this.fetch(path, { method: "POST", body, headers });
  }

  private async fetch(path: string, init: FetchInit): Promise<Response> {
    const url = this.options.url + path;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(this.options.timeoutMs),
        tls: this.options.insecureTls ? { rejectUnauthorized: false } : undefined,
      });
    } catch (err) {
      throw new Error(`Cannot reach ${this.options.url}: ${(err as Error).message}`, { cause: err });
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} from ${url.split("?")[0]}`);
    return res;
  }

  private async unwrap<T>(api: string, method: string, res: Response): Promise<T> {
    const payload = (await res.json()) as DsmResponse<T>;
    if (this.options.debug) console.error(
        `[synology] ← ${api}.${method} ${payload.success ? "ok" : `error ${payload.error?.code}`}`,
      );
    if (!payload.success) throw new SynologyError(api, method, payload.error?.code ?? 100, payload.error?.errors);
    return payload.data as T;
  }
}
