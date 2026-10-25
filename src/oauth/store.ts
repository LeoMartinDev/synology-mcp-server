import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type { OAuthClientMetadata } from "@modelcontextprotocol/server";
import { hashToken } from "./tokens";

export interface StoredClient {
  client_id: string;
  /** Hash of the secret of confidential clients; public clients (PKCE only) have none. */
  secret_hash?: string;
  client_id_issued_at: number;
  metadata: OAuthClientMetadata;
}

/** A refresh token, kept by hash. Rotated tokens stay (with usedAt) to detect their reuse. */
export interface RefreshGrant {
  hash: string;
  /** Every token rotated from one sign-in shares a family, revoked as a whole on reuse. */
  family: string;
  /** End of the sign-in, whatever the refreshes. */
  familyExpiresAt: number;
  clientId: string;
  user: string;
  scope: string;
  expiresAt: number;
  usedAt?: number;
}

/** Short-lived grants live in memory only: a restart just makes clients refresh or sign in again. */
export interface AccessGrant {
  family: string;
  clientId: string;
  user: string;
  scope: string;
  expiresAt: number;
}

export interface AuthorizationCode {
  family: string;
  familyExpiresAt: number;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  user: string;
  scope: string;
  expiresAt: number;
}

interface PersistedState {
  clients: StoredClient[];
  refreshGrants: RefreshGrant[];
}

/** OAuth state: clients and refresh tokens persisted to a JSON file, the rest in memory. */
export class OAuthStore {
  readonly clients = new Map<string, StoredClient>();
  readonly refreshGrants = new Map<string, RefreshGrant>();
  readonly accessGrants = new Map<string, AccessGrant>();
  readonly codes = new Map<string, AuthorizationCode>();
  private saving: Promise<void> = Promise.resolve();

  private constructor(
    private readonly file: string | undefined,
    private readonly now: () => number,
  ) {}

  /** Loads the state file from `dataDir`, or keeps everything in memory when it is undefined (tests). */
  static async open(dataDir: string | undefined, now = Date.now): Promise<OAuthStore> {
    const store = new OAuthStore(dataDir && join(dataDir, "oauth.json"), now);
    if (dataDir) {
      await mkdir(dataDir, { recursive: true });
      const file = Bun.file(store.file!);
      if (await file.exists()) {
        const state = (await file.json()) as PersistedState;
        for (const c of state.clients ?? []) store.clients.set(c.client_id, c);
        for (const g of state.refreshGrants ?? []) if (g.expiresAt > now()) store.refreshGrants.set(g.hash, g);
      }
    }
    return store;
  }

  findAccess(token: string): AccessGrant | undefined {
    const grant = this.accessGrants.get(hashToken(token));
    return grant && grant.expiresAt > this.now() ? grant : undefined;
  }

  findRefresh(token: string): RefreshGrant | undefined {
    const grant = this.refreshGrants.get(hashToken(token));
    return grant && grant.expiresAt > this.now() ? grant : undefined;
  }

  /** Revokes every access and refresh token descending from one sign-in. */
  revokeFamily(family: string): void {
    for (const [hash, g] of this.refreshGrants) if (g.family === family) this.refreshGrants.delete(hash);
    for (const [hash, g] of this.accessGrants) if (g.family === family) this.accessGrants.delete(hash);
  }

  /** Drops expired entries; called before saving. */
  prune(): void {
    const now = this.now();
    for (const map of [this.refreshGrants, this.accessGrants, this.codes] as Map<string, { expiresAt: number }>[]) {
      for (const [key, value] of map) if (value.expiresAt <= now) map.delete(key);
    }
  }

  /** Writes the persisted part atomically; saves are serialized so the file never interleaves. */
  save(): Promise<void> {
    const file = this.file;
    if (!file) return Promise.resolve();
    this.prune();
    const state: PersistedState = { clients: [...this.clients.values()], refreshGrants: [...this.refreshGrants.values()] };
    this.saving = this.saving
      .catch(() => {})
      .then(async () => {
        const tmp = `${file}.tmp`;
        await Bun.write(tmp, JSON.stringify(state));
        await rename(tmp, file);
      });
    return this.saving;
  }
}
