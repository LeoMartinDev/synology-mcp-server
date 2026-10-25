import { chmod, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

/** The parts of the server, one per folder of src/tools/. */
export const DOMAINS = ["system", "storage", "packages", "containers", "files", "shares", "users", "discovery"] as const;
export type Domain = (typeof DOMAINS)[number];

/** off: no tool; ro: tools that only read; rw: every tool, deletions, uninstall and reboot included. */
export const PERMISSIONS = ["off", "ro", "rw"] as const;
export type Permission = (typeof PERMISSIONS)[number];

export interface Permissions {
  domains: Record<Domain, Permission>;
  /** DSM accounts allowed to sign in over HTTP; undefined lets every active account in. */
  allowedUsers?: string[];
}

const FileSchema = z
  .object({
    ...Object.fromEntries(DOMAINS.map((d) => [d, z.enum(PERMISSIONS).optional()])),
    allowed_users: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

/** What each part covers, written next to its line in the file. */
export const DOMAIN_DESCRIPTIONS: Record<Domain, string> = {
  system: "état, ressources, mises à jour, journaux, connexions, redémarrage/arrêt",
  storage: "volumes, groupes de stockage, disques",
  packages: "paquets DSM : lister, démarrer/arrêter, désinstaller",
  containers: "Container Manager : conteneurs, journaux, images, projets",
  files: "File Station : parcourir, chercher, lire/écrire, copier/déplacer, supprimer",
  shares: "dossiers partagés et leurs permissions",
  users: "utilisateurs et groupes DSM",
  discovery: "appels directs à l'API DSM (ro : méthodes de lecture seulement)",
};

/** The permissions file for these rights, with its explanations (the DSM app rewrites it this way). */
export function formatPermissions({ domains, allowedUsers }: Permissions): string {
  const width = Math.max(...DOMAINS.map((d) => d.length)) + 6;
  const lines = DOMAINS.map((d) => `${`${d}: ${domains[d]}`.padEnd(width)}# ${DOMAIN_DESCRIPTIONS[d]}`);
  const users = allowedUsers?.length
    ? ["allowed_users:", ...allowedUsers.map((u) => `  - ${JSON.stringify(u)}`)]
    : ["# allowed_users:", "#   - leo"];
  return `# Droits du serveur MCP sur chaque partie du NAS, relus à chaque requête (pas besoin de redémarrer).
#   off : aucun outil
#   ro  : lecture seule
#   rw  : tout, y compris supprimer, désinstaller, redémarrer ou éteindre le NAS
# Une partie absente vaut off.

${lines.join("\n")}

# Comptes DSM autorisés à se connecter par OAuth (serveur distant). Sans cette liste,
# tout compte DSM actif peut se connecter, avec les droits ci-dessus.
${users.join("\n")}
`;
}

/** Written on first start: everything readable, nothing writable. */
export const DEFAULT_PERMISSIONS_FILE = formatPermissions({
  domains: Object.fromEntries(DOMAINS.map((d) => [d, "ro"])) as Record<Domain, Permission>,
});

export function parsePermissions(text: string): Permissions {
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(text) ?? {};
  } catch (err) {
    throw new Error(`invalid YAML: ${(err as Error).message}`);
  }
  const parsed = FileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(issues);
  }
  const data = parsed.data as Partial<Record<Domain, Permission>> & { allowed_users?: string[] };
  return {
    domains: Object.fromEntries(DOMAINS.map((d) => [d, data[d] ?? "off"])) as Record<Domain, Permission>,
    allowedUsers: data.allowed_users,
  };
}

/** Where the current permissions come from; tests use an in-memory one. */
export interface PermissionsSource {
  readonly path: string;
  load(): Promise<Permissions>;
}

/**
 * The permissions file, re-read when it changes. A broken edit keeps the last valid version (and is logged),
 * so a typo never opens or closes access by surprise.
 */
export class PermissionsFile implements PermissionsSource {
  private current?: Permissions;
  private mtime = -1;

  constructor(readonly path: string) {}

  /** Loads the file, creating it with read-only defaults when missing; throws if the first read is invalid. */
  async open(): Promise<Permissions> {
    const file = Bun.file(this.path);
    if (!(await file.exists())) {
      await mkdir(dirname(this.path), { recursive: true });
      await Bun.write(this.path, DEFAULT_PERMISSIONS_FILE);
      // Created by the container's root user: world-writable, so it can be edited from File Station / Text Editor.
      await chmod(this.path, 0o666).catch(() => {});
      console.error(`[permissions] created ${this.path} (everything read-only); edit it to change the rights`);
    }
    try {
      return await this.load();
    } catch (err) {
      throw new Error(`${this.path}: ${(err as Error).message}`);
    }
  }

  /** Replaces the file (from the DSM app); the next load picks the new rights up. */
  async save(permissions: Permissions): Promise<void> {
    const tmp = `${this.path}.tmp`;
    await Bun.write(tmp, formatPermissions(permissions));
    await rename(tmp, this.path);
  }

  async load(): Promise<Permissions> {
    const mtime = await stat(this.path).then(
      (s) => s.mtimeMs,
      () => -1,
    );
    if (this.current && mtime === this.mtime) return this.current;
    try {
      const next = parsePermissions(await Bun.file(this.path).text());
      if (this.current) console.error(`[permissions] reloaded ${this.path}`);
      this.current = next;
      this.mtime = mtime;
    } catch (err) {
      if (!this.current) throw err;
      console.error(`[permissions] ${this.path} ignored, keeping the previous rights: ${(err as Error).message}`);
      this.mtime = mtime;
    }
    return this.current;
  }
}
