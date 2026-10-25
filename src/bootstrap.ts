import { type Config, loadConfig } from "./config";
import { resolveEnvCommands, runSecretCommand } from "./secrets";
import { type ClientOptions, SynologyClient } from "./synology/client";
import { totp } from "./totp";

/** Where fresh 2FA codes come from: a command (any password manager) or a locally held TOTP secret. */
function otpProvider(config: Config): ClientOptions["otp"] {
  const { otpCommand, totpSecret } = config;
  if (otpCommand) return () => runSecretCommand(otpCommand);
  if (totpSecret) return () => totp(totpSecret);
  return undefined;
}

/** Loads the configuration from the environment (running SYNO_*_COMMAND secrets) and builds the DSM client. */
export async function createClientFromEnv(
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<ClientOptions> = {},
): Promise<{ config: Config; client: SynologyClient }> {
  const config = loadConfig(await resolveEnvCommands(env));
  const client = new SynologyClient({ ...config, otp: otpProvider(config), ...overrides });
  return { config, client };
}
