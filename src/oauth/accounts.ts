import type { Permissions } from "../permissions";
import type { SynologyClient } from "../synology/client";
import { SynologyError } from "../synology/errors";

/** A sign-in refused for a reason the person signing in can act on; the message is shown to them. */
export class SignInError extends Error {
  /** Whether it counts as a failed attempt for rate limiting (a missing 2FA code does not). */
  constructor(
    message: string,
    readonly countsAsFailure = true,
  ) {
    super(message);
    this.name = "SignInError";
  }
}

const SIGN_IN_ERRORS: Record<number, string> = {
  400: "Identifiant ou mot de passe incorrect.",
  401: "Ce compte est désactivé.",
  402: "Ce compte n'a pas le droit de se connecter à DSM.",
  403: "Ce compte demande un code de validation en deux étapes.",
  404: "Code de validation en deux étapes incorrect.",
  406: "La validation en deux étapes est imposée à ce compte : configure-la dans DSM, puis réessaie.",
  407: "DSM bloque les connexions depuis cette adresse.",
  409: "Le mot de passe a expiré : change-le dans DSM.",
  410: "DSM demande de changer le mot de passe : fais-le dans DSM.",
};

interface UserInfo {
  users?: { name: string; expired?: string }[];
}

/**
 * Who may use the server: any active DSM account whose password (and 2FA code) DSM accepts, limited to the
 * permissions file's `allowed_users` when it has one. What they may do is the same for all: the file's rights.
 */
export class DsmAccounts {
  constructor(
    private readonly client: SynologyClient,
    /** The account the tools act with: it never signs in here, so failures cannot get DSM to lock it. */
    private readonly serviceAccount: string,
    private readonly permissions: () => Promise<Permissions>,
  ) {}

  /** Checks the credentials with DSM; returns the user's name as DSM spells it. */
  async signIn(account: string, password: string, otpCode?: string): Promise<string> {
    const name = account.trim();
    if (!name || !password) throw new SignInError("Renseigne ton identifiant et ton mot de passe.", false);
    if (name.toLowerCase() === this.serviceAccount.toLowerCase()) {
      throw new SignInError("Ce compte ne peut pas se connecter ici.", false);
    }
    try {
      await this.client.checkCredentials(name, password, otpCode?.trim());
    } catch (err) {
      if (!(err instanceof SynologyError) || err.api !== "SYNO.API.Auth") throw err;
      const message = SIGN_IN_ERRORS[err.code] ?? `DSM a refusé la connexion (code ${err.code}).`;
      throw new SignInError(message, err.code !== 403);
    }
    const access = await this.check(name);
    if ("refused" in access) throw new SignInError(access.refused, false);
    return access.user;
  }

  /**
   * Whether the user may (still) use the server: their DSM account is active and, if the permissions file
   * lists allowed users, they are on it. Called at sign-in and at every token refresh.
   */
  async check(user: string): Promise<{ user: string } | { refused: string }> {
    const { users } = await this.client.call<UserInfo>("SYNO.Core.User", "get", { name: user, additional: ["expired"] });
    const account = users?.[0];
    if (!account || !isActive(account.expired)) return { refused: "Ce compte DSM est désactivé ou expiré." };
    const { allowedUsers } = await this.permissions();
    if (allowedUsers && !allowedUsers.some((u) => u.toLowerCase() === account.name.toLowerCase())) {
      return { refused: "Ce compte n'est pas autorisé à utiliser ce serveur (allowed_users)." };
    }
    return { user: account.name };
  }
}

/** DSM reports `expired` as "normal", "now" (disabled) or the date the account expires, e.g. "2027/01/31". */
function isActive(expired: string | undefined): boolean {
  if (expired === "normal") return true;
  const date = expired ? Date.parse(expired.replaceAll("/", "-")) : Number.NaN;
  return !Number.isNaN(date) && date > Date.now();
}
