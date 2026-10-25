// Obtains a 2FA device token so the MCP server can log in without an OTP code,
// and stores it as SYNO_DEVICE_ID in .env (the token is a credential: it is not printed).
// Usage: bun run device-token <6-digit code from your authenticator app>
import { createClientFromEnv } from "../src/bootstrap";

const otp = process.argv[2];
if (!otp || !/^\d{6}$/.test(otp)) {
  console.error("Usage: bun run device-token <6-digit OTP code>");
  process.exit(1);
}

const { client } = await createClientFromEnv(process.env, { deviceId: undefined, otp: undefined });
const deviceId = await client.loginWithOtp(otp);
await client.logout();

const envFile = Bun.file(`${process.cwd()}/.env`);
const current = (await envFile.exists()) ? await envFile.text() : "";
const line = `SYNO_DEVICE_ID=${deviceId}`;
const updated = /^SYNO_DEVICE_ID=.*$/m.test(current)
  ? current.replace(/^SYNO_DEVICE_ID=.*$/m, line)
  : `${current.replace(/\n?$/, "\n")}${line}\n`;
await Bun.write(envFile, updated);
console.log("✓ Device token saved as SYNO_DEVICE_ID in .env — the server no longer needs an OTP code.");
