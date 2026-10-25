import { chmod, mkdir, stat } from "node:fs/promises";
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

/** Written on first start: everything readable, nothing writable. */
export const DEFAULT_PERMISSIONS_FILE = `# Droits du serveur MCP sur chaque partie du NAS, relus à chaque requête (pas besoin de redémarrer).
#   off : aucun outil
#   ro  : lecture seule
#   rw  : tout, y compris supprimer, désinstaller, redémarrer ou éteindre le NAS
# Une partie absente vaut off.

system: ro       # état, ressources, mises à jour, journaux, connexions, redémarrage/arrêt
storage: ro      # volumes, groupes de stockage, disques
packages: ro     # paquets DSM : lister, démarrer/arrêter, désinstaller
containers: ro   # Container Manager : conteneurs, journaux, images, projets
files: ro        # File Station : parcourir, chercher, lire/écrire, copier/déplacer, supprimer
shares: ro       # dossiers partagés et leurs permissions
users: ro        # utilisateurs et groupes DSM
discovery: ro    # appels directs à l'API DSM (ro : méthodes de lecture seulement)

# Comptes DSM autorisés à se connecter par OAuth (serveur distant). Sans cette liste,
# tout compte DSM actif peut se connecter, avec les droits ci-dessus.
# allowed_users:
#   - leo
`;

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
