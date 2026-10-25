import { chmod, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { PublicUrlSchema } from "../config";

/** What the install wizard and the DSM app configure; the rest of the package's configuration is fixed. */
export interface PackageSettings {
  /** The service account the server acts as on DSM. */
  username?: string;
  password?: string;
  /** 2FA device token of the service account, obtained from a one-time code. */
  deviceId?: string;
  /** Public HTTPS origin the reverse proxy serves the server at. */
  publicUrl?: string;
}

const SettingsSchema = z.object({
  username: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  deviceId: z.string().min(1).optional(),
  publicUrl: PublicUrlSchema.optional(),
});

/** settings.json in the package's data folder; it holds the service account's password, so only the package reads it. */
export class SettingsFile {
  constructor(readonly path: string) {}

  async load(): Promise<PackageSettings> {
    const file = Bun.file(this.path);
    if (!(await file.exists())) return {};
    const parsed = SettingsSchema.safeParse(await file.json());
    if (!parsed.success) throw new Error(`${this.path}: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    return parsed.data;
  }

  async save(settings: PackageSettings): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await Bun.write(tmp, JSON.stringify(settings, null, 2));
    await chmod(tmp, 0o600);
    await rename(tmp, this.path);
  }

  async update(change: Partial<PackageSettings>): Promise<PackageSettings> {
    const next = { ...(await this.load()), ...change };
    await this.save(next);
    return next;
  }
}
