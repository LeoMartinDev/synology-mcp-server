import { $ } from "bun";

/**
 * Runs a secret command (e.g. `op read "op://…"`, `bw get password …`, `pass show nas`)
 * through Bun's cross-platform shell and returns its trimmed output.
 */
export async function runSecretCommand(command: string): Promise<string> {
  const result = await $`${{ raw: command }}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    throw new Error(`Secret command failed (exit ${result.exitCode}): ${command}${stderr ? `\n${stderr}` : ""}`);
  }
  const value = result.stdout.toString().trim();
  if (!value) throw new Error(`Secret command printed nothing: ${command}`);
  return value;
}

const COMMAND_SUFFIX = "_COMMAND";
const FILE_SUFFIX = "_FILE";

/** SYNO_OTP_COMMAND runs at each login (codes expire), so it is not resolved up front. */
const PER_LOGIN_COMMANDS = new Set(["SYNO_OTP_COMMAND"]);

/** Reads a secret file (a Docker secret under /run/secrets…) and returns its trimmed content. */
export async function readSecretFile(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`Secret file not found: ${path}`);
  const value = (await file.text()).trim();
  if (!value) throw new Error(`Secret file is empty: ${path}`);
  return value;
}

/**
 * For every SYNO_<NAME>_COMMAND variable, runs the command and sets SYNO_<NAME> to its output;
 * for every SYNO_<NAME>_FILE variable, sets SYNO_<NAME> to the file's content.
 * Both take precedence over a plain SYNO_<NAME> value.
 */
export async function resolveEnvCommands(
  env: Record<string, string | undefined>,
  run: (command: string) => Promise<string> = runSecretCommand,
  read: (path: string) => Promise<string> = readSecretFile,
): Promise<Record<string, string | undefined>> {
  const resolved = { ...env };
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("SYNO_") || !value) continue;
    if (key.endsWith(COMMAND_SUFFIX) && !PER_LOGIN_COMMANDS.has(key)) {
      resolved[key.slice(0, -COMMAND_SUFFIX.length)] = await run(value);
    } else if (key.endsWith(FILE_SUFFIX)) {
      resolved[key.slice(0, -FILE_SUFFIX.length)] = await read(value);
    }
  }
  return resolved;
}
