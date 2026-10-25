import { join } from "node:path";
import { PermissionsFile } from "../permissions";
import { packageDataDir, synoOverrides } from "./main";
import { McpService } from "./service";
import { SettingsFile } from "./settings";

/**
 * `synology-mcp setup`, run by the package's postinst with the install wizard's answers (wizard_* variables).
 * Saves the service account. What it prints is shown at the end of the installation; an account DSM refuses
 * (or that needs a 2FA code, entered in the app: it would expire during the installation) does not fail it.
 */
export async function runSetup(env: Record<string, string | undefined> = process.env): Promise<void> {
  const username = env.wizard_username?.trim();
  const password = env.wizard_password;
  // Upgrades run without the wizard: the saved settings stay.
  if (!username || !password) return;

  const dataDir = packageDataDir(env);
  const settings = new SettingsFile(join(dataDir, "settings.json"));
  const service = new McpService({
    dataDir,
    settings,
    permissions: new PermissionsFile(join(dataDir, "permissions.yml")),
    env: synoOverrides(env),
  });
  try {
    const deviceId = await service.verifyAccount(username, password);
    await settings.update({ username, password, deviceId });
    console.log(
      `Compte ${username} vérifié. Ouvrez Synology MCP dans le menu principal de DSM pour choisir l'adresse publique et les droits.`,
    );
  } catch (err) {
    await settings.update({ username, password, deviceId: undefined });
    console.log(
      `Le compte ${username} n'a pas pu être vérifié : ${(err as Error).message} Ouvrez Synology MCP dans le menu principal de DSM pour le corriger.`,
    );
  }
}
