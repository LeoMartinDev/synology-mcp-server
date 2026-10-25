import { join } from "node:path";
import { type Config, loadConfig } from "../config";
import { type RunningHttpServer, serveHttp } from "../http";
import { SIGN_IN_ERRORS } from "../oauth/accounts";
import type { OAuthStore } from "../oauth/store";
import type { PermissionsSource } from "../permissions";
import { type FetchLike, SynologyClient } from "../synology/client";
import { SynologyError } from "../synology/errors";
import { AuditLog } from "../tools/toolbox";
import type { PackageSettings, SettingsFile } from "./settings";

/** Where the MCP server stands, as the DSM app shows it. */
export type ServiceStatus =
  | { state: "needs-account"; error?: string }
  | { state: "needs-public-url" }
  | { state: "running"; since: number }
  | { state: "error"; error: string };

/**
 * The package's fixed configuration: DSM on the same machine, the MCP server on localhost behind DSM's
 * reverse proxy. start-stop-status may override any of it through SYNO_* variables.
 */
const PACKAGE_DEFAULTS = {
  SYNO_URL: "https://127.0.0.1:5001",
  // DSM's certificate names the NAS, not 127.0.0.1; the connection never leaves the machine.
  SYNO_INSECURE_TLS: "true",
  SYNO_HTTP_HOST: "127.0.0.1",
  SYNO_HTTP_PORT: "8089",
  SYNO_TRUST_PROXY: "true",
};

/** The server's configuration for these settings; `env` holds overrides (SYNO_* variables only). */
export function packageConfig(settings: PackageSettings, dataDir: string, env: Record<string, string> = {}): Config {
  return loadConfig({
    ...PACKAGE_DEFAULTS,
    SYNO_AUDIT_LOG: join(dataDir, "audit.log"),
    ...env,
    SYNO_TRANSPORT: "http",
    SYNO_DATA_DIR: dataDir,
    SYNO_USERNAME: settings.username,
    SYNO_PASSWORD: settings.password,
    SYNO_DEVICE_ID: settings.deviceId,
    // Placeholder while the public address is not set: the server is not started without one.
    SYNO_PUBLIC_URL: settings.publicUrl ?? "http://localhost",
  });
}

/** A failed login of the service account, in words for the DSM app. */
export function describeLoginError(err: unknown): string {
  if (err instanceof SynologyError && err.api === "SYNO.API.Auth") {
    return SIGN_IN_ERRORS[err.code] ?? `DSM a refusé la connexion (code ${err.code}).`;
  }
  return err instanceof Error ? err.message : String(err);
}

export class AccountError extends Error {
  override name = "AccountError";
}

export interface ServiceOptions {
  dataDir: string;
  settings: SettingsFile;
  permissions: PermissionsSource;
  /** SYNO_* overrides of the package defaults. */
  env?: Record<string, string>;
  fetchImpl?: FetchLike;
  /** Delay before trying again when DSM cannot be reached (it may still be starting at boot). */
  retryMs?: number;
}

/** Runs the MCP server with the current settings, and restarts it when the DSM app changes them. */
export class McpService {
  private running?: { server: RunningHttpServer; client: SynologyClient };
  private current: ServiceStatus = { state: "needs-account" };
  private queue: Promise<unknown> = Promise.resolve();
  private retry?: Timer;

  constructor(private readonly options: ServiceOptions) {}

  get status(): ServiceStatus {
    return this.current;
  }

  /** The OAuth state of the running server: its clients and sessions. */
  get store(): OAuthStore | undefined {
    return this.running?.server.store;
  }

  config(settings: PackageSettings): Config {
    return packageConfig(settings, this.options.dataDir, this.options.env);
  }

  /** The local port the reverse proxy must forward to. */
  get port(): number {
    return Number(this.options.env?.SYNO_HTTP_PORT || PACKAGE_DEFAULTS.SYNO_HTTP_PORT);
  }

  get auditFile(): string {
    return this.options.env?.SYNO_AUDIT_LOG || join(this.options.dataDir, "audit.log");
  }

  /** Stops the server if it runs, then starts it again with the saved settings. */
  restart(): Promise<ServiceStatus> {
    return this.serialize(async () => {
      await this.shutdown();
      this.current = await this.start();
      if (this.current.state === "error") {
        this.retry = setTimeout(() => void this.restart(), this.options.retryMs ?? 30_000);
        this.retry.unref?.();
      }
      return this.current;
    });
  }

  stop(): Promise<unknown> {
    return this.serialize(() => this.shutdown());
  }

  /**
   * Checks an account before it is saved; with a 2FA code, returns a device token so later logins need
   * none. Throws an AccountError with a message for the DSM app.
   */
  async verifyAccount(username: string, password: string, otpCode?: string, deviceId?: string): Promise<string | undefined> {
    const config = this.config({ username, password, deviceId: otpCode ? undefined : deviceId });
    const client = new SynologyClient(config, this.options.fetchImpl);
    try {
      if (otpCode) return await client.loginWithOtp(otpCode);
      await client.connect();
      return deviceId;
    } catch (err) {
      throw new AccountError(describeLoginError(err));
    } finally {
      await client.logout().catch(() => {});
    }
  }

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run);
    this.queue = next.catch(() => {});
    return next;
  }

  private async start(): Promise<ServiceStatus> {
    const settings = await this.options.settings.load();
    if (!settings.username || !settings.password) return { state: "needs-account" };
    const config = this.config(settings);
    const client = new SynologyClient(config, this.options.fetchImpl);
    try {
      await client.connect();
    } catch (err) {
      const auth = err instanceof SynologyError && err.api === "SYNO.API.Auth";
      const error = describeLoginError(err);
      console.error(`[package] service account ${settings.username}: ${error}`);
      return auth ? { state: "needs-account", error } : { state: "error", error };
    }
    if (!settings.publicUrl) {
      await client.logout().catch(() => {});
      return { state: "needs-public-url" };
    }
    try {
      const server = await serveHttp(config, client, new AuditLog(config.auditLog), this.options.permissions);
      this.running = { server, client };
      return { state: "running", since: Date.now() };
    } catch (err) {
      await client.logout().catch(() => {});
      return { state: "error", error: (err as Error).message };
    }
  }

  private async shutdown(): Promise<void> {
    clearTimeout(this.retry);
    const running = this.running;
    this.running = undefined;
    if (!running) return;
    await running.server.stop();
    await running.client.logout().catch(() => {});
  }
}
