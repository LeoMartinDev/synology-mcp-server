import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { resolveEnvCommands, runSecretCommand } from "../src/secrets";
import { SynologyClient } from "../src/synology/client";
import { totp } from "../src/totp";
import { fakeNas, testConfig } from "./fake-nas";

describe("secret commands", () => {
  test("SYNO_<NAME>_COMMAND sets SYNO_<NAME>, except the per-login OTP command", async () => {
    const env = await resolveEnvCommands(
      {
        SYNO_USERNAME_COMMAND: "get username",
        SYNO_PASSWORD: "plain",
        SYNO_PASSWORD_COMMAND: "get password",
        SYNO_OTP_COMMAND: "get otp",
        OTHER_COMMAND: "ignored",
      },
      async (command) => `<${command}>`,
    );
    expect(env.SYNO_USERNAME).toBe("<get username>");
    expect(env.SYNO_PASSWORD).toBe("<get password>");
    expect(env.SYNO_OTP).toBeUndefined();
    expect(env.OTHER).toBeUndefined();
  });

  test("SYNO_<NAME>_FILE reads SYNO_<NAME> from a file (Docker secrets)", async () => {
    const path = `${import.meta.dir}/.secret-test-${process.pid}`;
    await Bun.write(path, "s3cret\n");
    try {
      const env = await resolveEnvCommands({ SYNO_PASSWORD_FILE: path, SYNO_PASSWORD: "plain" });
      expect(env.SYNO_PASSWORD).toBe("s3cret");
      await expect(resolveEnvCommands({ SYNO_PASSWORD_FILE: `${path}.missing` })).rejects.toThrow(/not found/);
    } finally {
      await Bun.file(path).delete();
    }
  });

  test("runs real shell commands and reports failures", async () => {
    expect(await runSecretCommand('echo "  s3cret value  "')).toBe("s3cret value");
    await expect(runSecretCommand("definitely-not-a-command-xyz")).rejects.toThrow(/Secret command failed/);
  });
});

describe("totp", () => {
  // RFC 6238 test vector: ASCII secret "12345678901234567890", SHA-1.
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  test("matches the RFC 6238 vectors", async () => {
    expect(await totp(secret, 59_000, 8)).toBe("94287082");
    expect(await totp(secret, 1_111_111_109_000, 8)).toBe("07081804");
    expect(await totp(secret, 59_000)).toBe("287082");
  });

  test("accepts otpauth URIs and lowercase secrets", async () => {
    const uri = `otpauth://totp/NAS:MCP?secret=${secret.toLowerCase()}&issuer=NAS`;
    expect(await totp(uri, 59_000)).toBe("287082");
  });

  test("invalid secrets are rejected by the configuration", () => {
    const base = { SYNO_URL: "https://nas:5001", SYNO_USERNAME: "a", SYNO_PASSWORD: "b" };
    expect(() => loadConfig({ ...base, SYNO_TOTP_SECRET: "not base32!" })).toThrow(/SYNO_TOTP_SECRET/);
    expect(loadConfig({ ...base, SYNO_TOTP_SECRET: secret }).totpSecret).toBe(secret);
  });
});

describe("2FA login with an OTP provider", () => {
  test("sends a fresh code once, then reuses the device token", async () => {
    let first = true;
    const nas = fakeNas({
      "SYNO.Core.Share.list": () => {
        if (first) {
          first = false;
          return { success: false, error: { code: 106 } };
        }
        return { success: true, data: {} };
      },
    });
    let codes = 0;
    const client = new SynologyClient({ ...testConfig(), otp: async () => `${++codes}`.padStart(6, "0") }, nas.fetchImpl);

    await client.call("SYNO.Core.Share", "list");
    expect(nas.logins).toBe(2);
    const [firstLogin, relogin] = nas.loginParams;
    expect(firstLogin!.get("otp_code")).toBe("000001");
    expect(firstLogin!.get("enable_device_token")).toBe("yes");
    expect(relogin!.get("otp_code")).toBeNull();
    expect(relogin!.get("device_id")).toBe("device-1");
    expect(codes).toBe(1);
  });

  test("skips the OTP when a device token is configured", async () => {
    const nas = fakeNas({ "SYNO.Core.Share.list": () => ({ success: true, data: {} }) });
    const client = new SynologyClient(
      {
        ...testConfig(),
        deviceId: "saved-device",
        otp: async () => {
          throw new Error("should not be asked");
        },
      },
      nas.fetchImpl,
    );
    await client.call("SYNO.Core.Share", "list");
    expect(nas.loginParams[0]!.get("device_id")).toBe("saved-device");
    expect(nas.loginParams[0]!.get("otp_code")).toBeNull();
  });
});
