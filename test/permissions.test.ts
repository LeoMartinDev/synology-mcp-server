import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePermissions, PermissionsFile } from "../src/permissions";

describe("parsePermissions", () => {
  test("missing parts are off", () => {
    const { domains, allowedUsers } = parsePermissions("files: rw\ncontainers: ro\n");
    expect(domains.files).toBe("rw");
    expect(domains.containers).toBe("ro");
    expect(domains.system).toBe("off");
    expect(allowedUsers).toBeUndefined();
  });

  test("reads allowed_users", () => {
    expect(parsePermissions("allowed_users: [leo, alice]").allowedUsers).toEqual(["leo", "alice"]);
  });

  test("rejects unknown parts and values, so a typo never goes unnoticed", () => {
    expect(() => parsePermissions("file: rw")).toThrow(/file/);
    expect(() => parsePermissions("files: write")).toThrow(/files/);
  });
});

describe("PermissionsFile", () => {
  const withDir = async (run: (dir: string) => Promise<void>) => {
    const dir = await mkdtemp(join(tmpdir(), "synology-mcp-perms-"));
    try {
      await run(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  test("creates a read-only file on first start", () =>
    withDir(async (dir) => {
      const file = new PermissionsFile(join(dir, "sub", "permissions.yml"));
      const { domains } = await file.open();
      expect(Object.values(domains).every((p) => p === "ro")).toBe(true);
      expect(await Bun.file(file.path).text()).toContain("allowed_users");
    }));

  test("picks up edits, and keeps the previous rights when an edit is broken", () =>
    withDir(async (dir) => {
      const path = join(dir, "permissions.yml");
      const touch = async (content: string, seconds: number) => {
        await Bun.write(path, content);
        await utimes(path, seconds, seconds); // distinct mtimes, whatever the filesystem's resolution
      };
      await touch("files: ro\n", 1000);
      const file = new PermissionsFile(path);
      expect((await file.open()).domains.files).toBe("ro");

      await touch("files: rw\n", 2000);
      expect((await file.load()).domains.files).toBe("rw");

      await touch("files: [oops\n", 3000);
      expect((await file.load()).domains.files).toBe("rw");
    }));

  test("refuses to start with an invalid file", () =>
    withDir(async (dir) => {
      const path = join(dir, "permissions.yml");
      await Bun.write(path, "files: everything\n");
      await expect(new PermissionsFile(path).open()).rejects.toThrow(/permissions.yml/);
    }));
});
